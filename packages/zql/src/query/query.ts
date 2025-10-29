/* oxlint-disable @typescript-eslint/no-explicit-any */
import type {Expand, ExpandRecursive} from '../../../shared/src/expand.ts';
import {type SimpleOperator} from '../../../zero-protocol/src/ast.ts';
import type {
  Schema,
  Schema as ZeroSchema,
  LastInTuple,
  TableSchema,
} from '../../../zero-types/src/schema.ts';
import type {
  SchemaValueToTSType,
  SchemaValueWithCustomType,
} from '../../../zero-types/src/schema-value.ts';
import type {ExpressionFactory, ParameterReference} from './expression.ts';
import type {TTL} from './ttl.ts';

type Selector<E extends TableSchema> = keyof E['columns'];

export type NoCompoundTypeSelector<T extends TableSchema> = Exclude<
  Selector<T>,
  JsonSelectors<T> | ArraySelectors<T>
>;

type JsonSelectors<E extends TableSchema> = {
  [K in keyof E['columns']]: E['columns'][K] extends {type: 'json'} ? K : never;
}[keyof E['columns']];

type ArraySelectors<E extends TableSchema> = {
  [K in keyof E['columns']]: E['columns'][K] extends SchemaValueWithCustomType<
    any[]
  >
    ? K
    : never;
}[keyof E['columns']];

export type QueryReturn<Q> =
  Q extends Query<any, any, infer R, any> ? R : never;

export type QueryTable<Q> = Q extends Query<any, infer T, any> ? T : never;

export type ExistsOptions = {flip: boolean};

export type GetFilterType<
  TSchema extends TableSchema,
  TColumn extends keyof TSchema['columns'],
  TOperator extends SimpleOperator,
> = TOperator extends 'IS' | 'IS NOT'
  ? // SchemaValueToTSType adds null if the type is optional, but we add null
    // no matter what for dx reasons. See:
    // https://github.com/rocicorp/mono/pull/3576#discussion_r1925792608
    SchemaValueToTSType<TSchema['columns'][TColumn]> | null
  : TOperator extends 'IN' | 'NOT IN'
    ? // We don't want to compare to null in where clauses because it causes
      // confusing results:
      // https://zero.rocicorp.dev/docs/reading-data#comparing-to-null
      readonly Exclude<SchemaValueToTSType<TSchema['columns'][TColumn]>, null>[]
    : Exclude<SchemaValueToTSType<TSchema['columns'][TColumn]>, null>;

export type AvailableRelationships<
  TTable extends string,
  TSchema extends ZeroSchema,
> = keyof TSchema['relationships'][TTable] & string;

export type DestTableName<
  TTable extends string,
  TSchema extends ZeroSchema,
  TRelationship extends string,
> = LastInTuple<TSchema['relationships'][TTable][TRelationship]>['destSchema'];

type DestRow<
  TTable extends string,
  TSchema extends ZeroSchema,
  TRelationship extends string,
> = TSchema['relationships'][TTable][TRelationship][0]['cardinality'] extends 'many'
  ? PullRow<DestTableName<TTable, TSchema, TRelationship>, TSchema>
  : PullRow<DestTableName<TTable, TSchema, TRelationship>, TSchema> | undefined;

type AddSubreturn<TExistingReturn, TSubselectReturn, TAs extends string> = {
  readonly [K in TAs]: undefined extends TSubselectReturn
    ? TSubselectReturn
    : readonly TSubselectReturn[];
} extends infer TNewRelationship
  ? undefined extends TExistingReturn
    ? (Exclude<TExistingReturn, undefined> & TNewRelationship) | undefined
    : TExistingReturn & TNewRelationship
  : never;

export type PullTableSchema<
  TTable extends string,
  TSchemas extends ZeroSchema,
> = TSchemas['tables'][TTable];

export type PullRow<TTable extends string, TSchema extends ZeroSchema> = {
  readonly [K in keyof PullTableSchema<
    TTable,
    TSchema
  >['columns']]: SchemaValueToTSType<
    PullTableSchema<TTable, TSchema>['columns'][K]
  >;
} & {};

export type Row<
  T extends
    | TableSchema
    | Query<ZeroSchema, string, any>
    | ((...args: any) => Query<ZeroSchema, string, any>),
> = T extends TableSchema
  ? {
      readonly [K in keyof T['columns']]: SchemaValueToTSType<T['columns'][K]>;
    }
  : T extends
        | Query<ZeroSchema, string, any>
        | ((...args: any) => Query<ZeroSchema, string, any>)
    ? QueryRowType<T>
    : never;

export type QueryRowType<Q> = Q extends (
  ...args: any
) => Query<any, any, infer R>
  ? R
  : Q extends Query<any, any, infer R>
    ? R
    : never;

export type ZeRow<Q> = QueryRowType<Q>;

export type QueryResultType<Q> = Q extends
  | Query<ZeroSchema, string, any>
  | ((...args: any) => Query<ZeroSchema, string, any>)
  ? HumanReadable<QueryRowType<Q>>
  : never;

/**
 * A hybrid query that runs on both client and server.
 * Results are returned immediately from the client followed by authoritative
 * results from the server.
 *
 * Queries are transactional in that all queries update at once when a new transaction
 * has been committed on the client or server. No query results will reflect stale state.
 *
 * Queries are executed through the Zero instance methods:
 * - `zero.run(query)` - Execute once and return results
 * - `zero.materialize(query)` - Create a live view that updates automatically
 * - `zero.preload(query)` - Preload data into the cache
 *
 * The normal way to use a query is through your UI framework's bindings (e.g., `useQuery(query)`)
 * or within a custom mutator.
 *
 * Example:
 *
 * ```ts
 * const query = z.query.issue.where('status', 'open').limit(10);
 * const result = await z.run(query);
 * ```
 *
 * For more information on how to use queries, see the documentation:
 * https://zero.rocicorp.dev/docs/reading-data
 *
 * @typeParam TSchema The database schema type extending ZeroSchema
 * @typeParam TTable The name of the table being queried, must be a key of TSchema['tables']
 * @typeParam TReturn The return type of the query, defaults to PullRow<TTable, TSchema>
 * @typeParam TContext The context type required for named queries, defaults to unknown
 */
export interface Query<
  TSchema extends ZeroSchema,
  TTable extends keyof TSchema['tables'] & string,
  TReturn = PullRow<TTable, TSchema>,
  TContext = unknown,
> {
  related<TRelationship extends AvailableRelationships<TTable, TSchema>>(
    relationship: TRelationship,
  ): Query<
    TSchema,
    TTable,
    AddSubreturn<
      TReturn,
      DestRow<TTable, TSchema, TRelationship>,
      TRelationship
    >,
    TContext
  >;
  related<
    TRelationship extends AvailableRelationships<TTable, TSchema>,
    TSub extends Query<TSchema, string, any>,
  >(
    relationship: TRelationship,
    cb: (
      q: Query<
        TSchema,
        DestTableName<TTable, TSchema, TRelationship>,
        DestRow<TTable, TSchema, TRelationship>
      >,
    ) => TSub,
  ): Query<
    TSchema,
    TTable,
    AddSubreturn<
      TReturn,
      TSub extends Query<TSchema, string, infer TSubReturn>
        ? TSubReturn
        : never,
      TRelationship
    >,
    TContext
  >;

  where<
    TSelector extends NoCompoundTypeSelector<PullTableSchema<TTable, TSchema>>,
    TOperator extends SimpleOperator,
  >(
    field: TSelector,
    op: TOperator,
    value:
      | GetFilterType<PullTableSchema<TTable, TSchema>, TSelector, TOperator>
      | ParameterReference,
  ): Query<TSchema, TTable, TReturn, TContext>;
  where<
    TSelector extends NoCompoundTypeSelector<PullTableSchema<TTable, TSchema>>,
  >(
    field: TSelector,
    value:
      | GetFilterType<PullTableSchema<TTable, TSchema>, TSelector, '='>
      | ParameterReference,
  ): Query<TSchema, TTable, TReturn, TContext>;
  where(
    expressionFactory: ExpressionFactory<TSchema, TTable>,
  ): Query<TSchema, TTable, TReturn, TContext>;

  whereExists(
    relationship: AvailableRelationships<TTable, TSchema>,
    options?: ExistsOptions,
  ): Query<TSchema, TTable, TReturn, TContext>;
  whereExists<TRelationship extends AvailableRelationships<TTable, TSchema>>(
    relationship: TRelationship,
    cb: (
      q: Query<TSchema, DestTableName<TTable, TSchema, TRelationship>>,
    ) => Query<TSchema, string>,
    options?: ExistsOptions,
  ): Query<TSchema, TTable, TReturn, TContext>;

  start(
    row: Partial<PullRow<TTable, TSchema>>,
    opts?: {inclusive: boolean},
  ): Query<TSchema, TTable, TReturn, TContext>;

  limit(limit: number): Query<TSchema, TTable, TReturn, TContext>;

  orderBy<TSelector extends Selector<PullTableSchema<TTable, TSchema>>>(
    field: TSelector,
    direction: 'asc' | 'desc',
  ): Query<TSchema, TTable, TReturn, TContext>;

  one(): Query<TSchema, TTable, TReturn | undefined, TContext>;
}

export type PreloadOptions = {
  /**
   * Time To Live. This is the amount of time to keep the rows associated with
   * this query after {@linkcode cleanup} has been called.
   */
  ttl?: TTL | undefined;
};

export type MaterializeOptions = PreloadOptions;

/**
 * A helper type that tries to make the type more readable.
 */
export type HumanReadable<T> = undefined extends T ? Expand<T> : Expand<T>[];

/**
 * A helper type that tries to make the type more readable.
 */
// Note: opaque types expand incorrectly.
export type HumanReadableRecursive<T> = undefined extends T
  ? ExpandRecursive<T>
  : ExpandRecursive<T>[];

/**
 * The kind of results we want to wait for when using {@linkcode run} on {@linkcode Query}.
 *
 * `unknown` means we don't want to wait for the server to return results. The result is a
 * snapshot of the data at the time the query was run.
 *
 * `complete` means we want to ensure that we have the latest result from the server. The
 * result is a complete and up-to-date view of the data. In some cases this means that we
 * have to wait for the server to return results. To ensure that we have the result for
 * this query you can preload it before calling run. See {@link preload}.
 *
 * By default, `run` uses `{type: 'unknown'}` to avoid waiting for the server.
 *
 * The `ttl` option is used to specify the time to live for the query. This is the amount of
 * time to keep the rows associated with this query after the promise has resolved.
 */
export type RunOptions = {
  type: 'unknown' | 'complete';
  ttl?: TTL | undefined;
};

export const DEFAULT_RUN_OPTIONS_UNKNOWN = {
  type: 'unknown',
} as const;

export const DEFAULT_RUN_OPTIONS_COMPLETE = {
  type: 'complete',
} as const;

export type AnyQuery = Query<Schema, string, any, any>;
