import {produce, reconcile, type SetStoreFunction} from 'solid-js/store';
import {
  applyChange,
  type Change,
  type Entry,
  type Format,
  type Input,
  type Node,
  type Output,
  type Query,
  type Schema,
  type Stream,
  type TTL,
  type ViewChange,
  type ViewFactory,
} from '../../zero-client/src/mod.js';
import {idSymbol} from '../../zql/src/ivm/view-apply-change.ts';
import type {ReadonlyJSONValue} from '../../shared/src/json.ts';
import type {ErroredQuery} from '../../zero-protocol/src/custom-queries.ts';

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

export type State = [Entry, QueryResultDetails];

export const COMPLETE: QueryResultDetails = Object.freeze({type: 'complete'});
export const UNKNOWN: QueryResultDetails = Object.freeze({type: 'unknown'});

export class SolidView implements Output {
  readonly #input: Input;
  readonly #format: Format;
  readonly #onDestroy: () => void;
  readonly #refetch: () => void;

  #setState: SetStoreFunction<State>;

  // Optimization: if the store is currently empty we build up
  // the view on a plain old JS object stored at #builderRoot, and return
  // that for the new state on transaction commit.  This avoids building up
  // large views from scratch via solid produce.  The proxy object used by
  // solid produce is slow and in this case we don't care about solid tracking
  // the fine grained changes (everything has changed, it's all new).  For a
  // test case with a view with 3000 rows, each row having 2 children, this
  // optimization reduced #applyChanges time from 743ms to 133ms.
  #builderRoot: Entry | undefined;
  #pendingChanges: ViewChange[] = [];
  readonly #updateTTL: (ttl: TTL) => void;

  constructor(
    input: Input,
    onTransactionCommit: (cb: () => void) => void,
    format: Format,
    onDestroy: () => void,
    queryComplete: true | ErroredQuery | Promise<true>,
    updateTTL: (ttl: TTL) => void,
    setState: SetStoreFunction<State>,
    refetch: () => void,
  ) {
    this.#input = input;
    onTransactionCommit(this.#onTransactionCommit);
    this.#format = format;
    this.#onDestroy = onDestroy;
    this.#updateTTL = updateTTL;
    this.#refetch = refetch;

    input.setOutput(this);

    const initialRoot = this.#createEmptyRoot();
    this.#applyChangesToRoot(
      input.fetch({}),
      node => ({type: 'add', node}),
      initialRoot,
    );

    this.#setState = setState;
    this.#setState(
      reconcile(
        [
          initialRoot,
          queryComplete === true
            ? COMPLETE
            : 'error' in queryComplete
              ? this.#makeError(queryComplete)
              : UNKNOWN,
        ],
        {
          // solidjs's types want a string, but a symbol works
          key: idSymbol as unknown as string,
        },
      ),
    );

    if (isEmptyRoot(initialRoot)) {
      this.#builderRoot = this.#createEmptyRoot();
    }

    if (queryComplete !== true && !('error' in queryComplete)) {
      void queryComplete
        .then(() => {
          this.#setState(prev => [prev[0], COMPLETE]);
        })
        .catch((error: ErroredQuery) => {
          this.#setState(prev => [prev[0], this.#makeError(error)]);
        });
    }
  }

  #makeError(error: ErroredQuery): QueryErrorDetails {
    return {
      type: 'error',
      refetch: this.#refetch,
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

  destroy(): void {
    this.#onDestroy();
  }

  #onTransactionCommit = () => {
    const builderRoot = this.#builderRoot;
    if (builderRoot) {
      if (!isEmptyRoot(builderRoot)) {
        this.#setState(
          0,
          reconcile(builderRoot, {
            // solidjs's types want a string, but a symbol works
            key: idSymbol as unknown as string,
          }),
        );
        this.#setState(prev => [builderRoot, prev[1]]);
        this.#builderRoot = undefined;
      }
    } else {
      try {
        this.#applyChanges(this.#pendingChanges, c => c);
      } finally {
        this.#pendingChanges = [];
      }
    }
  };

  push(change: Change): void {
    // Delay updating the solid store state until the transaction commit
    // (because each update of the solid store is quite expensive).  If
    // this.#builderRoot is defined apply the changes to it (we are building
    // from an empty root), otherwise queue the changes to be applied
    // using produce at the end of the transaction but read the relationships
    // now as they are only valid to read when the push is received.
    if (this.#builderRoot) {
      this.#applyChangeToRoot(change, this.#builderRoot);
    } else {
      this.#pendingChanges.push(materializeRelationships(change));
    }
  }

  #applyChanges<T>(changes: Iterable<T>, mapper: (v: T) => ViewChange): void {
    this.#setState(
      produce((draftState: State) => {
        this.#applyChangesToRoot<T>(changes, mapper, draftState[0]);
        if (isEmptyRoot(draftState[0])) {
          this.#builderRoot = this.#createEmptyRoot();
        }
      }),
    );
  }

  #applyChangesToRoot<T>(
    changes: Iterable<T>,
    mapper: (v: T) => ViewChange,
    root: Entry,
  ) {
    for (const change of changes) {
      this.#applyChangeToRoot(mapper(change), root);
    }
  }

  #applyChangeToRoot(change: ViewChange, root: Entry) {
    applyChange(
      root,
      change,
      this.#input.getSchema(),
      '',
      this.#format,
      true /* withIDs */,
    );
  }

  #createEmptyRoot(): Entry {
    return {
      '': this.#format.singular ? undefined : [],
    };
  }

  updateTTL(ttl: TTL): void {
    this.#updateTTL(ttl);
  }
}

function materializeRelationships(change: Change): ViewChange {
  switch (change.type) {
    case 'add':
      return {type: 'add', node: materializeNodeRelationships(change.node)};
    case 'remove':
      return {type: 'remove', node: materializeNodeRelationships(change.node)};
    case 'child':
      return {
        type: 'child',
        node: {row: change.node.row},
        child: {
          relationshipName: change.child.relationshipName,
          change: materializeRelationships(change.child.change),
        },
      };
    case 'edit':
      return {
        type: 'edit',
        node: {row: change.node.row},
        oldNode: {row: change.oldNode.row},
      };
  }
}

function materializeNodeRelationships(node: Node): Node {
  const relationships: Record<string, () => Stream<Node>> = {};
  for (const relationship in node.relationships) {
    const materialized: Node[] = [];
    for (const n of node.relationships[relationship]()) {
      materialized.push(materializeNodeRelationships(n));
    }
    relationships[relationship] = () => materialized;
  }
  return {
    row: node.row,
    relationships,
  };
}

function isEmptyRoot(entry: Entry) {
  const data = entry[''];
  return data === undefined || (Array.isArray(data) && data.length === 0);
}

export function createSolidViewFactory(
  setState: SetStoreFunction<State>,
  refetch?: () => void,
) {
  function solidViewFactory<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn,
  >(
    _query: Query<TSchema, TTable, TReturn>,
    input: Input,
    format: Format,
    onDestroy: () => void,
    onTransactionCommit: (cb: () => void) => void,
    queryComplete: true | ErroredQuery | Promise<true>,
    updateTTL: (ttl: TTL) => void,
  ) {
    return new SolidView(
      input,
      onTransactionCommit,
      format,
      onDestroy,
      queryComplete,
      updateTTL,
      setState,
      refetch || (() => {}),
    );
  }

  solidViewFactory satisfies ViewFactory<Schema, string, unknown, unknown>;

  return solidViewFactory;
}
