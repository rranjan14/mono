import {
  WriteTransactionImpl,
  zeroData,
} from '../../../replicache/src/transactions.ts';
import {assert} from '../../../shared/src/asserts.ts';
import type {ReadonlyJSONValue} from '../../../shared/src/json.ts';
import {must} from '../../../shared/src/must.ts';
import {emptyFunction} from '../../../shared/src/sentinels.ts';
import type {MutationOk} from '../../../zero-protocol/src/push.ts';
import type {TableSchema} from '../../../zero-schema/src/table-schema.ts';
import type {Schema} from '../../../zero-types/src/schema.ts';
import type {
  ClientTransaction,
  DeleteID,
  InsertValue,
  SchemaCRUD,
  SchemaQuery,
  TableCRUD,
  Transaction,
  UpdateValue,
  UpsertValue,
} from '../../../zql/src/mutate/custom.ts';
import {newQuery} from '../../../zql/src/query/query-impl.ts';
import {
  type HumanReadable,
  type Query,
  type RunOptions,
} from '../../../zql/src/query/query.ts';
import type {ClientID} from '../types/client-state.ts';
import {ZeroContext} from './context.ts';
import {deleteImpl, insertImpl, updateImpl, upsertImpl} from './crud.ts';
import type {IVMSourceBranch} from './ivm-branch.ts';
import type {WriteTransaction} from './replicache-types.ts';
import type {ZeroLogContext} from './zero-log-context.ts';

/**
 * The shape which a user's custom mutator definitions must conform to.
 */
export type CustomMutatorDefs = {
  [namespaceOrKey: string]:
    | {
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any
        [key: string]: CustomMutatorImpl<any>;
      }
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    | CustomMutatorImpl<any>;
};

export type MutatorResult = {
  client: Promise<void>;
  server: Promise<MutationOk>;
};

export type CustomMutatorImpl<
  S extends Schema,
  TWrappedTransaction = unknown,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  TArgs = any,
> = (
  tx: Transaction<S, TWrappedTransaction>,
  // TODO: many args. See commit: 52657c2f934b4a458d628ea77e56ce92b61eb3c6 which did have many args.
  // The issue being that it will be a protocol change to support varargs.
  args: TArgs,
) => Promise<void>;

/**
 * The shape exposed on the `Zero.mutate` instance.
 * The signature of a custom mutator takes a `transaction` as its first arg
 * but the user does not provide this arg when calling the mutator.
 *
 * This utility strips the `tx` arg from the user's custom mutator signatures.
 */
export type MakeCustomMutatorInterfaces<
  S extends Schema,
  MD extends CustomMutatorDefs,
  TContext,
> = {
  readonly [NamespaceOrName in keyof MD]: MD[NamespaceOrName] extends (
    tx: Transaction<S>,
    ...args: infer Args
  ) => Promise<void>
    ? (...args: Args) => MutatorResult
    : {
        readonly [P in keyof MD[NamespaceOrName]]: MakeCustomMutatorInterface<
          S,
          MD[NamespaceOrName][P],
          TContext
        >;
      };
};

export type MakeCustomMutatorInterface<
  TSchema extends Schema,
  F,
  TContext,
> = F extends (
  tx: ClientTransaction<TSchema, TContext>,
  ...args: infer Args
) => Promise<void>
  ? (...args: Args) => MutatorResult
  : never;

export class TransactionImpl<TSchema extends Schema, TContext>
  implements ClientTransaction<TSchema, TContext>
{
  readonly location = 'client';
  readonly mutate: SchemaCRUD<TSchema>;
  readonly query: SchemaQuery<TSchema, TContext>;
  readonly #repTx: WriteTransaction;
  readonly #zeroContext: ZeroContext<TContext>;

  constructor(lc: ZeroLogContext, repTx: WriteTransaction, schema: TSchema) {
    must(repTx.reason === 'initial' || repTx.reason === 'rebase');
    const txData = must(
      (repTx as WriteTransactionImpl)[zeroData],
      'zero was not set on replicache internal options!',
    );

    this.#repTx = repTx;
    this.mutate = makeSchemaCRUD(
      schema,
      repTx,
      txData.ivmSources as IVMSourceBranch,
    );
    this.query = makeSchemaQuery(schema);

    this.#zeroContext = newZeroContext(
      lc,
      txData.ivmSources as IVMSourceBranch,
      txData.context as TContext,
    );
  }

  get clientID(): ClientID {
    return this.#repTx.clientID;
  }

  get mutationID(): number {
    return this.#repTx.mutationID;
  }

  get reason(): 'optimistic' | 'rebase' {
    return this.#repTx.reason === 'initial' ? 'optimistic' : 'rebase';
  }

  get token(): string | undefined {
    return (this.#repTx as WriteTransactionImpl)[zeroData]?.token;
  }

  run<TTable extends keyof TSchema['tables'] & string, TReturn, TContext>(
    query: Query<TSchema, TTable, TReturn, TContext>,
    options?: RunOptions,
  ): Promise<HumanReadable<TReturn>> {
    return this.#zeroContext.run(query, options);
  }
}

export function makeReplicacheMutator<S extends Schema, TWrappedTransaction>(
  lc: ZeroLogContext,
  mutator: CustomMutatorImpl<S, TWrappedTransaction>,
  schema: S,
) {
  return async (
    repTx: WriteTransaction,
    args: ReadonlyJSONValue,
  ): Promise<void> => {
    const tx = new TransactionImpl(lc, repTx, schema);
    await mutator(tx, args);
  };
}

function makeSchemaCRUD<S extends Schema>(
  schema: S,
  tx: WriteTransaction,
  ivmBranch: IVMSourceBranch,
) {
  // Only creates the CRUD mutators on demand
  // rather than creating them all up-front for each mutation.
  return new Proxy(
    {},
    {
      get(target: Record<string, TableCRUD<TableSchema>>, prop: string) {
        if (prop in target) {
          return target[prop];
        }

        target[prop] = makeTableCRUD(schema, prop, tx, ivmBranch);
        return target[prop];
      },
    },
  ) as SchemaCRUD<S>;
}

function assertValidRunOptions(options: RunOptions | undefined): void {
  // TODO(arv): We should enforce this with the type system too.
  assert(
    options?.type !== 'complete',
    'Cannot wait for complete results in custom mutations',
  );
}

function makeSchemaQuery<TSchema extends Schema, TContext>(schema: TSchema) {
  return new Proxy(
    {},
    {
      get(target: Record<string, Query<TSchema, string>>, prop: string) {
        if (prop in target) {
          return target[prop];
        }

        target[prop] = newQuery(schema, prop);
        return target[prop];
      },
    },
  ) as SchemaQuery<TSchema, TContext>;
}

function newZeroContext<TContext>(
  lc: ZeroLogContext,
  ivmBranch: IVMSourceBranch,
  context: TContext,
) {
  return new ZeroContext(
    lc,
    ivmBranch,
    context,
    () => emptyFunction,
    () => emptyFunction,
    emptyFunction,
    emptyFunction,
    emptyFunction,
    applyViewUpdates => applyViewUpdates(),
    emptyFunction,
    assertValidRunOptions,
  );
}

function makeTableCRUD(
  schema: Schema,
  tableName: string,
  tx: WriteTransaction,
  ivmBranch: IVMSourceBranch,
) {
  const table = must(schema.tables[tableName]);
  const {primaryKey} = table;
  return {
    insert: (value: InsertValue<TableSchema>) =>
      insertImpl(
        tx,
        {op: 'insert', tableName, primaryKey, value},
        schema,
        ivmBranch,
      ),
    upsert: (value: UpsertValue<TableSchema>) =>
      upsertImpl(
        tx,
        {op: 'upsert', tableName, primaryKey, value},
        schema,
        ivmBranch,
      ),
    update: (value: UpdateValue<TableSchema>) =>
      updateImpl(
        tx,
        {op: 'update', tableName, primaryKey, value},
        schema,
        ivmBranch,
      ),
    delete: (id: DeleteID<TableSchema>) =>
      deleteImpl(
        tx,
        {op: 'delete', tableName, primaryKey, value: id},
        schema,
        ivmBranch,
      ),
  };
}
