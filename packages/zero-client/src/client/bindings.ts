import type {CustomMutatorDefs} from '../../../zero-client/src/client/custom.ts';
import type {Schema} from '../../../zero-types/src/schema.ts';
import type {Format, ViewFactory} from '../../../zql/src/ivm/view.ts';
import type {QueryDelegate} from '../../../zql/src/query/query-delegate.ts';
import type {
  HumanReadable,
  MaterializeOptions,
  Query,
} from '../../../zql/src/query/query.ts';
import type {TypedView} from '../../../zql/src/query/typed-view.ts';
import type {Zero} from './zero.ts';

/**
 * Internal WeakMap to store QueryDelegate for each Zero instance.
 * This is populated by Zero's constructor and allows bindings to access
 * the delegate without exposing it as a public API.
 */
const zeroDelegates = new WeakMap<
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  Zero<any, any, any>,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  QueryDelegate<any>
>();

export function registerZeroDelegate<
  TSchema extends Schema,
  MD extends CustomMutatorDefs | undefined,
  TContext,
>(zero: Zero<TSchema, MD, TContext>, delegate: QueryDelegate<TContext>): void {
  zeroDelegates.set(zero, delegate);
}

function mustGetDelegate<
  TSchema extends Schema,
  MD extends CustomMutatorDefs | undefined,
  TContext,
>(zero: Zero<TSchema, MD, TContext>): QueryDelegate<TContext> {
  const delegate = zeroDelegates.get(zero);
  if (!delegate) {
    throw new Error('Zero instance not registered with bindings');
  }
  return delegate;
}

/**
 * Bindings interface for Zero instances, providing methods to materialize queries
 * and extract query metadata.
 *
 * @internal This API is for bindings only, not end users.
 */
export interface BindingsForZero<TSchema extends Schema, TContext> {
  /**
   * Materialize a query into a reactive view without a custom factory.
   * Returns a TypedView that automatically updates when underlying data changes.
   */
  materialize<TTable extends keyof TSchema['tables'] & string, TReturn>(
    query: Query<TSchema, TTable, TReturn, TContext>,
    factory?: undefined,
    options?: MaterializeOptions,
  ): TypedView<HumanReadable<TReturn>>;

  /**
   * Materialize a query into a reactive view using a custom factory.
   * The factory can transform the view into a framework-specific reactive object.
   */
  materialize<TTable extends keyof TSchema['tables'] & string, TReturn, T>(
    query: Query<TSchema, TTable, TReturn, TContext>,
    factory: ViewFactory<TSchema, TTable, TReturn, TContext, T>,
    options?: MaterializeOptions,
  ): T;

  /**
   * Compute the hash of a query for caching and deduplication purposes.
   */
  hash<TTable extends keyof TSchema['tables'] & string, TReturn>(
    query: Query<TSchema, TTable, TReturn, TContext>,
  ): string;

  /**
   * Get the format/schema of a query's result set.
   */
  format<TTable extends keyof TSchema['tables'] & string, TReturn>(
    query: Query<TSchema, TTable, TReturn, TContext>,
  ): Format;
}

/**
 * Create a bindings object for a Zero instance.
 * This provides low-level access to query materialization and metadata extraction.
 *
 * @internal This API is for bindings only, not end users.
 */
export function bindingsForZero<
  TSchema extends Schema,
  MD extends CustomMutatorDefs | undefined,
  TContext,
>(zero: Zero<TSchema, MD, TContext>): BindingsForZero<TSchema, TContext> {
  const delegate = mustGetDelegate(zero);

  return {
    materialize<TTable extends keyof TSchema['tables'] & string, TReturn, T>(
      query: Query<TSchema, TTable, TReturn, TContext>,
      factory?: ViewFactory<TSchema, TTable, TReturn, TContext, T>,
      options?: MaterializeOptions,
    ) {
      return delegate.materialize(query, factory, options);
    },

    hash<TTable extends keyof TSchema['tables'] & string, TReturn>(
      query: Query<TSchema, TTable, TReturn, TContext>,
    ): string {
      const queryInternals = delegate.withContext(query);
      return queryInternals.hash();
    },

    format<TTable extends keyof TSchema['tables'] & string, TReturn>(
      query: Query<TSchema, TTable, TReturn, TContext>,
    ): Format {
      const queryInternals = delegate.withContext(query);
      return queryInternals.format;
    },
  };
}
