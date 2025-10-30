import {resolver} from '@rocicorp/resolver';
import React, {useSyncExternalStore} from 'react';
import {deepClone} from '../../shared/src/deep-clone.ts';
import type {Immutable} from '../../shared/src/immutable.ts';
import type {ReadonlyJSONValue} from '../../shared/src/json.ts';
import {Zero} from '../../zero-client/src/client/zero.ts';
import type {ErroredQuery} from '../../zero-protocol/src/custom-queries.ts';
import type {Schema} from '../../zero-schema/src/builder/schema-builder.ts';
import type {Format} from '../../zql/src/ivm/view.ts';
import {AbstractQuery} from '../../zql/src/query/query-impl.ts';
import {type HumanReadable, type Query} from '../../zql/src/query/query.ts';
import {DEFAULT_TTL_MS, type TTL} from '../../zql/src/query/ttl.ts';
import type {ResultType, TypedView} from '../../zql/src/query/typed-view.ts';
import {useZero} from './zero-provider.tsx';

export type QueryResultDetails = Readonly<
  | {
      type: 'complete';
    }
  | {
      type: 'unknown';
    }
  | QueryErrorDetails
>;

type QueryErrorDetails = {
  type: 'error';
  refetch: () => void;
  error:
    | {
        type: 'app';
        queryName: string;
        details: ReadonlyJSONValue;
      }
    | {
        type: 'http';
        queryName: string;
        status: number;
        details: ReadonlyJSONValue;
      };
};

export type QueryResult<TReturn> = readonly [
  HumanReadable<TReturn>,
  QueryResultDetails,
];

export type UseQueryOptions = {
  enabled?: boolean | undefined;
  /**
   * Time to live (TTL) in seconds. Controls how long query results are cached
   * after the query is removed. During this time, Zero continues to sync the query.
   * Default is 'never'.
   */
  ttl?: TTL | undefined;
};

export type UseSuspenseQueryOptions = UseQueryOptions & {
  /**
   * Whether to suspend until:
   * - 'partial': the query has partial results (partial array or defined
   *   value for singular results) which may be of result type 'unknown',
   *   or the query result type is 'complete' (in which case results may be
   *   empty).  This is useful for suspending until there are partial
   *   optimistic local results, or the query has completed loading from the
   *   server.
   * - 'complete': the query result type is 'complete'.
   *
   * Default is 'partial'.
   */
  suspendUntil?: 'complete' | 'partial';
};

const reactUse = (React as {use?: (p: Promise<unknown>) => void}).use;
const suspend: (p: Promise<unknown>) => void = reactUse
  ? reactUse
  : p => {
      throw p;
    };

export function useQuery<
  TSchema extends Schema,
  TTable extends keyof TSchema['tables'] & string,
  TReturn,
>(
  query: Query<TSchema, TTable, TReturn>,
  options?: UseQueryOptions | boolean,
): QueryResult<TReturn> {
  let enabled = true;
  let ttl: TTL = DEFAULT_TTL_MS;
  if (typeof options === 'boolean') {
    enabled = options;
  } else if (options) {
    ({enabled = true, ttl = DEFAULT_TTL_MS} = options);
  }

  const view = viewStore.getView(
    useZero(),
    query as AbstractQuery<TSchema, TTable, TReturn>,
    enabled,
    ttl,
  );
  // https://react.dev/reference/react/useSyncExternalStore
  return useSyncExternalStore(
    view.subscribeReactInternals,
    view.getSnapshot,
    view.getSnapshot,
  );
}

export function useSuspenseQuery<
  TSchema extends Schema,
  TTable extends keyof TSchema['tables'] & string,
  TReturn,
>(
  query: Query<TSchema, TTable, TReturn>,
  options?: UseSuspenseQueryOptions | boolean,
): QueryResult<TReturn> {
  let enabled = true;
  let ttl: TTL = DEFAULT_TTL_MS;
  let suspendUntil: 'complete' | 'partial' = 'partial';
  if (typeof options === 'boolean') {
    enabled = options;
  } else if (options) {
    ({
      enabled = true,
      ttl = DEFAULT_TTL_MS,
      suspendUntil = 'complete',
    } = options);
  }

  const view = viewStore.getView(
    useZero(),
    query as AbstractQuery<TSchema, TTable, TReturn>,
    enabled,
    ttl,
  );
  // https://react.dev/reference/react/useSyncExternalStore
  const snapshot = useSyncExternalStore(
    view.subscribeReactInternals,
    view.getSnapshot,
    view.getSnapshot,
  );

  if (enabled) {
    if (suspendUntil === 'complete' && !view.complete) {
      suspend(view.waitForComplete());
    }

    if (suspendUntil === 'partial' && !view.nonEmpty) {
      suspend(view.waitForNonEmpty());
    }
  }

  return snapshot;
}

const emptyArray: unknown[] = [];
const disabledSubscriber = () => () => {};

const resultTypeUnknown = {type: 'unknown'} as const;
const resultTypeComplete = {type: 'complete'} as const;
const resultTypeError = {type: 'error'} as const;

const emptySnapshotSingularUnknown = [undefined, resultTypeUnknown] as const;
const emptySnapshotSingularComplete = [undefined, resultTypeComplete] as const;
const emptySnapshotSingularErrorUnknown = [undefined, resultTypeError] as const;
const emptySnapshotPluralUnknown = [emptyArray, resultTypeUnknown] as const;
const emptySnapshotPluralComplete = [emptyArray, resultTypeComplete] as const;
const emptySnapshotErrorUnknown = [emptyArray, resultTypeError] as const;

function getDefaultSnapshot<TReturn>(singular: boolean): QueryResult<TReturn> {
  return (
    singular ? emptySnapshotSingularUnknown : emptySnapshotPluralUnknown
  ) as QueryResult<TReturn>;
}

/**
 * Returns a new snapshot or one of the empty predefined ones. Returning the
 * predefined ones is important to prevent unnecessary re-renders in React.
 */
function getSnapshot<TReturn>(
  singular: boolean,
  data: HumanReadable<TReturn>,
  resultType: ResultType,
  refetchFn: () => void,
  error?: ErroredQuery,
): QueryResult<TReturn> {
  if (singular && data === undefined) {
    switch (resultType) {
      case 'error':
        if (error) {
          return [
            undefined,
            makeError(refetchFn, error),
          ] as unknown as QueryResult<TReturn>;
        }
        return emptySnapshotSingularErrorUnknown as unknown as QueryResult<TReturn>;
      case 'complete':
        return emptySnapshotSingularComplete as unknown as QueryResult<TReturn>;
      case 'unknown':
        return emptySnapshotSingularUnknown as unknown as QueryResult<TReturn>;
    }
  }

  if (!singular && (data as unknown[]).length === 0) {
    switch (resultType) {
      case 'error':
        if (error) {
          return [
            emptyArray,
            makeError(refetchFn, error),
          ] as unknown as QueryResult<TReturn>;
        }
        return emptySnapshotErrorUnknown as unknown as QueryResult<TReturn>;
      case 'complete':
        return emptySnapshotPluralComplete as unknown as QueryResult<TReturn>;
      case 'unknown':
        return emptySnapshotPluralUnknown as unknown as QueryResult<TReturn>;
    }
  }

  switch (resultType) {
    case 'error':
      if (error) {
        return [data, makeError(refetchFn, error)];
      }
      return [
        data,
        makeError(refetchFn, {
          error: 'app',
          id: 'unknown',
          name: 'unknown',
          details: 'An unknown error occurred',
        }),
      ];
    case 'complete':
      return [data, resultTypeComplete];
    case 'unknown':
      return [data, resultTypeUnknown];
  }
}

function makeError(
  refetch: () => void,
  error: ErroredQuery,
): QueryErrorDetails {
  return {
    type: 'error',
    refetch,
    error:
      error.error === 'app' || error.error === 'zero'
        ? {
            type: 'app',
            queryName: error.name,
            details: error.details,
          }
        : {
            type: 'http',
            queryName: error.name,
            status: error.status,
            details: error.details,
          },
  };
}

declare const TESTING: boolean;

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type ViewWrapperAny = ViewWrapper<any, any, any>;

const allViews = new WeakMap<ViewStore, Map<string, ViewWrapperAny>>();

export function getAllViewsSizeForTesting(store: ViewStore): number {
  if (TESTING) {
    return allViews.get(store)?.size ?? 0;
  }
  return 0;
}

/**
 * A global store of all active views.
 *
 * React subscribes and unsubscribes to these views
 * via `useSyncExternalStore`.
 *
 * Managing views through `useEffect` or `useLayoutEffect` causes
 * inconsistencies because effects run after render.
 *
 * For example, if useQuery used use*Effect in the component below:
 * ```ts
 * function Foo({issueID}) {
 *   const issue = useQuery(z.query.issue.where('id', issueID).one());
 *   if (issue?.id !== undefined && issue.id !== issueID) {
 *     console.log('MISMATCH!', issue.id, issueID);
 *   }
 * }
 * ```
 *
 * `MISMATCH` will be printed whenever the `issueID` prop changes.
 *
 * This is because the component will render once with
 * the old state returned from `useQuery`. Then the effect inside
 * `useQuery` will run. The component will render again with the new
 * state. This inconsistent transition can cause unexpected results.
 *
 * Emulating `useEffect` via `useState` and `if` causes resource leaks.
 * That is:
 *
 * ```ts
 * function useQuery(q) {
 *   const [oldHash, setOldHash] = useState();
 *   if (hash(q) !== oldHash) {
 *      // make new view
 *   }
 *
 *   useEffect(() => {
 *     return () => view.destroy();
 *   }, []);
 * }
 * ```
 *
 * I'm not sure why but in strict mode the cleanup function
 * fails to be called for the first instance of the view and only
 * cleans up later instances.
 *
 * Swapping `useState` to `useRef` has similar problems.
 */
export class ViewStore {
  #views = new Map<string, ViewWrapperAny>();

  constructor() {
    if (TESTING) {
      allViews.set(this, this.#views);
    }
  }

  getView<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn,
  >(
    zero: Zero<TSchema>,
    query: Query<TSchema, TTable, TReturn>,
    enabled: boolean,
    ttl: TTL,
  ): {
    getSnapshot: () => QueryResult<TReturn>;
    subscribeReactInternals: (internals: () => void) => () => void;
    updateTTL: (ttl: TTL) => void;
    waitForComplete: () => Promise<void>;
    waitForNonEmpty: () => Promise<void>;
    complete: boolean;
    nonEmpty: boolean;
  } {
    const {format} = query;
    if (!enabled) {
      return {
        getSnapshot: () => getDefaultSnapshot(format.singular),
        subscribeReactInternals: disabledSubscriber,
        updateTTL: () => {},
        waitForComplete: () => Promise.resolve(),
        waitForNonEmpty: () => Promise.resolve(),
        complete: false,
        nonEmpty: false,
      };
    }

    const hash = query.hash() + zero.clientID;
    let existing = this.#views.get(hash);
    if (!existing) {
      existing = new ViewWrapper(zero, query, format, ttl, view => {
        const currentView = this.#views.get(hash);
        if (currentView && currentView !== view) {
          // we replaced the view with a new one already.
          return;
        }
        this.#views.delete(hash);
      });
      this.#views.set(hash, existing);
    } else {
      existing.updateTTL(ttl);
    }
    return existing as ViewWrapper<TSchema, TTable, TReturn>;
  }
}

const viewStore = new ViewStore();

/**
 * This wraps and ref counts a view.
 *
 * The only signal we have from React as to whether or not it is
 * done with a view is when it calls `unsubscribe`.
 *
 * In non-strict-mode we can clean up the view as soon
 * as the listener count goes to 0.
 *
 * In strict-mode, the listener count will go to 0 then a
 * new listener for the same view is immediately added back.
 *
 * This is why the `onMaterialized` and `onDematerialized` callbacks exist --
 * they allow a view which React is still referencing to be added
 * back into the store when React re-subscribes to it.
 *
 * This wrapper also exists to deal with the various
 * `useSyncExternalStore` caveats that cause excessive
 * re-renders and materializations.
 *
 * See: https://react.dev/reference/react/useSyncExternalStore#caveats
 * Especially:
 * 1. The store snapshot returned by getSnapshot must be immutable. If the underlying store has mutable data, return a new immutable snapshot if the data has changed. Otherwise, return a cached last snapshot.
 * 2. If a different subscribe function is passed during a re-render, React will re-subscribe to the store using the newly passed subscribe function. You can prevent this by declaring subscribe outside the component.
 */
class ViewWrapper<
  TSchema extends Schema,
  TTable extends keyof TSchema['tables'] & string,
  TReturn,
> {
  #zero: Zero<TSchema>;
  #view: TypedView<HumanReadable<TReturn>> | undefined;
  readonly #onDematerialized;
  readonly #query: Query<TSchema, TTable, TReturn>;
  readonly #format: Format;
  #snapshot: QueryResult<TReturn>;
  #reactInternals: Set<() => void>;
  #ttl: TTL;
  #complete = false;
  #completeResolver = resolver<void>();
  #nonEmpty = false;
  #nonEmptyResolver = resolver<void>();

  constructor(
    zero: Zero<TSchema>,
    query: Query<TSchema, TTable, TReturn>,
    format: Format,
    ttl: TTL,
    onDematerialized: (view: ViewWrapper<TSchema, TTable, TReturn>) => void,
  ) {
    this.#zero = zero;
    this.#query = query;
    this.#format = format;
    this.#ttl = ttl;
    this.#onDematerialized = onDematerialized;
    this.#snapshot = getDefaultSnapshot(format.singular);
    this.#reactInternals = new Set();
    this.#materializeIfNeeded();
  }

  #onData = (
    snap: Immutable<HumanReadable<TReturn>>,
    resultType: ResultType,
    error?: ErroredQuery,
  ) => {
    const data =
      snap === undefined
        ? snap
        : (deepClone(snap as ReadonlyJSONValue) as HumanReadable<TReturn>);
    this.#snapshot = getSnapshot(
      this.#format.singular,
      data,
      resultType,
      this.#refetch,
      error,
    );
    if (resultType === 'complete' || resultType === 'error') {
      this.#complete = true;
      this.#completeResolver.resolve();
      this.#nonEmpty = true;
      this.#nonEmptyResolver.resolve();
    }

    if (
      this.#format.singular
        ? this.#snapshot[0] !== undefined
        : (this.#snapshot[0] as unknown[]).length !== 0
    ) {
      this.#nonEmpty = true;
      this.#nonEmptyResolver.resolve();
    }

    for (const internals of this.#reactInternals) {
      internals();
    }
  };

  /**
   * Called by the user to force a refetch of the query
   * in the case the query errored.
   */
  #refetch = () => {
    this.#view?.destroy();
    this.#view = undefined;
    this.#materializeIfNeeded();
  };

  #materializeIfNeeded = () => {
    if (this.#view) {
      return;
    }

    this.#view = this.#zero.materialize(this.#query, {ttl: this.#ttl});
    this.#view.addListener(this.#onData);
  };

  getSnapshot = () => this.#snapshot;

  subscribeReactInternals = (internals: () => void): (() => void) => {
    this.#reactInternals.add(internals);
    this.#materializeIfNeeded();
    return () => {
      this.#reactInternals.delete(internals);

      // only schedule a cleanup task if we have no listeners left
      if (this.#reactInternals.size === 0) {
        setTimeout(() => {
          // We already destroyed the view
          if (this.#view === undefined) {
            return;
          }

          // Someone re-registered a listener on this view before the timeout elapsed.
          // This happens often in strict-mode which forces a component
          // to mount, unmount, remount.
          if (this.#reactInternals.size > 0) {
            return;
          }

          this.#view.destroy();
          this.#view = undefined;
          this.#complete = false;
          this.#completeResolver = resolver();
          this.#nonEmpty = false;
          this.#nonEmptyResolver = resolver();
          this.#onDematerialized(this);
        }, 10);
      }
    };
  };

  updateTTL(ttl: TTL): void {
    this.#ttl = ttl;
    this.#view?.updateTTL(ttl);
  }

  get complete() {
    return this.#complete;
  }

  waitForComplete(): Promise<void> {
    return this.#completeResolver.promise;
  }

  get nonEmpty() {
    return this.#nonEmpty;
  }

  waitForNonEmpty(): Promise<void> {
    return this.#nonEmptyResolver.promise;
  }
}
