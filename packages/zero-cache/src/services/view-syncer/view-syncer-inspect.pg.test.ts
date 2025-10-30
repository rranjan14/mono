import {beforeEach, describe, expect, vi} from 'vitest';
import {assert} from '../../../../shared/src/asserts.ts';
import {Queue} from '../../../../shared/src/queue.ts';
import type {AST} from '../../../../zero-protocol/src/ast.ts';
import {type ClientSchema} from '../../../../zero-protocol/src/client-schema.ts';
import type {Downstream} from '../../../../zero-protocol/src/down.ts';
import type {InspectDownMessage} from '../../../../zero-protocol/src/inspect-down.ts';
import {PROTOCOL_VERSION} from '../../../../zero-protocol/src/protocol-version.ts';
import type {UpQueriesPatch} from '../../../../zero-protocol/src/queries-patch.ts';
import type {CustomQueryTransformer} from '../../custom-queries/transform-query.ts';
import {InspectorDelegate} from '../../server/inspector-delegate.ts';
import {type PgTest, test} from '../../test/db.ts';
import {DbFile} from '../../test/lite.ts';
import type {PostgresDB} from '../../types/pg.ts';
import type {Source} from '../../types/streams.ts';
import {Subscription} from '../../types/subscription.ts';
import type {ReplicaState} from '../replicator/replicator.ts';
import {type FakeReplicator} from '../replicator/test-utils.ts';
import {
  expectNoPokes,
  ISSUES_QUERY,
  messages,
  nextPoke,
  permissionsAll,
  serviceID,
  setup,
  TEST_ADMIN_PASSWORD,
} from './view-syncer-test-util.ts';
import {type SyncContext, ViewSyncerService} from './view-syncer.ts';

describe('view-syncer/service', () => {
  let replicaDbFile: DbFile;
  let cvrDB: PostgresDB;
  let upstreamDb: PostgresDB;
  let stateChanges: Subscription<ReplicaState>;

  let vs: ViewSyncerService;
  let viewSyncerDone: Promise<void>;
  let replicator: FakeReplicator;
  let connectWithQueueAndSource: (
    ctx: SyncContext,
    desiredQueriesPatch: UpQueriesPatch,
    clientSchema?: ClientSchema,
    activeClients?: string[],
  ) => {
    queue: Queue<Downstream>;
    source: Source<Downstream>;
  };

  const SYNC_CONTEXT: SyncContext = {
    clientID: 'foo',
    wsID: 'ws1',
    baseCookie: null,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: 2,
    tokenData: undefined,
    httpCookie: undefined,
  };

  let delegate: InspectorDelegate;
  let customQueryTransformer: CustomQueryTransformer | undefined;

  beforeEach<PgTest>(async ({testDBs}) => {
    ({
      replicaDbFile,
      cvrDB,
      upstreamDb,
      stateChanges,
      vs,
      viewSyncerDone,
      replicator,
      connectWithQueueAndSource,
      inspectorDelegate: delegate,
      customQueryTransformer,
    } = await setup(testDBs, 'view_syncer_inspect_test', permissionsAll));

    delegate.setAuthenticated(serviceID);

    return async () => {
      vi.useRealTimers();
      await vs.stop();
      await viewSyncerDone;
      await testDBs.drop(cvrDB, upstreamDb);
      replicaDbFile.delete();

      delegate.clearAuthenticated(serviceID);
    };
  });

  test('inspect metrics op returns server metrics', async () => {
    const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, [
      {op: 'put', hash: 'query-hash1', ast: ISSUES_QUERY},
    ]);

    // Wait for initial hydration to complete
    await nextPoke(client);
    stateChanges.push({state: 'version-ready'});
    await nextPoke(client);

    // Trigger query materializations to generate metrics
    replicator.processTransaction(
      'txn-1',
      messages.insert('issues', {
        id: 'test-issue',
        title: 'Test Issue',
        owner: '100',
        big: 1000,
        json: null,
        parent: null,
      }),
    );
    stateChanges.push({state: 'version-ready'});
    await expectNoPokes(client);

    // Now call the inspect method and expect it to send a response
    const inspectId = 'test-metrics-inspect';

    // Call inspect and wait for the response to come through the client queue
    await vs.inspect(SYNC_CONTEXT, ['inspect', {op: 'metrics', id: inspectId}]);

    const msg = (await client.dequeue()) as InspectDownMessage;
    expect(msg).toMatchObject([
      'inspect',
      {
        id: 'test-metrics-inspect',
        op: 'metrics',
        value: {
          'query-materialization-server': expect.arrayContaining([
            expect.any(Number),
          ]),
        },
      },
    ]);
  });

  test('inspect queries op fans out server metrics to queries sharing a transformationHash', async () => {
    const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, [
      {op: 'put', hash: 'query-hash1', ast: ISSUES_QUERY},
      // Different query hash, identical AST => same transformationHash
      {op: 'put', hash: 'query-hash2', ast: ISSUES_QUERY},
    ]);

    // Wait for initial hydration to complete (which records server materialization metrics)
    await nextPoke(client);
    stateChanges.push({state: 'version-ready'});
    await nextPoke(client);
    await expectNoPokes(client);

    // Trigger an update so we record 'query-update-server' after both query mappings are in place
    replicator.processTransaction(
      'txn-1',
      messages.insert('issues', {
        id: 'issue-x',
        title: 'X',
        owner: '100',
        big: 1,
        json: null,
        parent: null,
      }),
    );
    stateChanges.push({state: 'version-ready'});
    await expectNoPokes(client);

    const inspectId = 'test-queries-metrics-fanout';
    await vs.inspect(SYNC_CONTEXT, [
      'inspect',
      {op: 'queries', id: inspectId, clientID: SYNC_CONTEXT.clientID},
    ]);

    const msg = await client.dequeue();
    expect(msg[0]).toBe('inspect');
    expect(msg[1]).toMatchObject({id: inspectId, op: 'queries'});

    const rows = (msg[1] as Extract<InspectDownMessage[1], {op: 'queries'}>)
      .value;

    expect(rows).toHaveLength(2);
    const r1 = rows.find(r => r.queryID === 'query-hash1');
    const r2 = rows.find(r => r.queryID === 'query-hash2');

    // Both queries should contain some materialization samples
    expect(r1?.metrics?.['query-materialization-server']).toEqual(
      expect.arrayContaining([expect.any(Number)]),
    );

    // And both should have identical update metrics since the update happened after both were mapped
    expect(r1?.metrics?.['query-update-server']).toEqual(
      r2?.metrics?.['query-update-server'],
    );
  });

  test('inspect version', async () => {
    const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

    // Wait for initial hydration to complete
    await nextPoke(client);
    stateChanges.push({state: 'version-ready'});
    await nextPoke(client);

    await expectNoPokes(client);

    const inspectId = 'test-version-inspect';

    // Call inspect and wait for the response to come through the client queue
    await vs.inspect(SYNC_CONTEXT, ['inspect', {op: 'version', id: inspectId}]);

    const msg = await client.dequeue();

    expect(msg).toEqual([
      'inspect',
      {
        id: 'test-version-inspect',
        op: 'version',
        value: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      },
    ]);
  });

  test('not authenticated', async () => {
    delegate.clearAuthenticated('9876');

    const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

    // Wait for initial hydration to complete
    await nextPoke(client);
    stateChanges.push({state: 'version-ready'});
    await nextPoke(client);

    await expectNoPokes(client);

    const inspectId = 'test-version-inspect';

    // Call inspect and wait for the response to come through the client queue
    await vs.inspect(SYNC_CONTEXT, ['inspect', {op: 'version', id: inspectId}]);

    const msg = await client.dequeue();

    expect(msg).toEqual([
      'inspect',
      {
        id: 'test-version-inspect',
        op: 'authenticated',
        value: false,
      },
    ]);
  });

  test('authenticate', async () => {
    delegate.clearAuthenticated(serviceID);

    const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

    // Wait for initial hydration to complete
    await nextPoke(client);
    stateChanges.push({state: 'version-ready'});
    await nextPoke(client);

    await expectNoPokes(client);

    const inspectId = 'test-version-inspect';

    // Call inspect and wait for the response to come through the client queue
    await vs.inspect(SYNC_CONTEXT, [
      'inspect',
      {op: 'authenticate', id: inspectId, value: 'wrong'},
    ]);

    let msg = await client.dequeue();

    expect(msg).toEqual([
      'inspect',
      {
        id: 'test-version-inspect',
        op: 'authenticated',
        value: false,
      },
    ]);

    await vs.inspect(SYNC_CONTEXT, [
      'inspect',
      {op: 'authenticate', id: inspectId, value: TEST_ADMIN_PASSWORD},
    ]);

    msg = await client.dequeue();

    expect(msg).toEqual([
      'inspect',
      {
        id: 'test-version-inspect',
        op: 'authenticated',
        value: true,
      },
    ]);
  });

  test('analyze-query with direct AST', async () => {
    const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

    await nextPoke(client);
    stateChanges.push({state: 'version-ready'});
    await nextPoke(client);
    await expectNoPokes(client);

    const inspectId = 'test-analyze-query';
    const ast = ISSUES_QUERY;

    await vs.inspect(SYNC_CONTEXT, [
      'inspect',
      {
        op: 'analyze-query',
        id: inspectId,
        ast,
        options: {},
      },
    ]);

    const msg = (await client.dequeue()) as InspectDownMessage;
    expect(msg[0]).toBe('inspect');
    expect(msg[1]).toMatchObject({
      id: inspectId,
      op: 'analyze-query',
      value: expect.objectContaining({
        syncedRowCount: expect.any(Number),
        warnings: expect.any(Array),
      }),
    });
  });

  test('analyze-query with options', async () => {
    const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

    await nextPoke(client);
    stateChanges.push({state: 'version-ready'});
    await nextPoke(client);
    await expectNoPokes(client);

    const inspectId = 'test-analyze-query-options';

    await vs.inspect(SYNC_CONTEXT, [
      'inspect',
      {
        op: 'analyze-query',
        id: inspectId,
        ast: ISSUES_QUERY,
        options: {
          vendedRows: true,
          syncedRows: true,
        },
      },
    ]);

    const msg = (await client.dequeue()) as InspectDownMessage;
    expect(msg[0]).toBe('inspect');
    expect(msg[1]).toMatchObject({
      id: inspectId,
      op: 'analyze-query',
      value: expect.objectContaining({
        syncedRowCount: expect.any(Number),
        syncedRows: expect.any(Object),
      }),
    });
  });

  test('analyze-query result includes elapsed time (regression for elapsed/end deprecation)', async () => {
    const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

    await nextPoke(client);
    stateChanges.push({state: 'version-ready'});
    await nextPoke(client);
    await expectNoPokes(client);

    const inspectId = 'test-analyze-query-elapsed';

    await vs.inspect(SYNC_CONTEXT, [
      'inspect',
      {
        op: 'analyze-query',
        id: inspectId,
        ast: ISSUES_QUERY,
        options: {},
      },
    ]);

    const msg = (await client.dequeue()) as InspectDownMessage;
    expect(msg[0]).toBe('inspect');
    expect(msg[1]).toMatchObject({
      id: inspectId,
      op: 'analyze-query',
    });

    const result = (
      msg[1] as Extract<InspectDownMessage[1], {op: 'analyze-query'}>
    ).value;

    // Verify elapsed is present (new property)
    expect(result.elapsed).toBeDefined();
    expect(typeof result.elapsed).toBe('number');
    expect(result.elapsed).toBeGreaterThanOrEqual(0);

    // Verify elapsed matches end - start
    expect(result.elapsed).toBe(result.end - result.start);

    // Verify deprecated 'end' is still present for backward compatibility
    expect(result.end).toBeDefined();
    expect(result.start).toBeDefined();
    expect(typeof result.end).toBe('number');
    expect(typeof result.start).toBe('number');
  });

  test('analyze-query requires AST or custom query name/args', async () => {
    const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

    await nextPoke(client);
    stateChanges.push({state: 'version-ready'});
    await nextPoke(client);
    await expectNoPokes(client);

    const inspectId = 'test-analyze-query-no-ast';

    // Call inspect without providing AST or custom query name/args
    await vs.inspect(SYNC_CONTEXT, [
      'inspect',
      {
        op: 'analyze-query',
        id: inspectId,
        options: {},
      },
    ]);

    // Verify that an error response is sent back to the client
    const msg = (await client.dequeue()) as InspectDownMessage;
    expect(msg[0]).toBe('inspect');
    expect(msg[1]).toMatchObject({
      id: inspectId,
      op: 'error',
      value: expect.stringContaining('AST is required'),
    });
  });

  test('analyze-query with custom query name and args', async () => {
    assert(customQueryTransformer);

    const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

    await nextPoke(client);
    stateChanges.push({state: 'version-ready'});
    await nextPoke(client);
    await expectNoPokes(client);

    const inspectId = 'test-analyze-custom-query';

    // Spy on the transform method and mock its return value
    using transformSpy = vi
      .spyOn(customQueryTransformer, 'transform')
      .mockResolvedValue([
        {
          id: 'test-query-id',
          transformedAst: ISSUES_QUERY,
          transformationHash: 'test-hash-123',
        },
      ]);

    await vs.inspect(SYNC_CONTEXT, [
      'inspect',
      {
        op: 'analyze-query',
        id: inspectId,
        name: 'myQuery',
        args: ['arg1', 'arg2'],
        options: {},
      },
    ]);

    const msg = (await client.dequeue()) as InspectDownMessage;
    expect(msg[0]).toBe('inspect');
    expect(msg[1]).toMatchObject({
      id: inspectId,
      op: 'analyze-query',
      value: expect.objectContaining({
        syncedRowCount: expect.any(Number),
        warnings: expect.any(Array),
      }),
    });

    // Verify the transformer was called with correct parameters
    expect(transformSpy).toHaveBeenCalledOnce();
    const [headerOptions, queries, userQueryURL] = transformSpy.mock.lastCall!;

    expect(headerOptions).toEqual({
      apiKey: undefined,
      token: undefined,
      cookie: undefined,
    });

    const queriesArray = [...queries];
    expect(queriesArray).toHaveLength(1);
    expect(queriesArray[0]).toMatchObject({
      name: 'myQuery',
      args: ['arg1', 'arg2'],
      type: 'custom',
    });
    expect(userQueryURL).toBeUndefined();
  });

  describe('inspect error handling', () => {
    test('returns error response when analyze-query fails', async () => {
      const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

      await nextPoke(client);
      stateChanges.push({state: 'version-ready'});
      await nextPoke(client);
      await expectNoPokes(client);

      const inspectId = 'test-analyze-error';

      // Pass an invalid AST that will cause analyzeQuery to throw
      await vs.inspect(SYNC_CONTEXT, [
        'inspect',
        {
          op: 'analyze-query',
          id: inspectId,
          ast: {invalid: 'ast'} as unknown as AST,
          options: {},
        },
      ]);

      const msg = (await client.dequeue()) as InspectDownMessage;
      expect(msg[0]).toBe('inspect');
      expect(msg[1]).toMatchObject({
        id: inspectId,
        op: 'error',
        value: expect.any(String),
      });
      // Verify it's an error message (not the successful analyze response)
      expect((msg[1] as {op: string}).op).toBe('error');
    });

    test('returns error response when custom query transformation fails', async () => {
      assert(customQueryTransformer);

      const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

      await nextPoke(client);
      stateChanges.push({state: 'version-ready'});
      await nextPoke(client);
      await expectNoPokes(client);

      const inspectId = 'test-transform-error';

      // Spy on the transform method and make it return an empty array (no results)
      using transformSpy = vi
        .spyOn(customQueryTransformer, 'transform')
        .mockResolvedValue([]);

      await vs.inspect(SYNC_CONTEXT, [
        'inspect',
        {
          op: 'analyze-query',
          id: inspectId,
          name: 'myQuery',
          args: ['arg1', 'arg2'],
          options: {},
        },
      ]);

      const msg = (await client.dequeue()) as InspectDownMessage;
      expect(msg[0]).toBe('inspect');
      expect(msg[1]).toMatchObject({
        id: inspectId,
        op: 'error',
        value: 'No transformation result returned',
      });

      expect(transformSpy).toHaveBeenCalledOnce();
    });

    test('returns error response when custom query transformation returns error result', async () => {
      assert(customQueryTransformer);

      const {queue: client} = connectWithQueueAndSource(SYNC_CONTEXT, []);

      await nextPoke(client);
      stateChanges.push({state: 'version-ready'});
      await nextPoke(client);
      await expectNoPokes(client);

      const inspectId = 'test-transform-error-result';

      // Spy on the transform method and make it return an error result
      using transformSpy = vi
        .spyOn(customQueryTransformer, 'transform')
        .mockResolvedValue([
          {
            id: 'test-query',
            name: 'myQuery',
            error: 'app',
            message: 'Invalid query syntax: Missing required field',
          },
        ]);

      await vs.inspect(SYNC_CONTEXT, [
        'inspect',
        {
          op: 'analyze-query',
          id: inspectId,
          name: 'myQuery',
          args: ['arg1', 'arg2'],
          options: {},
        },
      ]);

      const msg = (await client.dequeue()) as InspectDownMessage;
      expect(msg[0]).toBe('inspect');
      expect(msg[1]).toMatchObject({
        id: inspectId,
        op: 'error',
        value: expect.stringContaining('Invalid query syntax'),
      });

      expect(transformSpy).toHaveBeenCalledOnce();
    });
  });
});
