import {resolver} from '@rocicorp/resolver';
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {createSilentLogContext} from '../../../../shared/src/logging-test-utils.ts';
import type {
  Mutation,
  PushBody,
  PushResponse,
} from '../../../../zero-protocol/src/push.ts';
import type {PostgresDB} from '../../types/pg.ts';
import {combinePushes, PusherService} from './pusher.ts';
import {ErrorOrigin} from '../../../../zero-protocol/src/error-origin.ts';
import type {PushFailedBody} from '../../../../zero-protocol/src/error.ts';
import {ErrorKind} from '../../../../zero-protocol/src/error-kind.ts';
import {ErrorReason} from '../../../../zero-protocol/src/error-reason.ts';
import {ProtocolErrorWithLevel} from '../../types/error-with-level.ts';

const config = {
  app: {
    id: 'zero',
    publications: [],
  },
  shard: {
    id: 'zero',
    num: 0,
  },
};

const clientID = 'test-cid';
const wsID = 'test-wsid';
const mockDB = (() => {}) as unknown as PostgresDB;

describe('combine pushes', () => {
  test('empty array', () => {
    const [pushes, terminate] = combinePushes([]);
    expect(pushes).toEqual([]);
    expect(terminate).toBe(false);
  });

  test('stop', () => {
    const [pushes, terminate] = combinePushes([undefined]);
    expect(pushes).toEqual([]);
    expect(terminate).toBe(true);
  });

  test('stop after pushes', () => {
    const [pushes, terminate] = combinePushes([
      {
        push: makePush(1),
        jwt: 'a',
        httpCookie: undefined,

        clientID,
      },
      {
        push: makePush(1),
        jwt: 'a',
        httpCookie: undefined,

        clientID,
      },
      undefined,
    ]);
    expect(pushes).toHaveLength(1);
    expect(terminate).toBe(true);
  });

  test('stop in the middle', () => {
    const [pushes, terminate] = combinePushes([
      {
        push: makePush(1),
        jwt: 'a',
        httpCookie: undefined,

        clientID,
      },
      undefined,
      {
        push: makePush(1),
        jwt: 'a',
        httpCookie: undefined,

        clientID,
      },
    ]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].push.mutations).toHaveLength(1);
    expect(pushes[0].push.mutations[0].id).toBe(1);
    expect(terminate).toBe(true);
  });

  test('combines pushes for same clientID', () => {
    const [pushes, terminate] = combinePushes([
      {
        push: makePush(1, 'client1'),
        jwt: 'a',
        httpCookie: undefined,
        clientID: 'client1',
      },
      {
        push: makePush(2, 'client1'),
        jwt: 'a',
        httpCookie: undefined,
        clientID: 'client1',
      },
      {
        push: makePush(1, 'client2'),
        jwt: 'b',
        httpCookie: undefined,
        clientID: 'client2',
      },
    ]);

    expect(pushes).toHaveLength(2);
    expect(terminate).toBe(false);

    // Verify client1's pushes are combined
    const client1Push = pushes.find(p => p.clientID === 'client1');
    expect(client1Push).toBeDefined();
    expect(client1Push?.push.mutations).toHaveLength(3); // 1 + 2 mutations

    // Verify client2's push is separate
    const client2Push = pushes.find(p => p.clientID === 'client2');
    expect(client2Push).toBeDefined();
    expect(client2Push?.push.mutations).toHaveLength(1);
  });

  test('throws on jwt mismatch for same client', () => {
    expect(() =>
      combinePushes([
        {
          push: makePush(1, 'client1'),
          jwt: 'a',
          httpCookie: undefined,
          clientID: 'client1',
        },
        {
          push: makePush(2, 'client1'),
          jwt: 'b',
          httpCookie: undefined, // Different JWT
          clientID: 'client1',
        },
      ]),
    ).toThrow('jwt must be the same for all pushes with the same clientID');
  });

  test('throws on schema version mismatch for same client', () => {
    expect(() =>
      combinePushes([
        {
          push: {
            ...makePush(1, 'client1'),
            schemaVersion: 1,
          },
          jwt: 'a',
          httpCookie: undefined,
          clientID: 'client1',
        },
        {
          push: {
            ...makePush(2, 'client1'),
            schemaVersion: 2, // Different schema version
          },
          jwt: 'a',
          httpCookie: undefined,
          clientID: 'client1',
        },
      ]),
    ).toThrow(
      'schemaVersion must be the same for all pushes with the same clientID',
    );
  });

  test('throws on push version mismatch for same client', () => {
    expect(() =>
      combinePushes([
        {
          push: {
            ...makePush(1, 'client1'),
            pushVersion: 1,
          },
          jwt: 'a',
          httpCookie: undefined,
          clientID: 'client1',
        },
        {
          push: {
            ...makePush(2, 'client1'),
            pushVersion: 2, // Different push version
          },
          jwt: 'a',
          httpCookie: undefined,
          clientID: 'client1',
        },
      ]),
    ).toThrow(
      'pushVersion must be the same for all pushes with the same clientID',
    );
  });

  test('combines compatible pushes with same schema version and push version', () => {
    const [pushes, terminate] = combinePushes([
      {
        push: {
          ...makePush(1, 'client1'),
          schemaVersion: 1,
          pushVersion: 1,
        },
        jwt: 'a',
        httpCookie: undefined,
        clientID: 'client1',
      },
      {
        push: {
          ...makePush(2, 'client1'),
          schemaVersion: 1,
          pushVersion: 1,
        },
        jwt: 'a',
        httpCookie: undefined,
        clientID: 'client1',
      },
    ]);

    expect(pushes).toHaveLength(1);
    expect(terminate).toBe(false);
    expect(pushes[0].push.mutations).toHaveLength(3);
  });

  test('handles multiple clients with multiple pushes', () => {
    const [pushes, terminate] = combinePushes([
      {
        push: makePush(1, 'client1'),
        jwt: 'a',
        httpCookie: undefined,
        clientID: 'client1',
      },
      {
        push: makePush(2, 'client2'),
        jwt: 'b',
        httpCookie: undefined,
        clientID: 'client2',
      },
      {
        push: makePush(1, 'client1'),
        jwt: 'a',
        httpCookie: undefined,
        clientID: 'client1',
      },
      {
        push: makePush(3, 'client2'),
        jwt: 'b',
        httpCookie: undefined,
        clientID: 'client2',
      },
    ]);

    expect(pushes).toHaveLength(2);
    expect(terminate).toBe(false);

    // Verify client1's pushes are combined
    const client1Push = pushes.find(p => p.clientID === 'client1');
    expect(client1Push?.push.mutations).toHaveLength(2);

    // Verify client2's pushes are combined
    const client2Push = pushes.find(p => p.clientID === 'client2');
    expect(client2Push?.push.mutations).toHaveLength(5);
  });

  test('preserves mutation order within client', () => {
    const [pushes] = combinePushes([
      {
        push: makePush(1, 'client1'),
        jwt: 'a',
        httpCookie: undefined,
        clientID: 'client1',
      },
      {
        push: makePush(1, 'client2'),
        jwt: 'b',
        httpCookie: undefined,
        clientID: 'client2',
      },
      {
        push: makePush(1, 'client1'),
        jwt: 'a',
        httpCookie: undefined,
        clientID: 'client1',
      },
    ]);

    const client1Push = pushes.find(p => p.clientID === 'client1');
    expect(client1Push?.push.mutations[0].id).toBeLessThan(
      client1Push?.push.mutations[1].id || 0,
    );
  });
});

const lc = createSilentLogContext();
describe('pusher service', () => {
  test('the service can be stopped', async () => {
    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    let shutDown = false;
    void pusher.run().then(() => {
      shutDown = true;
    });
    await pusher.stop();
    expect(shutDown).toBe(true);
  });

  test('the service sets authorization headers', async () => {
    const fetch = (global.fetch = vi.fn());
    fetch.mockResolvedValue({
      ok: true,
    });

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();
    pusher.initConnection(clientID, wsID, undefined);

    pusher.enqueuePush(clientID, makePush(1), 'jwt', undefined);

    await pusher.stop();

    expect(fetch.mock.calls[0][1]?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Api-Key': 'api-key',
      'Authorization': 'Bearer jwt',
    });

    fetch.mockReset();
  });

  test('the service sends the app id and schema over the query params', async () => {
    const fetch = (global.fetch = vi.fn());
    fetch.mockResolvedValue({
      ok: true,
    });

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();
    pusher.initConnection(clientID, wsID, undefined);

    pusher.enqueuePush(clientID, makePush(1), 'jwt', undefined);

    await pusher.stop();

    expect(fetch.mock.calls[0][0]).toMatchInlineSnapshot(
      `"http://example.com/?schema=zero_0&appID=zero"`,
    );

    fetch.mockReset();
  });

  test('the service correctly batches pushes when the API server is delayed', async () => {
    const fetch = (global.fetch = vi.fn());
    const apiServerReturn = resolver();
    fetch.mockImplementation(async (_url: string, _options: RequestInit) => {
      await apiServerReturn.promise;
    });

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );

    void pusher.run();
    pusher.initConnection(clientID, wsID, undefined);
    pusher.enqueuePush(clientID, makePush(1), 'jwt', undefined);
    // release control of the loop so the push can be sent
    await Promise.resolve();

    // We should have sent the first push
    expect(fetch.mock.calls).toHaveLength(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).mutations).toHaveLength(1);

    // We have not resolved the API server yet so these should stack up
    pusher.enqueuePush(clientID, makePush(1), 'jwt', undefined);
    await Promise.resolve();
    pusher.enqueuePush(clientID, makePush(1), 'jwt', undefined);
    await Promise.resolve();
    pusher.enqueuePush(clientID, makePush(1), 'jwt', undefined);
    await Promise.resolve();

    // no new pushes sent yet since we are still waiting on the user's API server
    expect(fetch.mock.calls).toHaveLength(1);

    // let the API server go
    apiServerReturn.resolve();
    // wait for the pusher to finish
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    // We sent all the pushes in one batch
    expect(JSON.parse(fetch.mock.calls[1][1].body).mutations).toHaveLength(3);
    expect(fetch.mock.calls).toHaveLength(2);
  });

  test('the service does not forward cookies if forwardCookies is false', async () => {
    const fetch = (global.fetch = vi.fn());
    fetch.mockResolvedValue({
      ok: true,
    });

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();
    pusher.initConnection(clientID, wsID, undefined);

    pusher.enqueuePush(clientID, makePush(1), 'jwt', 'my-cookie');

    await pusher.stop();

    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty('Cookie');
  });

  test('the service forwards cookies if forwardCookies is true', async () => {
    const fetch = (global.fetch = vi.fn());
    fetch.mockResolvedValue({
      ok: true,
    });

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: true,
      },
      lc,
      'cgid',
    );
    void pusher.run();
    pusher.initConnection(clientID, wsID, undefined);

    pusher.enqueuePush(clientID, makePush(1), 'jwt', 'my-cookie');

    await pusher.stop();

    expect(fetch.mock.calls[0][1]?.headers).toHaveProperty(
      'Cookie',
      'my-cookie',
    );
  });

  test('ack mutation responses', async () => {
    const fetch = (global.fetch = vi.fn());
    fetch.mockResolvedValue({
      ok: true,
    });

    const mockDB = vi.fn(x => ({ident: x})) as unknown as PostgresDB;
    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: true,
      },
      lc,
      'cgid',
    );
    void pusher.run();

    await pusher.ackMutationResponses({
      clientID: 'test-client',
      id: 42,
    });

    await pusher.stop();

    expect(mockDB).toHaveBeenNthCalledWith(1, 'zero_0');
    expect(mockDB).toHaveBeenNthCalledWith(
      2,
      [
        'DELETE FROM ',
        '.mutations WHERE "clientGroupID" = ',
        ' AND "clientID" = ',
        ' AND "mutationID" <= ',
        '',
      ],
      {
        ident: 'zero_0',
      },
      'cgid',
      'test-client',
      42,
    );
  });
});

describe('initConnection', () => {
  test('initConnection returns a stream', () => {
    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();

    // const result = pusher.initConnection(clientID, wsID, undefined);
    // expect(result.type).toBe('stream');
  });

  test('initConnection throws if it was already called for the same clientID and wsID', () => {
    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();
    pusher.initConnection('c1', 'ws1', undefined);
    expect(() => pusher.initConnection('c1', 'ws1', undefined)).toThrow(
      'Connection was already initialized',
    );
  });

  test('initConnection destroys prior stream for same client when wsID changes', async () => {
    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();
    const stream1 = pusher.initConnection('c1', 'ws1', undefined);
    pusher.initConnection('c1', 'ws2', undefined);
    const iterator = stream1[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  test('uses client custom URL when userParams.url is provided', async () => {
    const fetch = (global.fetch = vi.fn());
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({mutations: []}),
    });

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://default.com', 'http://custom.com/push'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();

    const userPushURL = 'http://custom.com/push';

    pusher.initConnection(clientID, wsID, userPushURL);
    pusher.enqueuePush(clientID, makePush(1), 'jwt', undefined);

    await new Promise(resolve => setTimeout(resolve, 0));

    // Verify custom URL was used instead of default
    expect(fetch.mock.calls[0][0]).toEqual(
      'http://custom.com/push?schema=zero_0&appID=zero',
    );

    await pusher.stop();
  });

  test('falls back to default URL when userParams.url is not provided', async () => {
    const fetch = (global.fetch = vi.fn());
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({mutations: []}),
    });

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://default.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();

    pusher.initConnection(clientID, wsID, undefined);
    pusher.enqueuePush(clientID, makePush(1), 'jwt', undefined);

    await new Promise(resolve => setTimeout(resolve, 0));

    // Verify default URL was used
    expect(fetch.mock.calls[0][0]).toEqual(
      'http://default.com/?schema=zero_0&appID=zero',
    );

    await pusher.stop();
  });
});

describe('pusher streaming', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test('returns ok for subsequent pushes from same client', () => {
    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();

    pusher.initConnection(clientID, wsID, undefined);
    pusher.enqueuePush(clientID, makePush(1), 'jwt', undefined);
    const result = pusher.enqueuePush(clientID, makePush(1), 'jwt', undefined);
    expect(result.type).toBe('ok');
  });

  test('cleanup removes client subscription', () => {
    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();

    const stream1 = pusher.initConnection(clientID, 'ws1', undefined);

    pusher.enqueuePush(clientID, makePush(1, clientID), 'jwt', undefined);

    stream1.cancel();

    // After cleanup, should get a new stream (even if same wsid)
    expect(() =>
      pusher.initConnection(clientID, 'ws1', undefined),
    ).not.toThrow();
  });

  test('new websocket for same client creates new downstream', async () => {
    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();

    const stream1 = pusher.initConnection(clientID, 'ws1', undefined);
    pusher.initConnection(clientID, 'ws2', undefined);

    // should not be iterable anymore as it is closed by the arrival of ws2
    const iterator = stream1[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});

describe('pusher errors', () => {
  async function expectPushErrorResponse(
    errorResponse: PushResponse,
    expectedError: PushFailedBody,
  ) {
    const fetch = (global.fetch = vi.fn());
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(errorResponse),
    });

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();

    const stream = pusher.initConnection(clientID, 'ws1', undefined);
    pusher.enqueuePush(clientID, makePush(1, clientID), 'jwt', undefined);

    const iterator = stream[Symbol.asyncIterator]();
    const failure = iterator.next();
    const expectedLogLevel =
      expectedError.origin === ErrorOrigin.Server ? 'warn' : 'error';
    await expect(failure).rejects.toBeInstanceOf(ProtocolErrorWithLevel);
    await expect(failure).rejects.toMatchObject({
      errorBody: expectedError,
      logLevel: expectedLogLevel,
    });
  }

  test('emits error message on ooo mutations', async () => {
    await expectPushErrorResponse(
      {
        mutations: [
          {id: {clientID, id: 3}, result: {}},
          {id: {clientID, id: 1}, result: {error: 'oooMutation'}},
        ],
      },
      {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.Server,
        reason: ErrorReason.OutOfOrderMutation,
        message: 'mutation was out of order',
        details: undefined,
        mutationIDs: [
          {clientID: 'test-cid', id: 3},
          {clientID: 'test-cid', id: 1},
        ],
      },
    );
  });

  test('emits error message on unsupported schema version or push version', async () => {
    await expectPushErrorResponse(
      {
        error: 'unsupportedSchemaVersion',
        mutationIDs: [{clientID, id: 1}],
      },
      {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.Server,
        reason: ErrorReason.Internal,
        message: 'Unsupported schema version',
        mutationIDs: [{clientID: 'test-cid', id: 1}],
      },
    );
  });

  test('emits error message with PushFailed error on 401 response', async () => {
    await expectPushErrorResponse(
      {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.ZeroCache,
        reason: ErrorReason.HTTP,
        status: 401,
        bodyPreview: 'Unauthorized access',
        message: 'Fetch from API server returned non-OK status 401',
        mutationIDs: [{clientID: 'test-cid', id: 1}],
      },
      {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.ZeroCache,
        reason: ErrorReason.HTTP,
        status: 401,
        bodyPreview: 'Unauthorized access',
        message: 'Fetch from API server returned non-OK status 401',
        mutationIDs: [{clientID: 'test-cid', id: 1}],
      },
    );
  });

  test('emits error message with legacy http error format', async () => {
    await expectPushErrorResponse(
      {
        error: 'http',
        status: 503,
        details: 'Service Unavailable',
        mutationIDs: [{clientID, id: 1}],
      },
      {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.ZeroCache,
        reason: ErrorReason.HTTP,
        status: 503,
        bodyPreview: 'Service Unavailable',
        message: 'Fetch from API server returned non-OK status 503',
        mutationIDs: [{clientID: 'test-cid', id: 1}],
      },
    );
  });

  test('emits error message with legacy unsupportedPushVersion format', async () => {
    await expectPushErrorResponse(
      {
        error: 'unsupportedPushVersion',
        mutationIDs: [{clientID, id: 1}],
      },
      {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.Server,
        reason: ErrorReason.UnsupportedPushVersion,
        message: 'Unsupported push version',
        mutationIDs: [{clientID: 'test-cid', id: 1}],
      },
    );
  });

  test('emits error message with legacy zeroPusher error format', async () => {
    await expectPushErrorResponse(
      {
        error: 'zeroPusher',
        details: 'Zero pusher internal error',
        mutationIDs: [{clientID, id: 1}],
      },
      {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.Server,
        reason: ErrorReason.Internal,
        message: 'Zero pusher internal error',
        mutationIDs: [{clientID: 'test-cid', id: 1}],
      },
    );
  });

  test('handles non-Error object thrown in catch block', async () => {
    const fetch = (global.fetch = vi.fn());
    fetch.mockRejectedValue('string error');

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();
    const stream = pusher.initConnection(clientID, wsID, undefined);

    pusher.enqueuePush(clientID, makePush(1, clientID), 'jwt', undefined);

    const iterator = stream[Symbol.asyncIterator]();
    const failure = iterator.next();
    await expect(failure).rejects.toBeInstanceOf(ProtocolErrorWithLevel);
    await expect(failure).rejects.toMatchObject({
      errorBody: {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.ZeroCache,
        reason: ErrorReason.Internal,
        message:
          'Fetch from API server failed with unknown error: string error',
        mutationIDs: [
          {
            clientID: 'test-cid',
            id: 1,
          },
        ],
      },
      logLevel: 'error',
    });
  });

  test('handles ooo mutation with subsequent mutations', async () => {
    const fetch = (global.fetch = vi.fn());
    const oooResponse: PushResponse = {
      mutations: [
        {
          id: {clientID, id: 1},
          result: {error: 'oooMutation', details: 'out of order'},
        },
        {
          id: {clientID, id: 2},
          result: {},
        },
        {
          id: {clientID, id: 3},
          result: {},
        },
      ],
    };

    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(oooResponse),
    });

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();

    const stream = pusher.initConnection(clientID, 'ws1', undefined);
    pusher.enqueuePush(clientID, makePush(3, clientID), 'jwt', undefined);

    const iterator = stream[Symbol.asyncIterator]();
    const failure = iterator.next();
    await expect(failure).rejects.toBeInstanceOf(ProtocolErrorWithLevel);
    await expect(failure).rejects.toMatchObject({
      errorBody: {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.Server,
        reason: ErrorReason.OutOfOrderMutation,
        message: 'mutation was out of order',
        details: 'out of order',
        mutationIDs: [
          {
            clientID: 'test-cid',
            id: 1,
          },
          {
            clientID: 'test-cid',
            id: 2,
          },
          {
            clientID: 'test-cid',
            id: 3,
          },
        ],
      },
      logLevel: 'warn',
    });
  });

  test('streams error response to affected clients', async () => {
    const fetch = (global.fetch = vi.fn());
    const mockResponse = {
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
      clone() {
        return mockResponse;
      },
    };
    fetch.mockResolvedValue(mockResponse);

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();
    const stream1 = pusher.initConnection('client1', 'ws1', undefined);
    const stream2 = pusher.initConnection('client2', 'ws2', undefined);

    pusher.enqueuePush('client1', makePush(1, 'client1'), 'jwt', undefined);
    pusher.enqueuePush('client2', makePush(1, 'client2'), 'jwt', undefined);

    const iterator1 = stream1[Symbol.asyncIterator]();
    const iterator2 = stream2[Symbol.asyncIterator]();
    const failure1 = iterator1.next();
    const failure2 = iterator2.next();

    await expect(failure1).rejects.toBeInstanceOf(ProtocolErrorWithLevel);
    await expect(failure1).rejects.toMatchObject({
      errorBody: {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.ZeroCache,
        reason: ErrorReason.HTTP,
        status: 500,
        bodyPreview: 'Internal Server Error',
        message: 'Fetch from API server returned non-OK status 500',
        mutationIDs: [
          {
            clientID: 'client1',
            id: 1,
          },
        ],
      },
      logLevel: 'error',
    });

    await expect(failure2).rejects.toBeInstanceOf(ProtocolErrorWithLevel);
    await expect(failure2).rejects.toMatchObject({
      errorBody: {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.ZeroCache,
        reason: ErrorReason.HTTP,
        status: 500,
        bodyPreview: 'Internal Server Error',
        message: 'Fetch from API server returned non-OK status 500',
        mutationIDs: [
          {
            clientID: 'client2',
            id: 2,
          },
        ],
      },
      logLevel: 'error',
    });
  });

  test('handles network errors', async () => {
    const fetch = (global.fetch = vi.fn());
    fetch.mockRejectedValue(new Error('Network error'));

    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://example.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();
    const stream = pusher.initConnection(clientID, wsID, undefined);

    pusher.enqueuePush(clientID, makePush(1, clientID), 'jwt', undefined);

    const iterator = stream[Symbol.asyncIterator]();
    const failure = iterator.next();
    await expect(failure).rejects.toBeInstanceOf(ProtocolErrorWithLevel);
    await expect(failure).rejects.toMatchObject({
      errorBody: {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.ZeroCache,
        reason: ErrorReason.Internal,
        message:
          'Fetch from API server failed with unknown error: Network error',
        mutationIDs: [
          {
            clientID: 'test-cid',
            id: 1,
          },
        ],
      },
      logLevel: 'error',
    });
  });

  test('rejects disallowed custom URL', async () => {
    const pusher = new PusherService(
      mockDB,
      config,
      {
        url: ['http://allowed.com'],
        apiKey: 'api-key',
        forwardCookies: false,
      },
      lc,
      'cgid',
    );
    void pusher.run();
    const stream = pusher.initConnection(
      clientID,
      wsID,
      'http://malicious.com/endpoint',
    );

    pusher.enqueuePush(clientID, makePush(1, clientID), 'jwt', undefined);

    const iterator = stream[Symbol.asyncIterator]();
    const failure = iterator.next();
    await expect(failure).rejects.toBeInstanceOf(ProtocolErrorWithLevel);
    await expect(failure).rejects.toMatchObject({
      errorBody: {
        kind: ErrorKind.PushFailed,
        origin: ErrorOrigin.ZeroCache,
        reason: ErrorReason.Internal,
        message: expect.stringContaining(
          'URL "http://malicious.com/endpoint" is not allowed by the ZERO_MUTATE/GET_QUERIES_URL configuration',
        ),
        mutationIDs: [
          {
            clientID: 'test-cid',
            id: 1,
          },
        ],
      },
      logLevel: 'error',
    });

    await pusher.stop();
  });
});

let timestamp = 0;
let id = 0;

beforeEach(() => {
  timestamp = 0;
  id = 0;
});

function makePush(numMutations: number, clientID?: string): PushBody {
  return {
    clientGroupID: 'cgid',
    mutations: Array.from({length: numMutations}, () => makeMutation(clientID)),
    pushVersion: 1,
    requestID: 'rid',
    schemaVersion: 1,
    timestamp: ++timestamp,
  };
}

function makeMutation(clientID?: string): Mutation {
  return {
    type: 'custom',
    args: [],
    clientID: clientID ?? 'cid',
    id: ++id,
    name: 'n',
    timestamp: ++timestamp,
  } as const;
}
