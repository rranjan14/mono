import type {AST} from '../../../zero-protocol/src/ast.ts';
import type {ErroredQuery} from '../../../zero-protocol/src/custom-queries.ts';
import type {Schema} from '../../../zero-types/src/schema.ts';
import type {BuilderDelegate} from '../builder/builder.ts';
import type {Format, ViewFactory} from '../ivm/view.ts';
import type {MetricsDelegate} from './metrics-delegate.ts';
import type {CustomQueryID} from './named.ts';
import type {QueryInternals} from './query-internals.ts';
import type {
  HumanReadable,
  MaterializeOptions,
  PreloadOptions,
  Query,
  RunOptions,
} from './query.ts';
import type {TTL} from './ttl.ts';
import type {TypedView} from './typed-view.ts';

export type CommitListener = () => void;
export type GotCallback = (got: boolean, error?: ErroredQuery) => void;

export interface NewQueryDelegate {
  newQuery<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn,
  >(
    schema: TSchema,
    table: TTable,
    ast: AST,
    format: Format,
  ): Query<TSchema, TTable, TReturn>;
}

/**
 * Interface for delegates that support materializing, running, and preloading queries.
 * This interface contains the methods needed to execute queries and manage their lifecycle.
 */
export interface QueryDelegate<TContext>
  extends BuilderDelegate,
    MetricsDelegate {
  withContext<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn,
  >(
    query: Query<TSchema, TTable, TReturn, TContext>,
  ): QueryInternals<TSchema, TTable, TReturn, TContext>;

  addServerQuery(ast: AST, ttl: TTL, gotCallback?: GotCallback): () => void;

  addCustomQuery(
    ast: AST,
    customQueryID: CustomQueryID,
    ttl: TTL,
    gotCallback?: GotCallback,
  ): () => void;

  updateServerQuery(ast: AST, ttl: TTL): void;

  updateCustomQuery(customQueryID: CustomQueryID, ttl: TTL): void;

  flushQueryChanges(): void;

  onTransactionCommit(cb: CommitListener): () => void;

  /**
   * batchViewUpdates is used to allow the view to batch multiple view updates together.
   * Normally, `applyViewUpdates` is called directly but for some cases, SolidJS for example,
   * the updates are wrapped in a batch to avoid multiple re-renders.
   */
  batchViewUpdates<T>(applyViewUpdates: () => T): T;

  /**
   * Asserts that the `RunOptions` provided to the `run` method are supported in
   * this context. For example, in a custom mutator, the `{type: 'complete'}`
   * option is not supported and this will throw.
   */
  assertValidRunOptions(options?: RunOptions): void;

  /**
   * Client queries start off as false (`unknown`) and are set to true when the
   * server sends the gotQueries message.
   *
   * For things like ZQLite the default is true (aka `complete`) because the
   * data is always available.
   */
  readonly defaultQueryComplete: boolean;

  /** Using the default view factory creates a TypedView */
  materialize<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn,
  >(
    query: Query<TSchema, TTable, TReturn, TContext>,
    factory?: undefined,
    options?: MaterializeOptions,
  ): TypedView<HumanReadable<TReturn>>;

  materialize<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn,
    T,
  >(
    query: Query<TSchema, TTable, TReturn, TContext>,
    factory?: ViewFactory<TSchema, TTable, TReturn, TContext, T>,
    options?: MaterializeOptions,
  ): T;

  /**
   * Materialize a query into a custom view using a provided factory function.
   */
  materialize<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn,
    T,
  >(
    query: Query<TSchema, TTable, TReturn, TContext>,
    factory?: ViewFactory<TSchema, TTable, TReturn, TContext, T>,
    options?: MaterializeOptions,
  ): T;

  /**
   * Run a query and return the results as a Promise.
   */
  run<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn,
  >(
    query: Query<TSchema, TTable, TReturn, TContext>,
    options?: RunOptions,
  ): Promise<HumanReadable<TReturn>>;

  /**
   * Preload a query's data without materializing a view.
   */
  preload<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn,
  >(
    query: Query<TSchema, TTable, TReturn, TContext>,
    options?: PreloadOptions,
  ): {
    cleanup: () => void;
    complete: Promise<void>;
  };
}
