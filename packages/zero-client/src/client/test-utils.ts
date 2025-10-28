import type {LogLevel} from '@rocicorp/logger';
import {resolver} from '@rocicorp/resolver';
import {nanoid} from '../util/nanoid.ts';
// import {type VitestUtils} from 'vitest';
import type {Store} from '../../../replicache/src/dag/store.ts';
import {assert} from '../../../shared/src/asserts.ts';
import type {JSONValue} from '../../../shared/src/json.ts';
import {TestLogSink} from '../../../shared/src/logging-test-utils.ts';
import type {ConnectedMessage} from '../../../zero-protocol/src/connect.ts';
import type {Downstream} from '../../../zero-protocol/src/down.ts';
import {ErrorKind} from '../../../zero-protocol/src/error-kind.ts';
import type {
  ErrorBody,
  ErrorMessage,
} from '../../../zero-protocol/src/error.ts';
import type {
  PokeEndBody,
  PokeEndMessage,
  PokePartBody,
  PokePartMessage,
  PokeStartBody,
  PokeStartMessage,
} from '../../../zero-protocol/src/poke.ts';
import type {PongMessage} from '../../../zero-protocol/src/pong.ts';
import type {
  PullResponseBody,
  PullResponseMessage,
} from '../../../zero-protocol/src/pull.ts';
import type {
  PushResponseBody,
  PushResponseMessage,
} from '../../../zero-protocol/src/push.ts';
import {upstreamSchema} from '../../../zero-protocol/src/up.ts';
import type {Schema} from '../../../zero-schema/src/builder/schema-builder.ts';
import type {PullRow, Query} from '../../../zql/src/query/query.ts';
import type {ConnectionState} from './connection-manager.ts';
import {ConnectionStatus} from './connection-status.ts';
import type {CustomMutatorDefs} from './custom.ts';
import type {LogOptions} from './log-options.ts';
import type {ZeroOptions} from './options.ts';
import {
  Zero,
  createLogOptionsSymbol,
  exposedToTestingSymbol,
  getInternalReplicacheImplForTesting,
  type TestingContext,
} from './zero.ts';

// Do not use an import statement here because vitest will then load that file
// which does not work in a worker context.
type VitestUtils = import('vitest').VitestUtils;

export async function tickAFewTimes(vi: VitestUtils, duration = 100) {
  const n = 10;
  const t = Math.ceil(duration / n);
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(t);
  }
}

export class MockSocket extends EventTarget {
  readonly url: string | URL;
  protocol: string;
  messages: string[] = [];
  closed = false;
  #listeners = new Set<(message: string) => void>();

  constructor(url: string | URL, protocol = '') {
    super();
    this.url = url;
    this.protocol = protocol;
  }

  get jsonMessages(): JSONValue[] {
    return this.messages.map(message => JSON.parse(message));
  }

  send(message: string) {
    this.messages.push(message);
    for (const listener of this.#listeners) {
      listener(message);
    }
  }

  onUpstream(callback: (message: string) => void): () => void {
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  close() {
    this.closed = true;
    this.dispatchEvent(new CloseEvent('close'));
  }
}

export class TestZero<
  const S extends Schema,
  MD extends CustomMutatorDefs | undefined = undefined,
> extends Zero<S, MD> {
  pokeIDCounter = 0;

  #connectionStatusResolvers: Set<{
    state: ConnectionStatus;
    resolve: (state: ConnectionStatus) => void;
  }> = new Set();

  get perdag(): Store {
    return getInternalReplicacheImplForTesting(this).perdag;
  }

  get connectionStatus(): ConnectionStatus {
    assert(TESTING);
    return this[exposedToTestingSymbol].connectionManager().state.name;
  }

  get connectionState(): ConnectionState {
    assert(TESTING);
    return this[exposedToTestingSymbol].connectionManager().state;
  }

  get connectingStart() {
    return this[exposedToTestingSymbol].connectStart;
  }

  constructor(options: ZeroOptions<S, MD>) {
    super(options);

    // Subscribe to connection manager to handle connection state change notifications
    this[exposedToTestingSymbol].connectionManager().subscribe(state => {
      for (const entry of this.#connectionStatusResolvers) {
        const {state: expectedState, resolve} = entry;
        if (expectedState === state.name) {
          this.#connectionStatusResolvers.delete(entry);
          resolve(state.name);
        }
      }
    });
  }

  [createLogOptionsSymbol](options: {consoleLogLevel: LogLevel}): LogOptions {
    assert(TESTING);
    return {
      logLevel: options.consoleLogLevel,
      logSink: new TestLogSink(),
    };
  }

  get testLogSink(): TestLogSink {
    assert(TESTING);
    const {logSink} = this[exposedToTestingSymbol].logOptions;
    assert(logSink instanceof TestLogSink);
    return logSink;
  }

  waitForConnectionStatus(state: ConnectionStatus) {
    if (this.connectionStatus === state) {
      return Promise.resolve(state);
    }
    const {promise, resolve} = resolver<ConnectionStatus>();
    this.#connectionStatusResolvers.add({state, resolve});
    return promise;
  }

  subscribeToConnectionStatus(listener: (state: ConnectionState) => void) {
    return this[exposedToTestingSymbol].connectionManager().subscribe(state => {
      listener(state);
    });
  }

  get socket(): Promise<MockSocket> {
    return this[exposedToTestingSymbol].socketResolver()
      .promise as Promise<unknown> as Promise<MockSocket>;
  }

  async triggerMessage(data: Downstream): Promise<void> {
    const socket = await this.socket;
    assert(!socket.closed);
    socket.dispatchEvent(
      new MessageEvent('message', {data: JSON.stringify(data)}),
    );
  }

  async triggerConnected(): Promise<void> {
    const msg: ConnectedMessage = ['connected', {wsid: 'wsidx'}];
    await this.triggerMessage(msg);
    await this.waitForConnectionStatus(ConnectionStatus.Connected);
  }

  triggerPong(): Promise<void> {
    const msg: PongMessage = ['pong', {}];
    return this.triggerMessage(msg);
  }

  triggerPokeStart(pokeStartBody: PokeStartBody): Promise<void> {
    const msg: PokeStartMessage = ['pokeStart', pokeStartBody];
    return this.triggerMessage(msg);
  }

  triggerPokePart(pokePart: PokePartBody): Promise<void> {
    const msg: PokePartMessage = ['pokePart', pokePart];
    return this.triggerMessage(msg);
  }

  triggerPokeEnd(pokeEnd: PokeEndBody): Promise<void> {
    const msg: PokeEndMessage = ['pokeEnd', pokeEnd];
    return this.triggerMessage(msg);
  }

  async triggerPoke(
    cookieStart: string | null,
    cookieEnd: string,
    pokePart: Omit<PokePartBody, 'pokeID'>,
  ): Promise<void> {
    const id = `${this.pokeIDCounter++}`;
    await this.triggerPokeStart({
      pokeID: id,
      baseCookie: cookieStart,
    });
    await this.triggerPokePart({
      ...pokePart,
      pokeID: id,
    });
    await this.triggerPokeEnd({
      pokeID: id,
      cookie: cookieEnd,
    });
  }

  triggerPullResponse(pullResponseBody: PullResponseBody): Promise<void> {
    const msg: PullResponseMessage = ['pull', pullResponseBody];
    return this.triggerMessage(msg);
  }

  triggerPushResponse(pushResponseBody: PushResponseBody): Promise<void> {
    const msg: PushResponseMessage = ['pushResponse', pushResponseBody];
    return this.triggerMessage(msg);
  }

  triggerError(kind: ErrorKind, message: string, body = {}): Promise<void> {
    const msg: ErrorMessage = ['error', {kind, message, ...body} as ErrorBody];
    return this.triggerMessage(msg);
  }

  async triggerClose(): Promise<void> {
    const socket = await this.socket;
    socket.dispatchEvent(new CloseEvent('close'));
  }

  async triggerGotQueriesPatch(
    q: Query<S, keyof S['tables'] & string>,
  ): Promise<void> {
    q.hash();
    await this.triggerPoke(null, '1', {
      gotQueriesPatch: [
        {
          op: 'put',
          hash: q.hash(),
        },
      ],
    });
  }

  declare [exposedToTestingSymbol]: TestingContext;

  get pusher() {
    assert(TESTING);
    return this[exposedToTestingSymbol].pusher;
  }

  get puller() {
    assert(TESTING);
    return this[exposedToTestingSymbol].puller;
  }

  set reload(r: () => void) {
    assert(TESTING);
    this[exposedToTestingSymbol].setReload(r);
  }

  persist(): Promise<void> {
    return getInternalReplicacheImplForTesting(this).persist();
  }

  markQueryAsGot<
    TSchema extends Schema,
    TTable extends keyof TSchema['tables'] & string,
    TReturn = PullRow<TTable, TSchema>,
  >(q: Query<TSchema, TTable, TReturn>): Promise<void> {
    // TODO(arv): The cookies here could be better... Not sure if the client
    // ever checks these?
    return this.triggerPoke(null, '1', {
      gotQueriesPatch: [
        {
          op: 'put',
          hash: q.hash(),
        },
      ],
    });
  }
}

declare const TESTING: boolean;

let testZeroCounter = 0;

export function zeroForTest<
  const S extends Schema,
  MD extends CustomMutatorDefs | undefined = undefined,
>(
  options: Partial<ZeroOptions<S, MD>> = {},
  errorOnUpdateNeeded = true,
): TestZero<S, MD> {
  // Special case kvStore. If not present we default to 'mem'. This allows
  // passing `undefined` to get the default behavior.
  const newOptions = {...options};
  if (!('kvStore' in options)) {
    newOptions.kvStore = 'mem';
  }

  return new TestZero({
    server: 'https://example.com/',
    // Make sure we do not reuse IDB instances between tests by default
    userID: options.userID ?? 'test-user-id-' + testZeroCounter++,
    auth: () => 'test-auth',
    schema: options.schema ?? ({tables: {}} as S),
    // We do not want any unexpected onUpdateNeeded calls in tests. If the test
    // needs to call onUpdateNeeded it should set this as needed.
    onUpdateNeeded: errorOnUpdateNeeded
      ? reason => {
          throw new Error(`Unexpected update needed: ${reason.type}`);
        }
      : undefined,
    ...newOptions,
  } satisfies ZeroOptions<S, MD>);
}

export async function waitForUpstreamMessage(
  r: TestZero<Schema>,
  name: string,
  vi: VitestUtils,
) {
  let gotMessage = false;
  const socket = await r.socket;
  const cleanup = socket.onUpstream(message => {
    const v = JSON.parse(message);
    const [kind] = upstreamSchema.parse(v);
    if (kind === name) {
      gotMessage = true;
    }
  });
  for (;;) {
    await vi.advanceTimersByTimeAsync(100);
    if (gotMessage) {
      cleanup();
      break;
    }
  }
}

export function storageMock(storage: Record<string, string>): Storage {
  return {
    setItem: (key, value) => {
      storage[key] = value || '';
    },
    getItem: key => (key in storage ? storage[key] : null),
    removeItem: key => {
      delete storage[key];
    },
    clear: () => {
      for (const key of Object.keys(storage)) {
        delete storage[key];
      }
    },
    get length() {
      return Object.keys(storage).length;
    },
    key: i => {
      const keys = Object.keys(storage);
      return keys[i] || null;
    },
  };
}

// postMessage uses a message queue. By adding another message to the queue,
// we can ensure that the first message is processed before the second one.
export function waitForPostMessage() {
  return new Promise<void>(resolve => {
    const name = nanoid();
    const c1 = new BroadcastChannel(name);
    const c2 = new BroadcastChannel(name);
    c2.postMessage('');
    c1.onmessage = () => {
      c1.close();
      c2.close();
      resolve();
    };
  });
}
