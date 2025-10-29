import {resolver} from '@rocicorp/resolver';
import {assert} from '../../../shared/src/asserts.ts';
import type {ReadonlyJSONValue} from '../../../shared/src/json.ts';
import type {Writable} from '../../../shared/src/writable.ts';
import {
  SUBQ_PREFIX,
  type AST,
  type CompoundKey,
  type Condition,
  type Ordering,
  type Parameter,
  type SimpleOperator,
  type System,
} from '../../../zero-protocol/src/ast.ts';
import type {ErroredQuery} from '../../../zero-protocol/src/custom-queries.ts';
import type {Row as IVMRow} from '../../../zero-protocol/src/data.ts';
import {
  hashOfAST,
  hashOfNameAndArgs,
} from '../../../zero-protocol/src/query-hash.ts';
import type {Schema, TableSchema} from '../../../zero-types/src/schema.ts';
import {buildPipeline} from '../builder/builder.ts';
import {NotImplementedError} from '../error.ts';
import {ArrayView} from '../ivm/array-view.ts';
import {defaultFormat} from '../ivm/default-format.ts';
import type {Input} from '../ivm/operator.ts';
import type {Format, ViewFactory} from '../ivm/view.ts';
import {
  and,
  cmp,
  ExpressionBuilder,
  simplifyCondition,
  type ExpressionFactory,
} from './expression.ts';
import type {CustomQueryID} from './named.ts';
import type {GotCallback, QueryDelegate} from './query-delegate.ts';
import {queryInternalsTag, type QueryInternals} from './query-internals.ts';
import {
  type AnyQuery,
  type ExistsOptions,
  type GetFilterType,
  type HumanReadable,
  type MaterializeOptions,
  type PreloadOptions,
  type PullRow,
  type Query,
  type RunOptions,
} from './query.ts';
import {DEFAULT_PRELOAD_TTL_MS, DEFAULT_TTL_MS, type TTL} from './ttl.ts';
import type {TypedView} from './typed-view.ts';

export function newQuery<
  TSchema extends Schema,
  TTable extends keyof TSchema['tables'] & string,
  TReturn = PullRow<TTable, TSchema>,
  TContext = unknown,
>(schema: TSchema, table: TTable): Query<TSchema, TTable, TReturn, TContext> {
  return new QueryImpl(schema, table, {table}, defaultFormat, undefined);
}

export function staticParam(
  anchorClass: 'authData' | 'preMutationRow',
  field: string | string[],
): Parameter {
  return {
    type: 'static',
    anchor: anchorClass,
    // for backwards compatibility
    field: field.length === 1 ? field[0] : field,
  };
}

// oxlint-disable-next-line no-explicit-any
type GetFilterTypeAny = GetFilterType<any, any, any>;

type NewQueryFunction<TSchema extends Schema, TContext> = <
  TTable extends keyof TSchema['tables'] & string,
  TReturn,
>(
  this: unknown,
  tableName: TTable,
  ast: AST,
  format: Format,
  customQueryID: CustomQueryID | undefined,
  currentJunction: string | undefined,
) => Query<TSchema, TTable, TReturn, TContext>;

export abstract class AbstractQuery<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn = PullRow<TTable, TSchema>,
    TContext = unknown,
  >
  implements
    Query<TSchema, TTable, TReturn, TContext>,
    QueryInternals<TSchema, TTable, TReturn, TContext>
{
  readonly [queryInternalsTag] = true;

  readonly #schema: TSchema;
  readonly #tableName: TTable;
  readonly #ast: AST;
  readonly format: Format;
  #hash: string = '';
  readonly #system: System;
  readonly #currentJunction: string | undefined;
  readonly customQueryID: CustomQueryID | undefined;
  readonly #newQuery: NewQueryFunction<TSchema, TContext>;

  constructor(
    schema: TSchema,
    tableName: TTable,
    ast: AST,
    format: Format,
    system: System,
    customQueryID: CustomQueryID | undefined,
    currentJunction: string | undefined,
    newQuery: NewQueryFunction<TSchema, TContext>,
  ) {
    this.#schema = schema;
    this.#tableName = tableName;
    this.#ast = ast;
    this.format = format;
    this.#system = system;
    this.#currentJunction = currentJunction;
    this.customQueryID = customQueryID;
    this.#newQuery = newQuery;
  }

  withContext(
    _ctx: TContext,
  ): QueryInternals<TSchema, TTable, TReturn, TContext> {
    return this as QueryInternals<TSchema, TTable, TReturn, TContext>;
  }

  nameAndArgs(
    name: string,
    args: ReadonlyArray<ReadonlyJSONValue>,
  ): Query<TSchema, TTable, TReturn, TContext> {
    return this.#newQuery(
      this.#tableName,
      this.#ast,
      this.format,
      {
        name,
        args,
      },
      this.#currentJunction,
    );
  }

  hash(): string {
    if (!this.#hash) {
      this.#hash = hashOfAST(this.#completeAst());
    }
    return this.#hash;
  }

  one = (): Query<TSchema, TTable, TReturn | undefined, TContext> =>
    this.#newQuery(
      this.#tableName,
      {
        ...this.#ast,
        limit: 1,
      },
      {
        ...this.format,
        singular: true,
      },
      this.customQueryID,
      this.#currentJunction,
    );

  whereExists = (
    relationship: string,
    cbOrOptions?: ((q: AnyQuery) => AnyQuery) | ExistsOptions,
    options?: ExistsOptions,
  ): Query<TSchema, TTable, TReturn, TContext> => {
    const cb = typeof cbOrOptions === 'function' ? cbOrOptions : undefined;
    const opts = typeof cbOrOptions === 'function' ? options : cbOrOptions;
    const flipped = opts?.flip ?? false;
    return this.where(({exists}) => exists(relationship, cb, {flip: flipped}));
  };

  related = (
    relationship: string,
    cb?: (q: AnyQuery) => AnyQuery,
    // oxlint-disable-next-line no-explicit-any
  ): Query<Schema, string, any, TContext> => {
    if (relationship.startsWith(SUBQ_PREFIX)) {
      throw new Error(
        `Relationship names may not start with "${SUBQ_PREFIX}". That is a reserved prefix.`,
      );
    }
    cb = cb ?? (q => q);

    const related = this.#schema.relationships[this.#tableName][relationship];
    assert(related, 'Invalid relationship');
    if (isOneHop(related)) {
      const {destSchema, destField, sourceField, cardinality} = related[0];
      const q: AnyQuery = this.#newQuery(
        destSchema,
        {
          table: destSchema,
          alias: relationship,
        },
        {
          relationships: {},
          singular: cardinality === 'one',
        },
        this.customQueryID,
        undefined,
      ) as AnyQuery;
      // Intentionally not setting to `one` as it is a perf degradation
      // and the user should not be making the mistake of setting cardinality to
      // `one` when it is actually not.
      // if (cardinality === 'one') {
      //   q = q.one();
      // }
      const subQuery = asAbstractQuery(cb(q));
      assert(
        isCompoundKey(sourceField),
        'The source of a relationship must specify at last 1 field',
      );
      assert(
        isCompoundKey(destField),
        'The destination of a relationship must specify at last 1 field',
      );
      assert(
        sourceField.length === destField.length,
        'The source and destination of a relationship must have the same number of fields',
      );

      return this.#newQuery(
        this.#tableName,
        {
          ...this.#ast,
          related: [
            ...(this.#ast.related ?? []),
            {
              system: this.#system,
              correlation: {
                parentField: sourceField,
                childField: destField,
              },
              subquery: addPrimaryKeysToAst(
                this.#schema.tables[destSchema],
                subQuery.#ast,
              ),
            },
          ],
        },
        {
          ...this.format,
          relationships: {
            ...this.format.relationships,
            [relationship]: subQuery.format,
          },
        },
        this.customQueryID,
        this.#currentJunction,
      ) as AnyQuery;
    }

    if (isTwoHop(related)) {
      const [firstRelation, secondRelation] = related;
      const {destSchema} = secondRelation;
      const junctionSchema = firstRelation.destSchema;
      const sq = asAbstractQuery(
        cb(
          this.#newQuery(
            destSchema,
            {
              table: destSchema,
              alias: relationship,
            },
            {
              relationships: {},
              singular: secondRelation.cardinality === 'one',
            },
            this.customQueryID,
            relationship,
          ),
        ),
      );

      assert(isCompoundKey(firstRelation.sourceField), 'Invalid relationship');
      assert(isCompoundKey(firstRelation.destField), 'Invalid relationship');
      assert(isCompoundKey(secondRelation.sourceField), 'Invalid relationship');
      assert(isCompoundKey(secondRelation.destField), 'Invalid relationship');

      return this.#newQuery(
        this.#tableName,
        {
          ...this.#ast,
          related: [
            ...(this.#ast.related ?? []),
            {
              system: this.#system,
              correlation: {
                parentField: firstRelation.sourceField,
                childField: firstRelation.destField,
              },
              hidden: true,
              subquery: {
                table: junctionSchema,
                alias: relationship,
                orderBy: addPrimaryKeys(
                  this.#schema.tables[junctionSchema],
                  undefined,
                ),
                related: [
                  {
                    system: this.#system,
                    correlation: {
                      parentField: secondRelation.sourceField,
                      childField: secondRelation.destField,
                    },
                    subquery: addPrimaryKeysToAst(
                      this.#schema.tables[destSchema],
                      sq.#ast,
                    ),
                  },
                ],
              },
            },
          ],
        },
        {
          ...this.format,
          relationships: {
            ...this.format.relationships,
            [relationship]: sq.format,
          },
        },
        this.customQueryID,
        this.#currentJunction,
      ) as AnyQuery;
    }

    throw new Error(`Invalid relationship ${relationship}`);
  };

  where = (
    fieldOrExpressionFactory: string | ExpressionFactory<TSchema, TTable>,
    opOrValue?: SimpleOperator | GetFilterTypeAny | Parameter,
    value?: GetFilterTypeAny | Parameter,
  ): Query<TSchema, TTable, TReturn, TContext> => {
    let cond: Condition;

    if (typeof fieldOrExpressionFactory === 'function') {
      cond = fieldOrExpressionFactory(
        new ExpressionBuilder(this._exists) as ExpressionBuilder<
          TSchema,
          TTable
        >,
      );
    } else {
      assert(opOrValue !== undefined, 'Invalid condition');
      cond = cmp(fieldOrExpressionFactory, opOrValue, value);
    }

    const existingWhere = this.#ast.where;
    if (existingWhere) {
      cond = and(existingWhere, cond);
    }

    const where = simplifyCondition(cond);

    return this.#newQuery(
      this.#tableName,
      {
        ...this.#ast,
        where,
      },
      this.format,
      this.customQueryID,
      this.#currentJunction,
    );
  };

  start = (
    row: Partial<PullRow<TTable, TSchema>>,
    opts?: {inclusive: boolean},
  ): Query<TSchema, TTable, TReturn, TContext> =>
    this.#newQuery(
      this.#tableName,
      {
        ...this.#ast,
        start: {
          row,
          exclusive: !opts?.inclusive,
        },
      },
      this.format,
      this.customQueryID,
      this.#currentJunction,
    );

  limit = (limit: number): Query<TSchema, TTable, TReturn, TContext> => {
    if (limit < 0) {
      throw new Error('Limit must be non-negative');
    }
    if ((limit | 0) !== limit) {
      throw new Error('Limit must be an integer');
    }
    if (this.#currentJunction) {
      throw new NotImplementedError(
        'Limit is not supported in junction relationships yet. Junction relationship being limited: ' +
          this.#currentJunction,
      );
    }

    return this.#newQuery(
      this.#tableName,
      {
        ...this.#ast,
        limit,
      },
      this.format,
      this.customQueryID,
      this.#currentJunction,
    );
  };

  orderBy = <TSelector extends keyof TSchema['tables'][TTable]['columns']>(
    field: TSelector,
    direction: 'asc' | 'desc',
  ): Query<TSchema, TTable, TReturn, TContext> => {
    if (this.#currentJunction) {
      throw new NotImplementedError(
        'Order by is not supported in junction relationships yet. Junction relationship being ordered: ' +
          this.#currentJunction,
      );
    }
    return this.#newQuery(
      this.#tableName,
      {
        ...this.#ast,
        orderBy: [...(this.#ast.orderBy ?? []), [field as string, direction]],
      },
      this.format,
      this.customQueryID,
      this.#currentJunction,
    );
  };

  protected _exists = (
    relationship: string,
    cb: ((query: AnyQuery) => AnyQuery) | undefined,
    options?: ExistsOptions,
  ): Condition => {
    cb = cb ?? (q => q);
    const flip = options?.flip ?? false;
    const related = this.#schema.relationships[this.#tableName][relationship];
    assert(related, 'Invalid relationship');

    if (isOneHop(related)) {
      const {destSchema: destTableName, sourceField, destField} = related[0];
      assert(isCompoundKey(sourceField), 'Invalid relationship');
      assert(isCompoundKey(destField), 'Invalid relationship');

      const subQuery = asAbstractQuery(
        cb(
          this.#newQuery(
            destTableName,
            {
              table: destTableName,
              alias: `${SUBQ_PREFIX}${relationship}`,
            },
            defaultFormat,
            this.customQueryID,
            undefined,
          ),
        ),
      );
      return {
        type: 'correlatedSubquery',
        related: {
          system: this.#system,
          correlation: {
            parentField: sourceField,
            childField: destField,
          },
          subquery: addPrimaryKeysToAst(
            this.#schema.tables[destTableName],
            subQuery.#ast,
          ),
        },
        op: 'EXISTS',
        flip,
      };
    }

    if (isTwoHop(related)) {
      const [firstRelation, secondRelation] = related;
      assert(isCompoundKey(firstRelation.sourceField), 'Invalid relationship');
      assert(isCompoundKey(firstRelation.destField), 'Invalid relationship');
      assert(isCompoundKey(secondRelation.sourceField), 'Invalid relationship');
      assert(isCompoundKey(secondRelation.destField), 'Invalid relationship');
      const {destSchema} = secondRelation;
      const junctionSchema = firstRelation.destSchema;
      const queryToDest = cb(
        this.#newQuery(
          destSchema,
          {
            table: destSchema,
            alias: `${SUBQ_PREFIX}zhidden_${relationship}`,
          },
          defaultFormat,
          this.customQueryID,
          relationship,
        ) as AnyQuery,
      );

      return {
        type: 'correlatedSubquery',
        related: {
          system: this.#system,
          correlation: {
            parentField: firstRelation.sourceField,
            childField: firstRelation.destField,
          },
          subquery: {
            table: junctionSchema,
            alias: `${SUBQ_PREFIX}${relationship}`,
            orderBy: addPrimaryKeys(
              this.#schema.tables[junctionSchema],
              undefined,
            ),
            where: {
              type: 'correlatedSubquery',
              related: {
                system: this.#system,
                correlation: {
                  parentField: secondRelation.sourceField,
                  childField: secondRelation.destField,
                },

                subquery: addPrimaryKeysToAst(
                  this.#schema.tables[destSchema],
                  (queryToDest as QueryImpl<Schema, string, unknown, unknown>)
                    .#ast,
                ),
              },
              op: 'EXISTS',
              flip,
            },
          },
        },
        op: 'EXISTS',
        flip,
      };
    }

    throw new Error(`Invalid relationship ${relationship}`);
  };

  #completedAST: AST | undefined;

  get ast(): AST {
    return this.#completeAst();
  }

  #completeAst(): AST {
    if (!this.#completedAST) {
      const finalOrderBy = addPrimaryKeys(
        this.#schema.tables[this.#tableName],
        this.#ast.orderBy,
      );
      if (this.#ast.start) {
        const {row} = this.#ast.start;
        const narrowedRow: Writable<IVMRow> = {};
        for (const [field] of finalOrderBy) {
          narrowedRow[field] = row[field];
        }
        this.#completedAST = {
          ...this.#ast,
          start: {
            ...this.#ast.start,
            row: narrowedRow,
          },
          orderBy: finalOrderBy,
        };
      } else {
        this.#completedAST = {
          ...this.#ast,
          orderBy: addPrimaryKeys(
            this.#schema.tables[this.#tableName],
            this.#ast.orderBy,
          ),
        };
      }
    }
    return this.#completedAST;
  }
}

function asAbstractQuery<
  TSchema extends Schema,
  TTable extends keyof TSchema['tables'] & string,
  TReturn,
  TContext,
>(
  q: Query<TSchema, TTable, TReturn, TContext>,
): AbstractQuery<TSchema, TTable, TReturn, TContext> {
  assert(q instanceof AbstractQuery);
  return q;
}

export function materializeImpl<
  TSchema extends Schema,
  TTable extends keyof TSchema['tables'] & string,
  TReturn,
  TContext,
  T,
>(
  query: Query<TSchema, TTable, TReturn, TContext>,
  delegate: QueryDelegate<TContext>,
  factory: ViewFactory<
    TSchema,
    TTable,
    TReturn,
    TContext,
    T
    // oxlint-disable-next-line no-explicit-any
  > = arrayViewFactory as any,
  options?: MaterializeOptions,
): T {
  let ttl: TTL = options?.ttl ?? DEFAULT_TTL_MS;

  const qi = delegate.withContext(query);
  const {ast: ast, format, customQueryID} = qi;
  const queryHash = qi.hash();

  const queryID = customQueryID
    ? hashOfNameAndArgs(customQueryID.name, customQueryID.args)
    : queryHash;
  const queryCompleteResolver = resolver<true>();
  let queryComplete: boolean | ErroredQuery = delegate.defaultQueryComplete;
  const updateTTL = customQueryID
    ? (newTTL: TTL) => delegate.updateCustomQuery(customQueryID, newTTL)
    : (newTTL: TTL) => delegate.updateServerQuery(ast, newTTL);

  const gotCallback: GotCallback = (got, error) => {
    if (error) {
      queryCompleteResolver.reject(error);
      queryComplete = error;
      return;
    }

    if (got) {
      delegate.addMetric(
        'query-materialization-end-to-end',
        performance.now() - t0,
        queryID,
        ast,
      );
      queryComplete = true;
      queryCompleteResolver.resolve(true);
    }
  };

  let removeCommitObserver: (() => void) | undefined;
  const onDestroy = () => {
    input.destroy();
    removeCommitObserver?.();
    removeAddedQuery();
  };

  const t0 = performance.now();

  const removeAddedQuery = customQueryID
    ? delegate.addCustomQuery(ast, customQueryID, ttl, gotCallback)
    : delegate.addServerQuery(ast, ttl, gotCallback);

  const input = buildPipeline(ast, delegate, queryID);

  const view = delegate.batchViewUpdates(() =>
    (factory ?? arrayViewFactory)(
      query,
      input,
      format,
      onDestroy,
      cb => {
        removeCommitObserver = delegate.onTransactionCommit(cb);
      },
      queryComplete || queryCompleteResolver.promise,
      updateTTL,
    ),
  );

  delegate.addMetric(
    'query-materialization-client',
    performance.now() - t0,
    queryID,
  );

  return view as T;
}

// oxlint-disable-next-line require-await
export async function runImpl<
  TSchema extends Schema,
  TTable extends keyof TSchema['tables'] & string,
  TReturn,
  TContext,
>(
  query: Query<TSchema, TTable, TReturn, TContext>,
  delegate: QueryDelegate<TContext>,
  options?: RunOptions,
): Promise<HumanReadable<TReturn>> {
  delegate.assertValidRunOptions(options);
  const v: TypedView<HumanReadable<TReturn>> = materializeImpl(
    query,
    delegate,
    undefined,
    {
      ttl: options?.ttl,
    },
  );
  if (options?.type === 'complete') {
    return new Promise(resolve => {
      v.addListener((data, type) => {
        if (type === 'complete') {
          v.destroy();
          resolve(data as HumanReadable<TReturn>);
        } else if (type === 'error') {
          v.destroy();
          resolve(Promise.reject(data));
        }
      });
    });
  }

  options?.type satisfies 'unknown' | undefined;

  const ret = v.data;
  v.destroy();
  return ret;
}

export function preloadImpl<
  TSchema extends Schema,
  TTable extends keyof TSchema['tables'] & string,
  TReturn,
  TContext,
>(
  query: Query<TSchema, TTable, TReturn, TContext>,
  delegate: QueryDelegate<TContext>,
  options?: PreloadOptions,
): {
  cleanup: () => void;
  complete: Promise<void>;
} {
  const qi = delegate.withContext(query);
  const ttl = options?.ttl ?? DEFAULT_PRELOAD_TTL_MS;
  const {resolve, promise: complete} = resolver<void>();
  const {customQueryID, ast: ast} = qi;
  if (customQueryID) {
    const cleanup = delegate.addCustomQuery(ast, customQueryID, ttl, got => {
      if (got) {
        resolve();
      }
    });
    return {
      cleanup,
      complete,
    };
  }

  const cleanup = delegate.addServerQuery(ast, ttl, got => {
    if (got) {
      resolve();
    }
  });
  return {
    cleanup,
    complete,
  };
}

export class QueryImpl<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn = PullRow<TTable, TSchema>,
    TContext = unknown,
  >
  extends AbstractQuery<TSchema, TTable, TReturn, TContext>
  implements Query<TSchema, TTable, TReturn, TContext>
{
  constructor(
    schema: TSchema,
    tableName: TTable,
    ast: AST = {table: tableName},
    format: Format = defaultFormat,
    system: System = 'client',
    customQueryID?: CustomQueryID,
    currentJunction?: string,
  ) {
    super(
      schema,
      tableName,
      ast,
      format,
      system,
      customQueryID,
      currentJunction,
      (tableName, ast, format, customQueryID, currentJunction) =>
        new QueryImpl(
          schema,
          tableName,
          ast,
          format,
          system,
          customQueryID,
          currentJunction,
        ),
    );
  }
}

function addPrimaryKeys(
  schema: TableSchema,
  orderBy: Ordering | undefined,
): Ordering {
  orderBy = orderBy ?? [];
  const {primaryKey} = schema;
  const primaryKeysToAdd = new Set(primaryKey);

  for (const [field] of orderBy) {
    primaryKeysToAdd.delete(field);
  }

  if (primaryKeysToAdd.size === 0) {
    return orderBy;
  }

  return [
    ...orderBy,
    ...[...primaryKeysToAdd].map(key => [key, 'asc'] as [string, 'asc']),
  ];
}

function addPrimaryKeysToAst(schema: TableSchema, ast: AST): AST {
  return {
    ...ast,
    orderBy: addPrimaryKeys(schema, ast.orderBy),
  };
}

function arrayViewFactory<
  TSchema extends Schema,
  TTable extends string,
  TReturn,
  TContext,
>(
  _query: QueryInternals<TSchema, TTable, TReturn, TContext>,
  input: Input,
  format: Format,
  onDestroy: () => void,
  onTransactionCommit: (cb: () => void) => void,
  queryComplete: true | ErroredQuery | Promise<true>,
  updateTTL: (ttl: TTL) => void,
): TypedView<HumanReadable<TReturn>> {
  const v = new ArrayView<HumanReadable<TReturn>>(
    input,
    format,
    queryComplete,
    updateTTL,
  );
  v.onDestroy = onDestroy;
  onTransactionCommit(() => {
    v.flush();
  });
  return v;
}

function isCompoundKey(field: readonly string[]): field is CompoundKey {
  return Array.isArray(field) && field.length >= 1;
}

function isOneHop<T>(r: readonly T[]): r is readonly [T] {
  return r.length === 1;
}

function isTwoHop<T>(r: readonly T[]): r is readonly [T, T] {
  return r.length === 2;
}
