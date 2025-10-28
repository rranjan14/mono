import {type LogLevel, type LogSink} from '@rocicorp/logger';
import {type Resolver, resolver} from '@rocicorp/resolver';
import {type DeletedClients} from '../../../replicache/src/deleted-clients.ts';
import {
  ReplicacheImpl,
  type ReplicacheImplOptions,
} from '../../../replicache/src/impl.ts';
import {dropDatabase} from '../../../replicache/src/persist/collect-idb-databases.ts';
import type {Puller, PullerResult} from '../../../replicache/src/puller.ts';
import type {Pusher, PusherResult} from '../../../replicache/src/pusher.ts';
import type {ReplicacheOptions} from '../../../replicache/src/replicache-options.ts';
import type {
  ClientGroupID,
  ClientID,
} from '../../../replicache/src/sync/ids.ts';
import type {PullRequest} from '../../../replicache/src/sync/pull.ts';
import type {PushRequest} from '../../../replicache/src/sync/push.ts';
import type {
  MutatorDefs,
  MutatorReturn,
  UpdateNeededReason as ReplicacheUpdateNeededReason,
} from '../../../replicache/src/types.ts';
import {assert, unreachable} from '../../../shared/src/asserts.ts';
import {
  getBrowserGlobal,
  mustGetBrowserGlobal,
} from '../../../shared/src/browser-env.ts';
import type {DeepMerge} from '../../../shared/src/deep-merge.ts';
import {getDocumentVisibilityWatcher} from '../../../shared/src/document-visible.ts';
import {h64} from '../../../shared/src/hash.ts';
import {must} from '../../../shared/src/must.ts';
import {navigator} from '../../../shared/src/navigator.ts';
import {promiseRace} from '../../../shared/src/promise-race.ts';
import {emptyFunction} from '../../../shared/src/sentinels.ts';
import {sleep, sleepWithAbort} from '../../../shared/src/sleep.ts';
import * as valita from '../../../shared/src/valita.ts';
import type {Writable} from '../../../shared/src/writable.ts';
import {type ClientSchema} from '../../../zero-protocol/src/client-schema.ts';
import type {ConnectedMessage} from '../../../zero-protocol/src/connect.ts';
import {encodeSecProtocols} from '../../../zero-protocol/src/connect.ts';
import type {DeleteClientsBody} from '../../../zero-protocol/src/delete-clients.ts';
import type {Downstream} from '../../../zero-protocol/src/down.ts';
import {downstreamSchema} from '../../../zero-protocol/src/down.ts';
import {ErrorKind} from '../../../zero-protocol/src/error-kind.ts';
import {
  ProtocolError,
  type ErrorMessage,
} from '../../../zero-protocol/src/error.ts';
import * as MutationType from '../../../zero-protocol/src/mutation-type-enum.ts';
import type {PingMessage} from '../../../zero-protocol/src/ping.ts';
import type {
  PokeEndMessage,
  PokePartMessage,
  PokeStartMessage,
} from '../../../zero-protocol/src/poke.ts';
import {PROTOCOL_VERSION} from '../../../zero-protocol/src/protocol-version.ts';
import type {
  PullRequestMessage,
  PullResponseBody,
  PullResponseMessage,
} from '../../../zero-protocol/src/pull.ts';
import type {
  CRUDMutation,
  CRUDMutationArg,
  CustomMutation,
  MutationID,
  PushMessage,
} from '../../../zero-protocol/src/push.ts';
import {CRUD_MUTATION_NAME, mapCRUD} from '../../../zero-protocol/src/push.ts';
import type {UpQueriesPatchOp} from '../../../zero-protocol/src/queries-patch.ts';
import type {Upstream} from '../../../zero-protocol/src/up.ts';
import type {NullableVersion} from '../../../zero-protocol/src/version.ts';
import {nullableVersionSchema} from '../../../zero-protocol/src/version.ts';
import {
  type Schema,
  clientSchemaFrom,
} from '../../../zero-schema/src/builder/schema-builder.ts';
import {
  type NameMapper,
  clientToServer,
} from '../../../zero-schema/src/name-mapper.ts';
import type {ViewFactory} from '../../../zql/src/ivm/view.ts';
import {customMutatorKey} from '../../../zql/src/mutate/custom.ts';
import {
  type ClientMetricMap,
  type MetricMap,
  isClientMetric,
} from '../../../zql/src/query/metrics-delegate.ts';
import type {QueryDelegate} from '../../../zql/src/query/query-delegate.ts';
import {
  type AnyQuery,
  materialize,
  newQuery,
} from '../../../zql/src/query/query-impl.ts';
import {
  type HumanReadable,
  type MaterializeOptions,
  type PreloadOptions,
  type Query,
  type QueryRowType,
  type QueryTable,
  type RunOptions,
  delegateSymbol,
} from '../../../zql/src/query/query.ts';
import type {TypedView} from '../../../zql/src/query/typed-view.ts';
import {nanoid} from '../util/nanoid.ts';
import {send} from '../util/socket.ts';
import {ActiveClientsManager} from './active-clients-manager.ts';
import {
  ConnectionManager,
  throwIfConnectionError,
} from './connection-manager.ts';
import {type Connection, ConnectionImpl} from './connection.ts';
import {ZeroContext} from './context.ts';
import {
  type BatchMutator,
  type CRUDMutator,
  type DBMutator,
  type WithCRUD,
  makeCRUDMutate,
  makeCRUDMutator,
} from './crud.ts';
import type {
  CustomMutatorDefs,
  CustomMutatorImpl,
  MakeCustomMutatorInterfaces,
} from './custom.ts';
import {makeReplicacheMutator} from './custom.ts';
import {DeleteClientsManager} from './delete-clients-manager.ts';
import {shouldEnableAnalytics} from './enable-analytics.ts';
import {
  type HTTPString,
  type WSString,
  appendPath,
  toWSString,
} from './http-string.ts';
import {Inspector} from './inspector/inspector.ts';
import {IVMSourceBranch} from './ivm-branch.ts';
import {type LogOptions, createLogOptions} from './log-options.ts';
import {
  DID_NOT_CONNECT_VALUE,
  MetricManager,
  REPORT_INTERVAL_MS,
  type Series,
  getLastConnectErrorValue,
  shouldReportConnectError,
} from './metrics.ts';
import {MutationTracker} from './mutation-tracker.ts';
import type {OnErrorParameters} from './on-error.ts';
import type {UpdateNeededReason, ZeroOptions} from './options.ts';
import {QueryManager} from './query-manager.ts';
import {
  reloadScheduled,
  reloadWithReason,
  reportReloadReason,
  resetBackoff,
} from './reload-error-handler.ts';
import {
  ClientError,
  getBackoffParams,
  getErrorConnectionTransition,
  isAuthError,
  isClientError,
  isServerError,
  NO_STATUS_TRANSITION,
  type ZeroError,
} from './error.ts';
import {getServer} from './server-option.ts';
import {version} from './version.ts';
import {ZeroLogContext} from './zero-log-context.ts';
import {PokeHandler} from './zero-poke-handler.ts';
import {ZeroRep} from './zero-rep.ts';
import {ConnectionStatus} from './connection-status.ts';
import {ClientErrorKind} from './client-error-kind.ts';
import {Subscribable} from '../../../shared/src/subscribable.ts';

export type NoRelations = Record<string, never>;

export type MakeEntityQueriesFromSchema<S extends Schema> = {
  readonly [K in keyof S['tables'] & string]: Query<S, K>;
};

declare const TESTING: boolean;

export type TestingContext = {
  puller: Puller;
  pusher: Pusher;
  setReload: (r: () => void) => void;
  logOptions: LogOptions;
  connectStart: () => number | undefined;
  socketResolver: () => Resolver<WebSocket>;
  connectionManager: () => ConnectionManager;
};

export const exposedToTestingSymbol = Symbol();
export const createLogOptionsSymbol = Symbol();

interface TestZero {
  [exposedToTestingSymbol]?: TestingContext;
  [createLogOptionsSymbol]?: (options: {
    consoleLogLevel: LogLevel;
    server: string | null;
  }) => LogOptions;
}

function asTestZero<S extends Schema, MD extends CustomMutatorDefs | undefined>(
  z: Zero<S, MD>,
): TestZero {
  return z as TestZero;
}

export const RUN_LOOP_INTERVAL_MS = 5_000;

/**
 * How frequently we should ping the server to keep the connection alive.
 */
export const PING_INTERVAL_MS = 5_000;

/**
 * The amount of time we wait for a pong before we consider the ping timed out.
 */
export const PING_TIMEOUT_MS = 5_000;

/**
 * The amount of time we wait for a pull response before we consider a pull
 * request timed out.
 */
export const PULL_TIMEOUT_MS = 5_000;

export const DEFAULT_DISCONNECT_HIDDEN_DELAY_MS = 5_000;

/**
 * The amount of time we allow for continuous connecting attempts before
 * transitioning to disconnected state.
 *
 * Default to 5 minutes.
 */
export const DEFAULT_DISCONNECT_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * The amount of time we wait for a connection to be established before we
 * consider it timed out.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

const CHECK_CONNECTIVITY_ON_ERROR_FREQUENCY = 6;

const NULL_LAST_MUTATION_ID_SENT = {clientID: '', id: -1} as const;

const DEFAULT_QUERY_CHANGE_THROTTLE_MS = 10;

function convertOnUpdateNeededReason(
  reason: ReplicacheUpdateNeededReason,
): UpdateNeededReason {
  return {type: reason.type};
}

function updateNeededReloadReasonMessage(reason: UpdateNeededReason) {
  const {type} = reason;
  let reasonMsg = '';
  switch (type) {
    case 'NewClientGroup':
      reasonMsg =
        "This client could not sync with a newer client. This is probably due to another tab loading a newer incompatible version of the app's code.";
      break;
    case 'VersionNotSupported':
      reasonMsg =
        "The server no longer supports this client's protocol version.";
      break;
    case 'SchemaVersionNotSupported':
      reasonMsg = 'Client and server schemas incompatible.';
      break;
    default:
      unreachable(type);
  }
  if (reason.message) {
    reasonMsg += ' ' + reason.message;
  }
  return reasonMsg;
}

const serverAheadReloadReason = `Server reported that client is ahead of server. This probably happened because the server is in development mode and restarted. Currently when this happens, the dev server loses its state and on reconnect sees the client as ahead. If you see this in other cases, it may be a bug in Zero.`;

function onClientStateNotFoundServerReason(serverErrMsg: string) {
  return `Server could not find state needed to synchronize this client. ${serverErrMsg}`;
}
const ON_CLIENT_STATE_NOT_FOUND_REASON_CLIENT =
  'The local persistent state needed to synchronize this client has been garbage collected.';

// Keep in sync with packages/replicache/src/replicache-options.ts
export interface ReplicacheInternalAPI {
  lastMutationID(): number;
}

const internalReplicacheImplMap = new WeakMap<object, ReplicacheImpl>();

export function getInternalReplicacheImplForTesting(
  z: object,
): ReplicacheImpl<MutatorDefs> {
  assert(TESTING);
  return must(internalReplicacheImplMap.get(z));
}

const CLOSE_CODE_NORMAL = 1000;
const CLOSE_CODE_GOING_AWAY = 1001;
type CloseCode = typeof CLOSE_CODE_NORMAL | typeof CLOSE_CODE_GOING_AWAY;

export class Zero<
  const S extends Schema,
  MD extends CustomMutatorDefs | undefined = undefined,
> {
  readonly version = version;

  readonly #rep: ReplicacheImpl<WithCRUD<MutatorDefs>>;
  readonly #server: HTTPString | null;
  readonly userID: string;
  readonly storageKey: string;

  readonly #lc: ZeroLogContext;
  readonly #logOptions: LogOptions;
  readonly #enableAnalytics: boolean;
  readonly #clientSchema: ClientSchema;

  readonly #pokeHandler: PokeHandler;
  readonly #queryManager: QueryManager;
  readonly #ivmMain: IVMSourceBranch;
  readonly #clientToServer: NameMapper;
  readonly #deleteClientsManager: DeleteClientsManager;
  readonly #mutationTracker: MutationTracker;

  /**
   * The queries we sent when inside the sec-protocol header when establishing a connection.
   * More queries could be registered while we're waiting for the 'connected' message
   * to come back from the server. To understand what queries we need to send
   * to the server, we diff the `initConnectionQueries` with the current set of desired queries.
   *
   * If this is set to `undefined` that means no queries were sent inside the `sec-protocol` header
   * and an `initConnection` message must be sent to the server after receiving the `connected` message.
   */
  #initConnectionQueries: Map<string, UpQueriesPatchOp> | undefined;

  /**
   * We try to send the deleted clients and (client groups) as part of the
   * sec-protocol header. If we can't because the header would get too large we
   * keep track of the deleted clients and send them after the connection is
   * established.
   */
  #deletedClients: DeleteClientsBody | undefined;

  #lastMutationIDSent: {clientID: string; id: number} =
    NULL_LAST_MUTATION_ID_SENT;

  #onPong: () => void = () => undefined;

  readonly #onlineManager: OnlineManager;

  readonly #onUpdateNeeded: (reason: UpdateNeededReason) => void;
  readonly #onClientStateNotFound: (reason?: string) => void;
  // Last cookie used to initiate a connection
  #connectCookie: NullableVersion = null;
  // Total number of sockets successfully connected by this client
  #connectedCount = 0;
  // Number of messages received over currently connected socket.  Reset
  // on disconnect.
  #messageCount = 0;
  #connectedAt = 0;
  // Reset on successful connection.
  #connectErrorCount = 0;

  #abortPingTimeout = () => {
    // intentionally empty
  };

  readonly #zeroContext: ZeroContext;
  readonly queryDelegate: QueryDelegate;

  #pendingPullsByRequestID: Map<string, Resolver<PullResponseBody>> = new Map();
  #lastMutationIDReceived = 0;

  #socket: WebSocket | undefined = undefined;
  #socketResolver = resolver<WebSocket>();
  /**
   * Utility promise that resolves when the socket transitions to connected.
   * It rejects if we hit an error or timeout before the connected message.
   * Used by push/pull helpers to queue work until the connection is usable.
   */
  #connectResolver = resolver<void>();

  #closeAbortController = new AbortController();

  readonly #visibilityWatcher;

  readonly #connectionManager: ConnectionManager;
  readonly #connection: Connection;
  readonly #activeClientsManager: Promise<ActiveClientsManager>;
  #inspector: Inspector | undefined;

  #connectStart: number | undefined = undefined;
  // Set on connect attempt if currently undefined.
  // Reset to undefined when
  // 1. client stops trying to connect because it is hidden
  // 2. client encounters a connect error and canary request indicates
  //    the client is offline
  // 2. client successfully connects
  #totalToConnectStart: number | undefined = undefined;

  readonly #options: ZeroOptions<S, MD>;

  readonly query: MakeEntityQueriesFromSchema<S>;

  // TODO: Metrics needs to be rethought entirely as we're not going to
  // send metrics to customer server.
  #metrics: MetricManager;

  // Store as field to allow test subclass to override. Web API doesn't allow
  // overwriting location fields for security reasons.
  #reload = () => getBrowserGlobal('location')?.reload();

  /**
   * Constructs a new Zero client.
   */
  constructor(options: ZeroOptions<S, MD>) {
    const {
      userID,
      storageKey,
      onOnlineChange,
      onUpdateNeeded,
      onClientStateNotFound,
      hiddenTabDisconnectDelay = DEFAULT_DISCONNECT_HIDDEN_DELAY_MS,
      schema,
      batchViewUpdates = applyViewUpdates => applyViewUpdates(),
      maxRecentQueries = 0,
      slowMaterializeThreshold = 5_000,
    } = options as ZeroOptions<S, MD>;
    if (!userID) {
      throw new ClientError({
        kind: ClientErrorKind.Internal,
        message: 'ZeroOptions.userID must not be empty.',
      });
    }
    const server = getServer(options.server);
    this.#enableAnalytics = shouldEnableAnalytics(
      server,
      false /*options.enableAnalytics,*/, // Reenable analytics
    );

    let {kvStore = 'idb'} = options as ZeroOptions<S, MD>;
    if (kvStore === 'idb') {
      if (!getBrowserGlobal('indexedDB')) {
        // oxlint-disable-next-line no-console
        console.warn(
          'IndexedDB is not supported in this environment. Falling back to memory storage.',
        );
        kvStore = 'mem';
      }
    }

    if (hiddenTabDisconnectDelay < 0) {
      throw new ClientError({
        kind: ClientErrorKind.Internal,
        message: 'ZeroOptions.hiddenTabDisconnectDelay must not be negative.',
      });
    }

    this.#onlineManager = new OnlineManager();

    if (onOnlineChange) {
      this.#onlineManager.subscribe(onOnlineChange);
    }

    this.#options = options;

    this.#logOptions = this.#createLogOptions({
      consoleLogLevel: options.logLevel ?? 'warn',
      server: null, //server, // Reenable remote logging
      enableAnalytics: this.#enableAnalytics,
    });
    const logOptions = this.#logOptions;

    this.#connectionManager = new ConnectionManager({
      disconnectTimeoutMs: DEFAULT_DISCONNECT_TIMEOUT_MS,
    });

    const {enableLegacyMutators = true, enableLegacyQueries = true} = schema;

    const replicacheMutators: MutatorDefs & {
      [CRUD_MUTATION_NAME]: CRUDMutator;
    } = {
      [CRUD_MUTATION_NAME]: enableLegacyMutators
        ? makeCRUDMutator(schema)
        : () =>
            Promise.reject(
              new ClientError({
                kind: ClientErrorKind.Internal,
                message: 'Zero CRUD mutators are not enabled.',
              }),
            ),
    };
    this.#ivmMain = new IVMSourceBranch(schema.tables);

    function assertUnique(key: string) {
      assert(
        replicacheMutators[key] === undefined,
        `A mutator, or mutator namespace, has already been defined for ${key}`,
      );
    }

    // We create a special log sink that calls onError if defined instead of
    // logging error messages.
    const {onError} = options;
    const sink = logOptions.logSink;
    const logSink: LogSink<OnErrorParameters> = {
      log(level, context, ...args) {
        if (level === 'error' && onError) {
          onError(...(args as OnErrorParameters));
        } else {
          sink.log(level, context, ...args);
        }
      },
      async flush() {
        await sink.flush?.();
      },
    };

    const lc = new ZeroLogContext(logOptions.logLevel, {}, logSink);

    this.#mutationTracker = new MutationTracker(
      lc,
      (upTo: MutationID) => this.#send(['ackMutationResponses', upTo]),
      error => {
        this.#disconnect(lc, error);
      },
    );
    if (options.mutators) {
      for (const [namespaceOrKey, mutatorOrMutators] of Object.entries(
        options.mutators,
      )) {
        if (typeof mutatorOrMutators === 'function') {
          const key = namespaceOrKey as string;
          assertUnique(key);
          replicacheMutators[key] = makeReplicacheMutator(
            lc,
            mutatorOrMutators,
            schema,
            // Replicache expects mutators to only be able to return JSON
            // but Zero wraps the return with: `{server?: Promise<MutationResult>, client?: T}`
          ) as () => MutatorReturn;
          continue;
        }
        if (typeof mutatorOrMutators === 'object') {
          for (const [name, mutator] of Object.entries(mutatorOrMutators)) {
            const key = customMutatorKey(
              namespaceOrKey as string,
              name as string,
            );
            assertUnique(key);
            replicacheMutators[key] = makeReplicacheMutator(
              lc,
              mutator as CustomMutatorImpl<S>,
              schema,
            ) as () => MutatorReturn;
          }
          continue;
        }
        unreachable(mutatorOrMutators);
      }
    }

    this.storageKey = storageKey ?? '';

    const {clientSchema, hash} = clientSchemaFrom(schema);
    this.#clientSchema = clientSchema;

    // Create a hash that includes storage key, URL configuration, and query parameters
    const nameKey = JSON.stringify({
      storageKey: this.storageKey,
      mutateUrl: options.mutateURL ?? '',
      queryUrl: options.getQueriesURL ?? '',
    });
    const hashedKey = h64(nameKey).toString(36);

    const replicacheOptions: ReplicacheOptions<WithCRUD<MutatorDefs>> = {
      // The schema stored in IDB is dependent upon both the ClientSchema
      // and the AST schema (i.e. PROTOCOL_VERSION).
      schemaVersion: `${PROTOCOL_VERSION}.${hash}`,
      logLevel: logOptions.logLevel,
      logSinks: [logOptions.logSink],
      mutators: replicacheMutators,
      name: `zero-${userID}-${hashedKey}`,
      pusher: (req, reqID) => this.#pusher(req, reqID),
      puller: (req, reqID) => this.#puller(req, reqID),
      pushDelay: 0,
      requestOptions: {
        maxDelayMs: 0,
        minDelayMs: 0,
      },
      licenseKey: 'zero-client-static-key',
      kvStore,
    };

    this.#zeroContext = new ZeroContext(
      lc,
      this.#ivmMain,
      (ast, ttl, gotCallback) => {
        if (enableLegacyQueries) {
          return this.#queryManager.addLegacy(ast, ttl, gotCallback);
        }
        // legacy queries are client side only. Do not track with the server
        return emptyFunction;
      },
      (ast, customQueryID, ttl, gotCallback) =>
        this.#queryManager.addCustom(ast, customQueryID, ttl, gotCallback),
      (ast, ttl) => {
        if (enableLegacyQueries) {
          this.#queryManager.updateLegacy(ast, ttl);
        }
      },
      (customQueryID, ttl) =>
        this.#queryManager.updateCustom(customQueryID, ttl),
      () => this.#queryManager.flushBatch(),
      batchViewUpdates,
      this.#addMetric,
      assertValidRunOptions,
    );
    this.queryDelegate = this.#zeroContext;

    const replicacheImplOptions: ReplicacheImplOptions = {
      enableClientGroupForking: false,
      enableMutationRecovery: false,
      enablePullAndPushInOpen: false, // Zero calls push in its connection management code
      onClientsDeleted: deletedClients =>
        this.#deleteClientsManager.onClientsDeleted(deletedClients),
      zero: new ZeroRep(
        this.#zeroContext,
        this.#ivmMain,
        options.mutators !== undefined,
        this.#mutationTracker,
      ),
    };

    const rep = new ReplicacheImpl(replicacheOptions, replicacheImplOptions);
    this.#rep = rep;

    if (TESTING) {
      internalReplicacheImplMap.set(this, rep);
    }
    this.#server = server;
    this.userID = userID;
    this.#lc = lc.withContext('clientID', rep.clientID);
    this.#connection = new ConnectionImpl(this.#connectionManager, this.#lc);
    this.#mutationTracker.setClientIDAndWatch(
      rep.clientID,
      rep.experimentalWatch.bind(rep),
    );

    this.#activeClientsManager = makeActiveClientsManager(
      rep.clientGroupID,
      this.clientID,
      this.#closeAbortController.signal,
      (clientID: ClientID, clientGroupID: ClientGroupID) =>
        this.#deleteClientsManager.onClientsDeleted([
          {clientGroupID, clientID},
        ]),
    );

    const onUpdateNeededCallback = (reason: UpdateNeededReason) => {
      if (onUpdateNeeded) {
        onUpdateNeeded(reason);
      } else {
        reloadWithReason(
          this.#lc,
          this.#reload,
          reason.type,
          updateNeededReloadReasonMessage(reason),
        );
      }
    };
    this.#onUpdateNeeded = onUpdateNeededCallback;
    this.#rep.onUpdateNeeded = reason => {
      onUpdateNeededCallback(convertOnUpdateNeededReason(reason));
    };

    const onClientStateNotFoundCallback =
      onClientStateNotFound ??
      ((reason?: string) => {
        reloadWithReason(
          this.#lc,
          this.#reload,
          ErrorKind.ClientNotFound,
          reason ?? ON_CLIENT_STATE_NOT_FOUND_REASON_CLIENT,
        );
      });
    this.#onClientStateNotFound = onClientStateNotFoundCallback;
    this.#rep.onClientStateNotFound = onClientStateNotFoundCallback;

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const {mutate, mutateBatch} = makeCRUDMutate<S>(schema, rep.mutate) as any;

    if (options.mutators) {
      for (const [namespaceOrKey, mutatorsOrMutator] of Object.entries(
        options.mutators,
      )) {
        if (typeof mutatorsOrMutator === 'function') {
          mutate[namespaceOrKey] = must(rep.mutate[namespaceOrKey as string]);
          continue;
        }

        let existing = mutate[namespaceOrKey];
        if (existing === undefined) {
          existing = {};
          mutate[namespaceOrKey] = existing;
        }

        for (const name of Object.keys(mutatorsOrMutator)) {
          existing[name] = must(
            rep.mutate[customMutatorKey(namespaceOrKey, name)],
          );
        }
      }
    }

    this.mutate = mutate;
    this.mutateBatch = mutateBatch;

    this.#queryManager = new QueryManager(
      this.#lc,
      this.#mutationTracker,
      rep.clientID,
      schema.tables,
      msg => this.#send(msg),
      rep.experimentalWatch.bind(rep),
      maxRecentQueries,
      options.queryChangeThrottleMs ?? DEFAULT_QUERY_CHANGE_THROTTLE_MS,
      slowMaterializeThreshold,
      (error: ZeroError) => {
        this.#disconnect(lc, error);
      },
    );
    this.#clientToServer = clientToServer(schema.tables);

    this.#deleteClientsManager = new DeleteClientsManager(
      msg => this.#send(msg),
      rep.perdag,
      this.#lc,
      this.#rep.clientGroupID,
    );

    this.query = this.#registerQueries(schema);

    reportReloadReason(this.#lc);

    this.#metrics = new MetricManager({
      reportIntervalMs: REPORT_INTERVAL_MS,
      host: getBrowserGlobal('location')?.host ?? '',
      source: 'client',
      reporter: this.#enableAnalytics
        ? allSeries => this.#reportMetrics(allSeries)
        : () => Promise.resolve(),
      lc: this.#lc,
    });
    this.#metrics.tags.push(`version:${this.version}`);

    this.#pokeHandler = new PokeHandler(
      poke => this.#rep.poke(poke),
      () => this.#onPokeError(),
      rep.clientID,
      schema,
      this.#lc,
      this.#mutationTracker,
    );

    this.#visibilityWatcher = getDocumentVisibilityWatcher(
      getBrowserGlobal('document'),
      hiddenTabDisconnectDelay,
      this.#closeAbortController.signal,
    );

    void this.#runLoop();

    this.#expose();

    if (TESTING) {
      asTestZero(this)[exposedToTestingSymbol] = {
        puller: this.#puller,
        pusher: this.#pusher,
        setReload: (r: () => void) => {
          this.#reload = r;
        },
        logOptions: this.#logOptions,
        connectStart: () => this.#connectStart,
        socketResolver: () => this.#socketResolver,
        connectionManager: () => this.#connectionManager,
      };
    }
  }

  #expose() {
    // Expose the Zero instance to the global scope.
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (g.__zero === undefined) {
      g.__zero = this;
    } else if (g.__zero instanceof Zero) {
      const prev = g.__zero;
      g.__zero = {
        [prev.clientID]: prev,
        [this.clientID]: this,
      };
    } else {
      g.__zero[this.clientID] = this;
    }
  }

  #unexpose() {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    assert(g.__zero !== undefined);
    if (g.__zero instanceof Zero) {
      assert(g.__zero === this);
      delete g.__zero;
    } else {
      delete g.__zero[this.clientID];
      if (Object.entries(g.__zero).length === 1) {
        g.__zero = Object.values(g.__zero)[0];
      }
    }
  }

  #send(msg: Upstream): void {
    if (
      this.#socket &&
      this.#connectionManager.is(ConnectionStatus.Connected)
    ) {
      send(this.#socket, msg);
    }
  }

  #createLogOptions(options: {
    consoleLogLevel: LogLevel;
    server: HTTPString | null;
    enableAnalytics: boolean;
  }): LogOptions {
    if (TESTING) {
      const testZero = asTestZero(this);
      if (testZero[createLogOptionsSymbol]) {
        return testZero[createLogOptionsSymbol](options);
      }
    }
    return createLogOptions(options);
  }

  preload(
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    query: Query<S, keyof S['tables'] & string, any>,
    options?: PreloadOptions,
  ) {
    return query[delegateSymbol](this.#zeroContext).preload(options);
  }

  run<Q>(
    query: Q,
    runOptions?: RunOptions,
  ): Promise<HumanReadable<QueryRowType<Q>>> {
    return (query as AnyQuery)
      [delegateSymbol](this.#zeroContext)
      .run(runOptions) as Promise<HumanReadable<QueryRowType<Q>>>;
  }

  materialize<Q>(
    query: Q,
    options?: MaterializeOptions,
  ): TypedView<HumanReadable<QueryRowType<Q>>>;
  materialize<T, Q>(
    query: Q,
    factory: ViewFactory<S, QueryTable<Q>, QueryRowType<Q>, T>,
    options?: MaterializeOptions,
  ): T;
  materialize<T, Q>(
    query: Q,
    factoryOrOptions?:
      | ViewFactory<S, QueryTable<Q>, QueryRowType<Q>, T>
      | MaterializeOptions,
    maybeOptions?: MaterializeOptions,
  ) {
    return materialize(
      query,
      this.#zeroContext,
      factoryOrOptions,
      maybeOptions,
    );
  }

  /**
   * The server URL that this Zero instance is configured with.
   */
  get server(): HTTPString | null {
    return this.#server;
  }

  /**
   * The name of the IndexedDB database in which the data of this
   * instance of Zero is stored.
   */
  get idbName(): string {
    return this.#rep.idbName;
  }

  /**
   * The schema version of the data understood by this application.
   * See [[ZeroOptions.schemaVersion]].
   */
  get schemaVersion(): string {
    return this.#rep.schemaVersion;
  }

  /**
   * The schema passed into Zero when it was constructed.
   *
   * This can be paired with the inspector API to explore the client cache for
   * debugging or tooling. The inspector exposes the raw key/value map as well
   * as the per-table rows that back `zero.query[tableName].run()`.
   *
   * ```ts
   * const inspector = __zero.inspector;
   * const client = inspector.client;
   *
   * console.log('client map:', await client.map());
   *
   * for (const tableName of Object.keys(__zero.schema.tables)) {
   *   console.table(await client.rows(tableName));
   * }
   * ```
   */
  get schema(): S {
    return this.#options.schema;
  }

  /**
   * The client ID for this instance of Zero. Each instance
   * gets a unique client ID.
   */
  get clientID(): ClientID {
    return this.#rep.clientID;
  }

  get clientGroupID(): Promise<ClientGroupID> {
    return this.#rep.clientGroupID;
  }

  /**
   * Provides simple "CRUD" mutations for the tables in the schema.
   *
   * Each table has `create`, `set`, `update`, and `delete` methods.
   *
   * ```ts
   * await zero.mutate.issue.create({id: '1', title: 'First issue', priority: 'high'});
   * await zero.mutate.comment.create({id: '1', text: 'First comment', issueID: '1'});
   * ```
   *
   * The `update` methods support partials. Unspecified or `undefined` fields
   * are left unchanged:
   *
   * ```ts
   * // Priority left unchanged.
   * await zero.mutate.issue.update({id: '1', title: 'Updated title'});
   * ```
   */
  readonly mutate: MD extends CustomMutatorDefs
    ? S['enableLegacyMutators'] extends false
      ? MakeCustomMutatorInterfaces<S, MD>
      : DeepMerge<DBMutator<S>, MakeCustomMutatorInterfaces<S, MD>>
    : DBMutator<S>;

  /**
   * Provides a way to batch multiple CRUD mutations together:
   *
   * ```ts
   * await zero.mutateBatch(m => {
   *   await m.issue.create({id: '1', title: 'First issue'});
   *   await m.comment.create({id: '1', text: 'First comment', issueID: '1'});
   * });
   * ```
   *
   * Batch sends all mutations in a single transaction. If one fails, all are
   * rolled back together. Batch can also be more efficient than making many
   * individual mutations.
   *
   * `mutateBatch` is not allowed inside another `mutateBatch` call. Doing so
   * will throw an error.
   */
  readonly mutateBatch: BatchMutator<S>;

  /**
   * The connection API for managing Zero's connection lifecycle.
   *
   * Use this to monitor connection state and manually control connections.
   *
   * @example
   * ```ts
   * // Subscribe to connection state changes
   * z.connection.state.subscribe(state => {
   *   console.log('Connection state:', state.name);
   * });
   *
   * // Manually resume connection from error state
   * await z.connection.connect();
   * ```
   */
  get connection(): Connection {
    return this.#connection;
  }

  /**
   * Whether this Zero instance has been closed.
   *
   * Once a Zero instance has been closed it no longer syncs, you can no
   * longer query or mutate data with it, and its query views stop updating.
   */
  get closed(): boolean {
    return this.#connectionManager.is(ConnectionStatus.Closed);
  }

  /**
   * Closes this Zero instance.
   *
   * Once a Zero instance has been closed it no longer syncs, you can no
   * longer query or mutate data with it, and its query views stop updating.
   */
  async close(): Promise<void> {
    const lc = this.#lc.withContext('close');

    try {
      if (this.closed) {
        lc.debug?.('close() called on already closed instance');
        return;
      }

      lc.debug?.('Closing Zero instance. Stack:', new Error().stack);

      this.#onlineManager.cleanup();

      if (!this.#connectionManager.is(ConnectionStatus.Disconnected)) {
        this.#disconnect(
          lc,
          new ClientError({
            kind: ClientErrorKind.ClientClosed,
            message: 'Zero instance closed by user',
          }),
          CLOSE_CODE_NORMAL,
        );
      }
      lc.debug?.('Aborting closeAbortController due to close()');
      this.#closeAbortController.abort();
      this.#metrics.stop();
      const ret = await this.#rep.close();
      this.#unexpose();
      return ret;
    } catch (e) {
      lc.error?.('Error closing Zero instance', e);
      throw e;
    } finally {
      this.#connectionManager.closed();
    }
  }

  #onMessage = (e: MessageEvent<string>) => {
    const lc = this.#lc;
    lc.debug?.('received message', e.data);
    if (this.closed) {
      lc.debug?.('ignoring message because already closed');
      return;
    }

    let downMessage: Downstream;
    const {data} = e;
    try {
      downMessage = valita.parse(
        JSON.parse(data),
        downstreamSchema,
        'passthrough',
      );
    } catch (e) {
      const invalidMessageError = new ClientError({
        kind: ClientErrorKind.InvalidMessage,
        message: `Invalid message received from server: ${e instanceof Error ? e.message + '. ' : ''}${data}`,
      });
      this.#disconnect(lc, invalidMessageError);
      return;
    }
    this.#messageCount++;
    const msgType = downMessage[0];
    switch (msgType) {
      case 'connected':
        return this.#handleConnectedMessage(lc, downMessage);

      case 'error':
        return this.#handleErrorMessage(lc, downMessage);

      case 'pong':
        // Receiving a pong means that the connection is healthy, as the
        // initial schema / versioning negotiations would produce an error
        // before a ping-pong timeout.
        resetBackoff();
        return this.#onPong();

      case 'pokeStart':
        return this.#handlePokeStart(lc, downMessage);

      case 'pokePart':
        if (downMessage[1].rowsPatch) {
          // Receiving row data indicates that the client is in a good state
          // and can reset the reload backoff state.
          resetBackoff();
        }
        return this.#handlePokePart(lc, downMessage);

      case 'pokeEnd':
        return this.#handlePokeEnd(lc, downMessage);

      case 'pull':
        return this.#handlePullResponse(lc, downMessage);

      case 'deleteClients':
        return this.#deleteClientsManager.clientsDeletedOnServer(
          downMessage[1],
        );

      case 'pushResponse':
        return this.#mutationTracker.processPushResponse(downMessage[1]);

      case 'transformError':
        this.#queryManager.handleTransformErrors(downMessage[1]);
        break;

      case 'inspect':
        // ignore at this layer.
        break;

      default: {
        const invalidMessageError = new ClientError({
          kind: ClientErrorKind.InvalidMessage,
          message: `Invalid message received from server: ${data}`,
        });
        this.#disconnect(lc, invalidMessageError);
        return;
      }
    }
  };

  #onOpen = () => {
    const l = addWebSocketIDFromSocketToLogContext(this.#socket!, this.#lc);
    if (this.#connectStart === undefined) {
      l.error?.('Got open event but connect start time is undefined.');
    } else {
      const now = Date.now();
      const timeToOpenMs = now - this.#connectStart;
      l.info?.('Got socket open event', {
        navigatorOnline: navigator?.onLine,
        timeToOpenMs,
      });
    }
  };

  #onClose = (e: CloseEvent) => {
    const lc = addWebSocketIDFromSocketToLogContext(this.#socket!, this.#lc);
    const {code, reason, wasClean} = e;
    if (code <= 1001) {
      lc.info?.('Got socket close event', {code, reason, wasClean});
    } else {
      lc.error?.('Got unexpected socket close event', {
        code,
        reason,
        wasClean,
      });
    }

    const closeError = new ClientError(
      wasClean
        ? {
            kind: ClientErrorKind.CleanClose,
            message: 'WebSocket connection closed cleanly',
          }
        : {
            kind: ClientErrorKind.AbruptClose,
            message: 'WebSocket connection closed abruptly',
          },
    );
    this.#connectResolver.reject(closeError);
    this.#disconnect(lc, closeError);
  };

  // An error on the connection is fatal for the connection.
  async #handleErrorMessage(
    lc: ZeroLogContext,
    downMessage: ErrorMessage,
  ): Promise<void> {
    const [, {kind, message}] = downMessage;

    // Rate limit errors are not fatal to the connection.
    // We really don't want to disconnect and reconnect a rate limited user as
    // it'll use more resources on the server
    if (kind === ErrorKind.MutationRateLimited) {
      this.#lastMutationIDSent = NULL_LAST_MUTATION_ID_SENT;
      lc.error?.(kind, 'Mutation rate limited', {message});
      return;
    }

    lc.info?.(`${kind}: ${message}}`);
    const error = new ProtocolError(downMessage[1]);
    lc.error?.(`${error.kind}:\n\n${error.errorBody.message}`, error);

    lc.debug?.('Rejecting connect resolver due to error', error);
    this.#connectResolver.reject(error);
    this.#disconnect(lc, error);

    if (kind === ErrorKind.VersionNotSupported) {
      this.#onUpdateNeeded({type: kind, message});
    } else if (kind === ErrorKind.SchemaVersionNotSupported) {
      await this.#rep.disableClientGroup();
      this.#onUpdateNeeded({
        type: 'SchemaVersionNotSupported',
        message,
      });
    } else if (kind === ErrorKind.ClientNotFound) {
      await this.#rep.disableClientGroup();
      this.#onClientStateNotFound?.(onClientStateNotFoundServerReason(message));
    } else if (
      kind === ErrorKind.InvalidConnectionRequestLastMutationID ||
      kind === ErrorKind.InvalidConnectionRequestBaseCookie
    ) {
      await dropDatabase(this.#rep.idbName);
      reloadWithReason(lc, this.#reload, kind, serverAheadReloadReason);
    }
  }

  async #handleConnectedMessage(
    lc: ZeroLogContext,
    connectedMessage: ConnectedMessage,
  ): Promise<void> {
    const now = Date.now();
    const [, connectBody] = connectedMessage;
    lc = addWebSocketIDToLogContext(connectBody.wsid, lc);

    if (this.#connectedCount === 0) {
      this.#checkConnectivity('firstConnect');
    } else if (this.#connectErrorCount > 0) {
      this.#checkConnectivity('connectAfterError');
    }
    this.#connectedCount++;
    this.#connectedAt = now;
    this.#metrics.lastConnectError.clear();
    const proceedingConnectErrorCount = this.#connectErrorCount;
    this.#connectErrorCount = 0;

    let timeToConnectMs: number | undefined;
    let connectMsgLatencyMs: number | undefined;
    if (this.#connectStart === undefined) {
      lc.error?.('Got connected message but connect start time is undefined.');
    } else {
      timeToConnectMs = now - this.#connectStart;
      this.#metrics.timeToConnectMs.set(timeToConnectMs);
      connectMsgLatencyMs =
        connectBody.timestamp !== undefined
          ? now - connectBody.timestamp
          : undefined;
      this.#connectStart = undefined;
    }
    let totalTimeToConnectMs: number | undefined;
    if (this.#totalToConnectStart === undefined) {
      lc.error?.(
        'Got connected message but total to connect start time is undefined.',
      );
    } else {
      totalTimeToConnectMs = now - this.#totalToConnectStart;
      this.#totalToConnectStart = undefined;
    }

    this.#metrics.setConnected(timeToConnectMs ?? 0, totalTimeToConnectMs ?? 0);

    lc.info?.('Connected', {
      navigatorOnline: navigator?.onLine,
      timeToConnectMs,
      totalTimeToConnectMs,
      connectMsgLatencyMs,
      connectedCount: this.#connectedCount,
      proceedingConnectErrorCount,
    });
    this.#lastMutationIDSent = NULL_LAST_MUTATION_ID_SENT;

    lc.debug?.('Resolving connect resolver');
    const socket = must(this.#socket);
    const queriesPatch = await this.#rep.query(tx =>
      this.#queryManager.getQueriesPatch(tx, this.#initConnectionQueries),
    );

    const hasDeletedClients = () =>
      skipEmptyArray(this.#deletedClients?.clientIDs) ||
      skipEmptyArray(this.#deletedClients?.clientGroupIDs);

    const maybeSendDeletedClients = () => {
      if (hasDeletedClients()) {
        send(socket, ['deleteClients', this.#deletedClients!]);
        this.#deletedClients = undefined;
      }
    };

    if (queriesPatch.size > 0 && this.#initConnectionQueries !== undefined) {
      maybeSendDeletedClients();
      send(socket, [
        'changeDesiredQueries',
        {
          desiredQueriesPatch: [...queriesPatch.values()],
        },
      ]);
    } else if (this.#initConnectionQueries === undefined) {
      // if #initConnectionQueries was undefined that means we never
      // sent `initConnection` to the server inside the sec-protocol header.
      const clientSchema = this.#clientSchema;
      send(socket, [
        'initConnection',
        {
          desiredQueriesPatch: [...queriesPatch.values()],
          deleted: skipEmptyDeletedClients(this.#deletedClients),
          // The clientSchema only needs to be sent for the very first request.
          // Henceforth it is stored with the CVR and verified automatically.
          ...(this.#connectCookie === null ? {clientSchema} : {}),
          userPushURL: this.#options.mutateURL,
          userQueryURL: this.#options.getQueriesURL,
        },
      ]);
      this.#deletedClients = undefined;
    }
    this.#initConnectionQueries = undefined;

    maybeSendDeletedClients();

    this.#connectionManager.connected();
    this.#connectResolver.resolve();
  }

  /**
   * Starts a new connection. This will create the WebSocket that does the HTTP
   * request to the server.
   *
   * {@link #connect} will throw an assertion error if the
   * {@link #connectionManager} status is not {@link ConnectionState.Disconnected}
   * or {@link ConnectionState.Connecting}.
   * Callers MUST check the connection status before calling this method and log
   * an error as needed.
   *
   * The function will resolve once the socket is connected. If you need to know
   * when a connection has been established, as in we have received the
   * {@link ConnectedMessage}, you should await the {@link #connectResolver}
   * promise. The {@link #connectResolver} promise rejects if an error message
   * is received before the connected message is received or if the connection
   * attempt times out.
   */
  async #connect(
    lc: ZeroLogContext,
    additionalConnectParams: Record<string, string> | undefined,
  ): Promise<void> {
    assert(this.#server);

    // can be called from both disconnected and connecting states.
    // connecting() handles incrementing attempt counter if already connecting.
    assert(
      this.#connectionManager.is(ConnectionStatus.Disconnected) ||
        this.#connectionManager.is(ConnectionStatus.Connecting),
    );

    const wsid = nanoid();
    lc = addWebSocketIDToLogContext(wsid, lc);
    lc.info?.('Connecting...', {navigatorOnline: navigator?.onLine});

    this.#connectionManager.connecting();

    // connect() called but connect start time is defined. This should not
    // happen.
    assert(this.#connectStart === undefined);

    const now = Date.now();
    this.#connectStart = now;
    if (this.#totalToConnectStart === undefined) {
      this.#totalToConnectStart = now;
    }

    if (this.closed) {
      return;
    }
    this.#connectCookie = valita.parse(
      await this.#rep.cookie,
      nullableVersionSchema,
      'passthrough',
    );
    if (this.closed) {
      return;
    }

    // Reject connect after a timeout.
    const timeoutID = setTimeout(() => {
      lc.debug?.('Rejecting connect resolver due to timeout');
      const timeoutError = new ClientError({
        kind: ClientErrorKind.ConnectTimeout,
        message: `Connection attempt timed out after ${CONNECT_TIMEOUT_MS / 1000} seconds`,
      });
      this.#connectResolver.reject(timeoutError);
      this.#disconnect(lc, timeoutError);
    }, CONNECT_TIMEOUT_MS);
    const abortHandler = () => {
      clearTimeout(timeoutID);
    };
    // signal.aborted cannot be true here because we checked for `this.closed` above.
    this.#closeAbortController.signal.addEventListener('abort', abortHandler);

    const [ws, initConnectionQueries, deletedClients] = await createSocket(
      this.#rep,
      this.#queryManager,
      this.#deleteClientsManager,
      toWSString(this.#server),
      this.#connectCookie,
      this.clientID,
      await this.clientGroupID,
      this.#clientSchema,
      this.userID,
      this.#rep.auth,
      this.#lastMutationIDReceived,
      wsid,
      this.#options.logLevel === 'debug',
      lc,
      this.#options.mutateURL,
      this.#options.getQueriesURL,
      additionalConnectParams,
      await this.#activeClientsManager,
      this.#options.maxHeaderLength,
    );

    if (this.closed) {
      return;
    }

    this.#initConnectionQueries = initConnectionQueries;
    this.#deletedClients = deletedClients;
    ws.addEventListener('message', this.#onMessage);
    ws.addEventListener('open', this.#onOpen);
    ws.addEventListener('close', this.#onClose);
    this.#socket = ws;
    this.#socketResolver.resolve(ws);

    try {
      lc.debug?.('Waiting for connection to be acknowledged');
      await this.#connectResolver.promise;
      this.#mutationTracker.onConnected(this.#lastMutationIDReceived);
      // push any outstanding mutations on reconnect.
      this.#rep.push().catch(() => {});
    } finally {
      clearTimeout(timeoutID);
      this.#closeAbortController.signal.removeEventListener(
        'abort',
        abortHandler,
      );
    }
  }

  #disconnect(
    lc: ZeroLogContext,
    reason: ZeroError,
    closeCode?: CloseCode,
  ): void {
    if (shouldReportConnectError(reason)) {
      this.#connectErrorCount++;
      this.#metrics.lastConnectError.set(getLastConnectErrorValue(reason));
      this.#metrics.timeToConnectMs.set(DID_NOT_CONNECT_VALUE);
      this.#metrics.setConnectError(reason);
      if (
        this.#connectErrorCount % CHECK_CONNECTIVITY_ON_ERROR_FREQUENCY ===
        1
      ) {
        this.#checkConnectivity(`connectErrorCount=${this.#connectErrorCount}`);
      }
    }

    lc.info?.('disconnecting', {
      navigatorOnline: navigator?.onLine,
      reason: reason.kind,
      connectStart: this.#connectStart,
      totalToConnectStart: this.#totalToConnectStart,
      connectedAt: this.#connectedAt,
      connectionDuration: this.#connectedAt
        ? Date.now() - this.#connectedAt
        : 0,
      messageCount: this.#messageCount,
      connectionState: this.#connectionManager.state,
      connectErrorCount: this.#connectErrorCount,
    });

    const connectionStatus = this.#connectionManager.state.name;
    switch (connectionStatus) {
      case ConnectionStatus.Connected: {
        if (this.#connectStart !== undefined) {
          lc.error?.(
            'disconnect() called while connected but connect start time is defined.',
          );
          // this._connectStart reset below.
        }
        break;
      }
      case ConnectionStatus.Closed:
        lc.debug?.('disconnect() called while closed');
        return;

      case ConnectionStatus.Disconnected:
      case ConnectionStatus.Connecting:
      case ConnectionStatus.Error:
        break;

      default:
        unreachable(connectionStatus);
    }

    this.#socketResolver = resolver();
    lc.debug?.('Creating new connect resolver');
    this.#connectResolver = resolver();
    this.#messageCount = 0;
    this.#connectStart = undefined; // don't reset this._totalToConnectStart
    this.#connectedAt = 0;
    this.#socket?.removeEventListener('message', this.#onMessage);
    this.#socket?.removeEventListener('open', this.#onOpen);
    this.#socket?.removeEventListener('close', this.#onClose);
    this.#socket?.close(closeCode);
    this.#socket = undefined;
    this.#lastMutationIDSent = NULL_LAST_MUTATION_ID_SENT;
    this.#pokeHandler.handleDisconnect();

    const transition = getErrorConnectionTransition(reason);

    switch (transition.status) {
      case ConnectionStatus.Error:
        this.#connectionManager.error(transition.reason);
        break;
      case ConnectionStatus.Disconnected:
        this.#connectionManager.disconnected(transition.reason);
        break;
      case ConnectionStatus.Closed:
        this.#connectionManager.closed();
        break;
      case NO_STATUS_TRANSITION:
        this.#connectionManager.connecting(transition.reason);
        break;
      default:
        unreachable(transition);
    }
  }

  #handlePokeStart(_lc: ZeroLogContext, pokeMessage: PokeStartMessage): void {
    this.#abortPingTimeout();
    this.#pokeHandler.handlePokeStart(pokeMessage[1]);
  }

  #handlePokePart(_lc: ZeroLogContext, pokeMessage: PokePartMessage): void {
    this.#abortPingTimeout();
    const lastMutationIDChangeForSelf = this.#pokeHandler.handlePokePart(
      pokeMessage[1],
    );
    if (lastMutationIDChangeForSelf !== undefined) {
      this.#lastMutationIDReceived = lastMutationIDChangeForSelf;
    }
  }

  #handlePokeEnd(_lc: ZeroLogContext, pokeMessage: PokeEndMessage): void {
    this.#abortPingTimeout();
    this.#pokeHandler.handlePokeEnd(pokeMessage[1]);
  }

  #onPokeError(): void {
    const lc = this.#lc;
    lc.info?.(
      'poke error, disconnecting?',
      !this.#connectionManager.is(ConnectionStatus.Disconnected),
    );

    // It is theoretically possible that we get disconnected during the
    // async poke above. Only disconnect if we are not already
    // disconnected.
    if (!this.#connectionManager.is(ConnectionStatus.Disconnected)) {
      this.#disconnect(
        lc,
        new ClientError({
          kind: ClientErrorKind.UnexpectedBaseCookie,
          message: 'Server returned unexpected base cookie during sync',
        }),
      );
    }
  }

  #handlePullResponse(
    lc: ZeroLogContext,
    pullResponseMessage: PullResponseMessage,
  ): void {
    this.#abortPingTimeout();
    const body = pullResponseMessage[1];
    lc = lc.withContext('requestID', body.requestID);
    lc.debug?.('Handling pull response', body);
    const resolver = this.#pendingPullsByRequestID.get(body.requestID);
    if (!resolver) {
      // This can happen because resolvers are deleted
      // from this._pendingPullsByRequestID when pulls timeout.
      lc.debug?.('No resolver found');
      return;
    }
    resolver.resolve(pullResponseMessage[1]);
  }

  async #pusher(req: PushRequest, requestID: string): Promise<PusherResult> {
    // The deprecation of pushVersion 0 predates zero-client
    assert(req.pushVersion === 1);
    // If we are connecting we wait until we are connected.
    await this.#connectResolver.promise;
    const lc = this.#lc.withContext('requestID', requestID);
    lc.debug?.(`pushing ${req.mutations.length} mutations`);
    const socket = this.#socket;
    assert(socket);

    const isMutationRecoveryPush =
      req.clientGroupID !== (await this.clientGroupID);
    const start = isMutationRecoveryPush
      ? 0
      : req.mutations.findIndex(
          m =>
            m.clientID === this.#lastMutationIDSent.clientID &&
            m.id === this.#lastMutationIDSent.id,
        ) + 1;
    lc.debug?.(
      isMutationRecoveryPush ? 'pushing for recovery' : 'pushing',
      req.mutations.length - start,
      'mutations of',
      req.mutations.length,
      'mutations.',
    );
    const now = Date.now();
    for (let i = start; i < req.mutations.length; i++) {
      const m = req.mutations[i];
      const timestamp = now - Math.round(performance.now() - m.timestamp);
      const zeroM =
        m.name === CRUD_MUTATION_NAME
          ? ({
              type: MutationType.CRUD,
              timestamp,
              id: m.id,
              clientID: m.clientID,
              name: m.name,
              args: [mapCRUD(m.args as CRUDMutationArg, this.#clientToServer)],
            } satisfies CRUDMutation)
          : ({
              type: MutationType.Custom,
              timestamp,
              id: m.id,
              clientID: m.clientID,
              name: m.name,
              args: [m.args],
            } satisfies CustomMutation);
      const msg: PushMessage = [
        'push',
        {
          timestamp: now,
          clientGroupID: req.clientGroupID,
          mutations: [zeroM],
          pushVersion: req.pushVersion,
          requestID,
        },
      ];
      send(socket, msg);
      if (!isMutationRecoveryPush) {
        this.#lastMutationIDSent = {clientID: m.clientID, id: m.id};
      }
    }
    return {
      httpRequestInfo: {
        errorMessage: '',
        httpStatusCode: 200,
      },
    };
  }

  async #updateAuthToken(
    lc: ZeroLogContext,
    error?: 'invalid-token',
  ): Promise<void> {
    const {auth: authOption} = this.#options;
    const auth = await (typeof authOption === 'function'
      ? authOption(error)
      : authOption);
    if (auth) {
      lc.debug?.('Got auth token');
      this.#rep.auth = auth;
    }
  }

  async #runLoop() {
    this.#lc.info?.(`Starting Zero version: ${this.version}`);

    if (this.#server === null) {
      this.#lc.info?.('No socket origin provided, not starting connect loop.');
      this.#connectionManager.error(
        new ClientError({
          kind: ClientErrorKind.NoSocketOrigin,
          message: 'No server socket origin provided',
        }),
      );
      return;
    }

    let runLoopCounter = 0;
    const bareLogContext = this.#lc;
    const getLogContext = () => {
      let lc = bareLogContext;
      if (this.#socket) {
        lc = addWebSocketIDFromSocketToLogContext(this.#socket, lc);
      }
      return lc.withContext('runLoopCounter', runLoopCounter);
    };

    await this.#updateAuthToken(bareLogContext);

    let needsReauth = false;
    let lastReauthAttemptAt: number | undefined;
    let backoffMs: number | undefined;
    let additionalConnectParams: Record<string, string> | undefined;

    while (this.#connectionManager.shouldContinueRunLoop()) {
      runLoopCounter++;
      let lc = getLogContext();
      backoffMs = RUN_LOOP_INTERVAL_MS;

      try {
        const currentState = this.#connectionManager.state;

        switch (currentState.name) {
          case ConnectionStatus.Connecting:
          case ConnectionStatus.Disconnected: {
            if (this.#visibilityWatcher.visibilityState === 'hidden') {
              this.#metrics.setDisconnectedWaitingForVisible();
              // reset this._totalToConnectStart since this client
              // is no longer trying to connect due to being hidden.
              this.#totalToConnectStart = undefined;
            }

            // If hidden, we wait for the tab to become visible before trying again.
            // or for a state change (e.g. an error)
            const visibilityResult = await promiseRace({
              visible: this.#visibilityWatcher.waitForVisible(),
              stateChange: this.#connectionManager.waitForStateChange(),
            });

            if (visibilityResult.key === 'stateChange') {
              throwIfConnectionError(visibilityResult.result);
              break;
            }

            // If we got an auth error we try to get a new auth token before reconnecting.
            if (needsReauth) {
              lastReauthAttemptAt = Date.now();
              await this.#updateAuthToken(lc, 'invalid-token');
            }

            // If a reload is pending, do not try to reconnect.
            if (reloadScheduled()) {
              break;
            }

            await this.#connect(lc, additionalConnectParams);
            additionalConnectParams = undefined;

            throwIfConnectionError(this.#connectionManager.state);

            // Now we have a new socket, update lc with the new wsid.
            assert(this.#socket);
            lc = getLogContext();

            lc.debug?.('Connected successfully');
            needsReauth = false;
            this.#setOnline(true);
            break;
          }

          case ConnectionStatus.Connected: {
            // When connected we wait for whatever happens first out of:
            // - After PING_INTERVAL_MS we send a ping
            // - We get a message
            // - The tab becomes hidden (with a delay)
            // - We get a state change (e.g. an error or disconnect)

            const controller = new AbortController();
            this.#abortPingTimeout = () => controller.abort();
            const [pingTimeoutPromise, pingTimeoutAborted] = sleepWithAbort(
              PING_INTERVAL_MS,
              controller.signal,
            );

            const raceResult = await promiseRace({
              waitForPing: pingTimeoutPromise,
              waitForPingAborted: pingTimeoutAborted,
              tabHidden: this.#visibilityWatcher.waitForHidden(),
              stateChange: this.#connectionManager.waitForStateChange(),
            });

            switch (raceResult.key) {
              case 'waitForPing': {
                await this.#ping(lc);
                break;
              }

              case 'waitForPingAborted':
                break;

              case 'tabHidden': {
                const hiddenError = new ClientError({
                  kind: ClientErrorKind.Hidden,
                  message: 'Connection closed because tab was hidden',
                });
                this.#disconnect(lc, hiddenError);
                this.#setOnline(false);
                break;
              }

              case 'stateChange':
                throwIfConnectionError(raceResult.result);
                break;

              default:
                unreachable(raceResult);
            }

            break;
          }

          case ConnectionStatus.Error: {
            // we pause the run loop and wait for a state change
            lc.info?.(
              `Run loop paused in error state. Call zero.connection.connect() to resume.`,
              currentState.reason,
            );

            await this.#connectionManager.waitForStateChange();
            break;
          }

          case ConnectionStatus.Closed:
            // run loop will terminate
            break;

          default:
            unreachable(currentState);
        }
      } catch (ex) {
        const isClientClosedError =
          isClientError(ex) && ex.kind === ClientErrorKind.ClientClosed;

        if (
          !this.#connectionManager.is(ConnectionStatus.Connected) &&
          !isClientClosedError
        ) {
          const level = isAuthError(ex) ? 'warn' : 'error';
          const kind = isServerError(ex) ? ex.kind : 'Unknown Error';
          lc[level]?.('Failed to connect', ex, kind, {
            lmid: this.#lastMutationIDReceived,
            baseCookie: this.#connectCookie,
          });
        }

        lc.debug?.(
          'Got an exception in the run loop',
          'state:',
          this.#connectionManager.state,
          'exception:',
          ex,
        );

        const transition = getErrorConnectionTransition(ex);

        switch (transition.status) {
          case NO_STATUS_TRANSITION: {
            // We continue the loop because the error does not indicate
            // a need to transition to a new state and we should continue retrying

            const backoffParams = getBackoffParams(transition.reason);
            if (backoffParams) {
              if (backoffParams.minBackoffMs !== undefined) {
                backoffMs = Math.max(backoffMs, backoffParams.minBackoffMs);
              }
              if (backoffParams.maxBackoffMs !== undefined) {
                backoffMs = Math.min(backoffMs, backoffParams.maxBackoffMs);
              }
              additionalConnectParams = backoffParams.reconnectParams;
            }

            // Only authentication errors are retried immediately the first time they
            // occur. All other errors wait a few seconds before retrying the first
            // time. We specifically do not use a backoff for consecutive errors
            // because it's a bad experience to wait many seconds for reconnection.
            if (isAuthError(transition.reason)) {
              const now = Date.now();
              const msSinceLastReauthAttempt =
                lastReauthAttemptAt === undefined
                  ? Number.POSITIVE_INFINITY
                  : now - lastReauthAttemptAt;
              needsReauth = true;
              if (msSinceLastReauthAttempt > RUN_LOOP_INTERVAL_MS) {
                // First auth error (or first in a while), try right away without waiting.
                continue;
              }
            }

            this.#setOnline(false);

            lc.debug?.(
              'Sleeping',
              backoffMs,
              'ms before reconnecting due to error, state:',
              this.#connectionManager.state,
            );
            await sleep(backoffMs);
            break;
          }
          case ConnectionStatus.Error: {
            lc.debug?.('Fatal error encountered, transitioning to error state');
            this.#setOnline(false);
            this.#connectionManager.error(transition.reason);
            // run loop will enter the error state case and await a state change
            break;
          }
          case ConnectionStatus.Disconnected: {
            this.#setOnline(false);
            this.#connectionManager.disconnected(transition.reason);
            break;
          }
          case ConnectionStatus.Closed: {
            this.#setOnline(false);
            break;
          }
          default:
            unreachable(transition);
        }
      }
    }
  }

  async #puller(req: PullRequest, requestID: string): Promise<PullerResult> {
    // The deprecation of pushVersion 0 predates zero-client
    assert(req.pullVersion === 1);
    const lc = this.#lc.withContext('requestID', requestID);
    lc.debug?.('Pull', req);
    // Pull request for this instance's client group.  A no-op response is
    // returned as pulls for this client group are handled via poke over the
    // socket.
    if (req.clientGroupID === (await this.clientGroupID)) {
      return {
        httpRequestInfo: {
          errorMessage: '',
          httpStatusCode: 200,
        },
      };
    }

    // If we are connecting we wait until we are connected.
    await this.#connectResolver.promise;
    const socket = this.#socket;
    assert(socket);
    // Mutation recovery pull.
    lc.debug?.('Pull is for mutation recovery');
    const cookie = valita.parse(
      req.cookie,
      nullableVersionSchema,
      'passthrough',
    );
    const pullRequestMessage: PullRequestMessage = [
      'pull',
      {
        clientGroupID: req.clientGroupID,
        cookie,
        requestID,
      },
    ];
    send(socket, pullRequestMessage);
    const pullResponseResolver: Resolver<PullResponseBody> = resolver();
    this.#pendingPullsByRequestID.set(requestID, pullResponseResolver);
    try {
      const raceResult = await promiseRace({
        timeout: sleep(PULL_TIMEOUT_MS),
        success: pullResponseResolver.promise,
      });
      switch (raceResult.key) {
        case 'timeout':
          lc.debug?.('Mutation recovery pull timed out');
          throw new ClientError({
            kind: ClientErrorKind.PullTimeout,
            message: 'Pull timed out',
          });
        case 'success': {
          lc.debug?.('Returning mutation recovery pull response');
          const response = await pullResponseResolver.promise;
          return {
            response: {
              cookie: response.cookie,
              lastMutationIDChanges: response.lastMutationIDChanges,
              patch: [],
            },
            httpRequestInfo: {
              errorMessage: '',
              httpStatusCode: 200,
            },
          };
        }
        default:
          unreachable(raceResult);
      }
    } finally {
      pullResponseResolver.reject(
        new ClientError({
          kind: ClientErrorKind.PullTimeout,
          message: 'Pull timed out',
        }),
      );
      this.#pendingPullsByRequestID.delete(requestID);
    }
  }

  #setOnline(online: boolean): void {
    this.#onlineManager.setOnline(online);
  }

  /**
   * A rough heuristic for whether the client is currently online and
   * authenticated.
   *
   * @deprecated Use `connection` instead, which provides more detailed connection state.
   */
  get online(): boolean {
    return this.#onlineManager.online;
  }

  /**
   * Subscribe to online status changes.
   *
   * This is useful when you want to update state based on the online status.
   *
   * @param listener - The listener to subscribe to.
   * @returns A function to unsubscribe the listener.
   *
   * @deprecated Use `connection` instead, which provides more detailed connection state.
   */
  onOnline = (listener: (online: boolean) => void): (() => void) =>
    this.#onlineManager.subscribe(listener);

  /**
   * Starts a ping and waits for a pong.
   */
  async #ping(lc: ZeroLogContext): Promise<void> {
    lc.debug?.('pinging');
    const {promise, resolve} = resolver();
    this.#onPong = resolve;
    const pingMessage: PingMessage = ['ping', {}];
    const t0 = performance.now();
    assert(this.#socket);
    send(this.#socket, pingMessage);

    const raceResult = await promiseRace({
      waitForPong: promise,
      pingTimeout: sleep(PING_TIMEOUT_MS),
      stateChange: this.#connectionManager.waitForStateChange(),
    });

    const delta = performance.now() - t0;
    switch (raceResult.key) {
      case 'waitForPong': {
        lc.debug?.('ping succeeded in', delta, 'ms');
        return;
      }

      case 'pingTimeout': {
        lc.info?.('ping failed in', delta, 'ms - disconnecting');
        const pingTimeoutError = new ClientError({
          kind: ClientErrorKind.PingTimeout,
          message: 'Server ping request failed',
        });
        this.#disconnect(lc, pingTimeoutError);
        throw pingTimeoutError;
      }

      case 'stateChange': {
        lc.debug?.(
          'ping aborted due to connection state change',
          raceResult.result,
        );
        throwIfConnectionError(raceResult.result);
        break;
      }

      default:
        unreachable(raceResult);
    }
  }

  // Sends a set of metrics to the server. Throws unless the server
  // returns 200.
  // TODO: Reenable metrics reporting
  async #reportMetrics(_allSeries: Series[]) {
    // if (this.#server === null) {
    //   this.#lc.info?.('Skipping metrics report, socketOrigin is null');
    //   return;
    // }
    // const body = JSON.stringify({series: allSeries});
    // const url = new URL('/api/metrics/v0/report', this.#server);
    // url.searchParams.set('clientID', this.clientID);
    // url.searchParams.set('clientGroupID', await this.clientGroupID);
    // url.searchParams.set('userID', this.userID);
    // url.searchParams.set('requestID', nanoid());
    // const res = await fetch(url.toString(), {
    //   method: 'POST',
    //   body,
    //   keepalive: true,
    // });
    // if (!res.ok) {
    //   const maybeBody = await res.text();
    //   throw new Error(
    //     `unexpected response: ${res.status} ${res.statusText} body: ${maybeBody}`,
    //   );
    // }
  }

  #checkConnectivity(reason: string) {
    void this.#checkConnectivityAsync(reason);
  }

  #checkConnectivityAsync(_reason: string) {
    // skipping connectivity checks for now - the server doesn't respond to
    // them so it just creates noise.
    // assert(this.#server);
    // if (this.closed) {
    //   return;
    // }
    // try {
    //   await checkConnectivity(
    //     reason,
    //     this.#server,
    //     this.#lc,
    //     this.#closeAbortController.signal,
    //     this.#enableAnalytics,
    //   );
    // } catch (e) {
    //   this.#lc.info?.('Error checking connectivity for', reason, e);
    // }
  }

  #registerQueries(schema: Schema): MakeEntityQueriesFromSchema<S> {
    const rv = {} as Record<string, Query<Schema, string>>;
    const context = this.#zeroContext;
    // Not using parse yet
    for (const name of Object.keys(schema.tables)) {
      rv[name] = newQuery(context, schema, name);
    }

    return rv as MakeEntityQueriesFromSchema<S>;
  }

  /**
   * `inspector` is an object that can be used to inspect the state of the
   * queries a Zero instance uses. It is intended for debugging purposes.
   */
  get inspector(): Inspector {
    // We use esbuild dropLabels to strip this code when we build the code for the bundle size dashboard.
    // https://esbuild.github.io/api/#ignore-annotations
    // /packages/zero/tool/build.ts

    // oxlint-disable-next-line no-unused-labels
    BUNDLE_SIZE: {
      return (this.#inspector ??= new Inspector(
        this.#rep,
        this.#queryManager,
        async () => {
          await this.#connectResolver.promise;
          return this.#socket!;
        },
      ));
    }
  }

  #addMetric: <K extends keyof MetricMap>(
    metric: K,
    value: number,
    ...args: MetricMap[K]
  ) => void = (metric, value, ...args) => {
    assert(isClientMetric(metric), `Invalid metric: ${metric}`);
    this.#queryManager.addMetric(
      metric as keyof ClientMetricMap,
      value,
      ...(args as ClientMetricMap[keyof ClientMetricMap]),
    );
  };
}

export class OnlineManager extends Subscribable<boolean> {
  #online = false;

  setOnline(online: boolean): void {
    if (this.#online === online) {
      return;
    }
    this.#online = online;
    this.notify(online);
  }

  get online(): boolean {
    return this.#online;
  }
}

export async function createSocket(
  rep: ReplicacheImpl,
  queryManager: QueryManager,
  deleteClientsManager: DeleteClientsManager,
  socketOrigin: WSString,
  baseCookie: NullableVersion,
  clientID: string,
  clientGroupID: string,
  clientSchema: ClientSchema,
  userID: string,
  auth: string | undefined,
  lmid: number,
  wsid: string,
  debugPerf: boolean,
  lc: ZeroLogContext,
  userPushURL: string | undefined,
  userQueryURL: string | undefined,
  additionalConnectParams: Record<string, string> | undefined,
  activeClientsManager: Pick<ActiveClientsManager, 'activeClients'>,
  maxHeaderLength = 1024 * 8,
): Promise<
  [
    WebSocket,
    Map<string, UpQueriesPatchOp> | undefined,
    DeleteClientsBody | undefined,
  ]
> {
  const url = new URL(
    appendPath(socketOrigin, `/sync/v${PROTOCOL_VERSION}/connect`),
  );
  const {searchParams} = url;
  searchParams.set('clientID', clientID);
  searchParams.set('clientGroupID', clientGroupID);
  searchParams.set('userID', userID);
  searchParams.set('baseCookie', baseCookie === null ? '' : String(baseCookie));
  searchParams.set('ts', String(performance.now()));
  searchParams.set('lmid', String(lmid));
  searchParams.set('wsid', wsid);
  if (debugPerf) {
    searchParams.set('debugPerf', true.toString());
  }
  if (additionalConnectParams) {
    for (const k in additionalConnectParams) {
      if (searchParams.has(k)) {
        lc.warn?.(`skipping conflicting parameter ${k}`);
      } else {
        searchParams.set(k, additionalConnectParams[k]);
      }
    }
  }

  lc.info?.('Connecting to', url.toString());

  // Pass auth to the server via the `Sec-WebSocket-Protocol` header by passing
  // it as a `protocol` to the `WebSocket` constructor.  The empty string is an
  // invalid `protocol`, and will result in an exception, so pass undefined
  // instead.  encodeURIComponent to ensure it only contains chars allowed
  // for a `protocol`.
  const WS = mustGetBrowserGlobal('WebSocket');
  const queriesPatchP = rep.query(tx => queryManager.getQueriesPatch(tx));
  const deletedClientsArray = await deleteClientsManager.getDeletedClients();
  let deletedClients: DeleteClientsBody | undefined =
    convertDeletedClientsToBody(deletedClientsArray, clientGroupID);
  let queriesPatch: Map<string, UpQueriesPatchOp> | undefined =
    await queriesPatchP;
  const {activeClients} = activeClientsManager;

  let secProtocol = encodeSecProtocols(
    [
      'initConnection',
      {
        desiredQueriesPatch: [...queriesPatch.values()],
        deleted: skipEmptyDeletedClients(deletedClients),
        // The clientSchema only needs to be sent for the very first request.
        // Henceforth it is stored with the CVR and verified automatically.
        ...(baseCookie === null ? {clientSchema} : {}),
        userPushURL,
        userQueryURL,
        activeClients: [...activeClients],
      },
    ],
    auth,
  );
  if (secProtocol.length > maxHeaderLength) {
    secProtocol = encodeSecProtocols(undefined, auth);
    if (secProtocol.length > maxHeaderLength) {
      lc.warn?.(
        `Encoded auth token length (${secProtocol.length}) exceeds ` +
          `ZeroOptions.maxHeaderLength (${maxHeaderLength}). This may ` +
          `cause connection failures.`,
      );
    }
    queriesPatch = undefined;
  } else {
    deletedClients = undefined;
  }
  return [
    new WS(
      // toString() required for RN URL polyfill.
      url.toString(),
      secProtocol,
    ),
    queriesPatch,
    skipEmptyDeletedClients(deletedClients),
  ];
}

function skipEmptyArray<T>(
  arr: readonly T[] | undefined,
): readonly T[] | undefined {
  return arr && arr.length > 0 ? arr : undefined;
}

function skipEmptyDeletedClients(
  deletedClients: DeleteClientsBody | undefined,
): DeleteClientsBody | undefined {
  if (!deletedClients) {
    return undefined;
  }
  const {clientIDs, clientGroupIDs} = deletedClients;
  if (
    (!clientIDs || clientIDs.length === 0) &&
    (!clientGroupIDs || clientGroupIDs.length === 0)
  ) {
    return undefined;
  }
  const data: Writable<DeleteClientsBody> = {};
  data.clientIDs = skipEmptyArray(clientIDs);
  data.clientGroupIDs = skipEmptyArray(clientGroupIDs);
  return data;
}

function convertDeletedClientsToBody(
  deletedClients: DeletedClients,
  clientGroupID: ClientGroupID,
): DeleteClientsBody | undefined {
  if (deletedClients.length === 0) {
    return undefined;
  }

  const clientIDs = deletedClients
    .filter(pair => pair.clientID && pair.clientGroupID === clientGroupID)
    .map(pair => pair.clientID);
  if (clientIDs.length === 0) {
    return undefined;
  }

  // We no longer send clientGroupIDs
  return {clientIDs};
}

/**
 * Adds the wsid query parameter to the log context. If the URL does not
 * have a wsid we use a randomID instead.
 */
function addWebSocketIDFromSocketToLogContext(
  {url}: {url: string},
  lc: ZeroLogContext,
): ZeroLogContext {
  const wsid = new URL(url).searchParams.get('wsid') ?? nanoid();
  return addWebSocketIDToLogContext(wsid, lc);
}

function addWebSocketIDToLogContext(
  wsid: string,
  lc: ZeroLogContext,
): ZeroLogContext {
  return lc.withContext('wsid', wsid);
}

function assertValidRunOptions(_options?: RunOptions): void {}

async function makeActiveClientsManager(
  clientGroupID: Promise<string>,
  clientID: string,
  signal: AbortSignal,
  onDelete: ActiveClientsManager['onDelete'],
): Promise<ActiveClientsManager> {
  const manager = await ActiveClientsManager.create(
    await clientGroupID,
    clientID,
    signal,
  );
  manager.onDelete = onDelete;
  return manager;
}
