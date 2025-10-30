import {assert, describe, expect, test, vi} from 'vitest';

import {handleGetQueriesRequest} from './process-queries.ts';
import {schema} from '../test/schema.ts';
import type {AST} from '../../../zero-protocol/src/ast.ts';
import {ApplicationError} from '../../../zero-protocol/src/application-error.ts';
import {ErrorReason} from '../../../zero-protocol/src/error-reason.ts';
import * as nameMapperModule from '../../../zero-schema/src/name-mapper.ts';
import {QueryParseError} from '../../../zql/src/query/error.ts';
import type {AnyQuery} from '../../../zql/src/query/query-impl.ts';

function makeQuery(ast: AST): AnyQuery {
  const query = {
    ast,
    withContext(_ctx: unknown) {
      return query;
    },
  } as unknown as AnyQuery;
  return query;
}

describe('handleGetQueriesRequest', () => {
  test('returns transformed queries with server names when given JSON body', async () => {
    const ast: AST = {
      table: 'names',
      where: {
        type: 'simple',
        op: '=',
        left: {type: 'column', name: 'b'},
        right: {type: 'literal', value: 'foo'},
      },
    };

    // oxlint-disable-next-line require-await
    const cb = vi.fn(async () => ({query: makeQuery(ast)}));

    const result = await handleGetQueriesRequest(cb, schema, [
      'transform',
      [
        {
          id: 'q1',
          name: 'namesByFoo',
          args: [{foo: 'bar'}],
        },
      ],
    ]);

    expect(cb).toHaveBeenCalledWith('namesByFoo', [{foo: 'bar'}]);
    expect(result[0]).toBe('transformed');
    assert(result[0] === 'transformed');
    const [response] = result[1];
    assert(!('error' in response));
    expect(response).toEqual({
      id: 'q1',
      name: 'namesByFoo',
      ast: expect.objectContaining({table: 'divergent_names'}),
    });
    expect(response.ast.table).toBe('divergent_names');

    const where = response.ast.where;
    assert(where && where.type === 'simple', 'expected simple where clause');
    expect(where.left).toEqual({type: 'column', name: 'divergent_b'});
  });

  test('reads request bodies from Request instances', async () => {
    const ast: AST = {
      table: 'basic',
      limit: 1,
    };

    // oxlint-disable-next-line require-await
    const cb = vi.fn(async () => ({query: makeQuery(ast)}));

    const body = JSON.stringify([
      'transform',
      [
        {
          id: 'q2',
          name: 'basicLimited',
          args: [],
        },
      ],
    ]);

    const request = new Request('https://example.com/get-queries', {
      method: 'POST',
      body,
    });

    const result = await handleGetQueriesRequest(cb, schema, request);

    expect(cb).toHaveBeenCalledWith('basicLimited', []);
    expect(result).toEqual([
      'transformed',
      [
        {
          id: 'q2',
          name: 'basicLimited',
          ast: expect.objectContaining({table: 'basic'}),
        },
      ],
    ]);
  });

  test('returns transformFailed parse error when validation fails', async () => {
    const result = await handleGetQueriesRequest(
      () => {
        throw new Error('should not be called');
      },
      schema,
      ['invalid', []],
    );

    expect(result[0]).toBe('transformFailed');
    expect(result[1]).toEqual({
      reason: ErrorReason.Parse,
      kind: expect.any(String),
      origin: expect.any(String),
      message: expect.stringContaining('Failed to parse get queries request'),
      queryIDs: [],
      details: expect.objectContaining({name: 'TypeError'}),
    });
  });

  test('returns transformFailed parse error when request body parsing fails', async () => {
    // Create a Request that will fail to parse as JSON
    const request = new Request('https://example.com/get-queries', {
      method: 'POST',
      body: 'not valid json',
    });

    const result = await handleGetQueriesRequest(
      () => {
        throw new Error('should not be called');
      },
      schema,
      request,
    );

    expect(result[0]).toBe('transformFailed');
    expect(result[1]).toEqual({
      reason: ErrorReason.Parse,
      kind: expect.any(String),
      origin: expect.any(String),
      message: expect.stringContaining('Failed to parse get queries request'),
      details: expect.objectContaining({name: 'SyntaxError'}),
      queryIDs: [],
    });
  });

  test('marks failed queries with app error and continues processing remaining queries', async () => {
    const ast: AST = {
      table: 'basic',
    };

    // oxlint-disable-next-line require-await
    const cb = vi.fn(async name => {
      if (name === 'first') {
        throw new Error('callback failed');
      }
      return {query: makeQuery(ast)};
    });

    const result = await handleGetQueriesRequest(cb, schema, [
      'transform',
      [
        {id: 'q1', name: 'first', args: []},
        {id: 'q2', name: 'second', args: []},
      ],
    ]);

    expect(cb).toHaveBeenCalledTimes(2);
    expect(result[0]).toBe('transformed');
    assert(result[0] === 'transformed');
    const [first, second] = result[1];
    expect(first).toEqual({
      error: 'app',
      id: 'q1',
      name: 'first',
      message: 'callback failed',
    });
    assert(!('error' in second));
    expect(second).toEqual({
      id: 'q2',
      name: 'second',
      ast: expect.objectContaining({table: 'basic'}),
    });
  });

  test('wraps thrown errors from callback with details when possible', async () => {
    const error = new TypeError('custom type error');
    const cb = vi.fn(() => {
      throw error;
    });

    const result = await handleGetQueriesRequest(cb, schema, [
      'transform',
      [{id: 'q1', name: 'test', args: []}],
    ]);

    expect(result[0]).toBe('transformed');
    assert(result[0] === 'transformed');
    const [response] = result[1];
    expect(response).toEqual({
      error: 'app',
      id: 'q1',
      name: 'test',
      message: 'custom type error',
      details: expect.objectContaining({name: 'TypeError'}),
    });
  });

  test('retains custom details from ApplicationError', async () => {
    const customDetails = {code: 'CUSTOM_ERROR', context: {foo: 'bar'}};
    const error = new ApplicationError('Application specific error', {
      details: customDetails,
    });

    const cb = vi.fn(() => {
      throw error;
    });

    const result = await handleGetQueriesRequest(cb, schema, [
      'transform',
      [{id: 'q1', name: 'test', args: []}],
    ]);

    expect(result[0]).toBe('transformed');
    assert(result[0] === 'transformed');
    const [response] = result[1];
    expect(response).toEqual({
      error: 'app',
      id: 'q1',
      name: 'test',
      message: 'Application specific error',
      details: customDetails,
    });
  });

  test('marks QueryParseError as parse error instead of app error', async () => {
    const parseError = new QueryParseError({
      cause: new TypeError('Invalid argument type'),
    });

    const cb = vi.fn(() => {
      throw parseError;
    });

    const result = await handleGetQueriesRequest(cb, schema, [
      'transform',
      [{id: 'q1', name: 'testQuery', args: [{foo: 'bar'}]}],
    ]);

    expect(result[0]).toBe('transformed');
    assert(result[0] === 'transformed');
    const [response] = result[1];
    expect(response).toEqual({
      error: 'parse',
      id: 'q1',
      name: 'testQuery',
      message: 'Failed to parse arguments for query: Invalid argument type',
      details: expect.objectContaining({name: 'QueryParseError'}),
    });
  });

  test('marks QueryParseError as parse error and continues processing remaining queries', async () => {
    const ast: AST = {
      table: 'basic',
    };

    // oxlint-disable-next-line require-await
    const cb = vi.fn(async name => {
      if (name === 'parseErrorQuery') {
        throw new QueryParseError({
          cause: new Error('Invalid args'),
        });
      }
      return {query: makeQuery(ast)};
    });

    const result = await handleGetQueriesRequest(cb, schema, [
      'transform',
      [
        {id: 'q1', name: 'parseErrorQuery', args: []},
        {id: 'q2', name: 'successQuery', args: []},
      ],
    ]);

    expect(cb).toHaveBeenCalledTimes(2);
    expect(result[0]).toBe('transformed');
    assert(result[0] === 'transformed');
    const [first, second] = result[1];
    expect(first).toEqual({
      error: 'parse',
      id: 'q1',
      name: 'parseErrorQuery',
      message: 'Failed to parse arguments for query: Invalid args',
      details: expect.objectContaining({name: 'QueryParseError'}),
    });
    assert(!('error' in second));
    expect(second).toEqual({
      id: 'q2',
      name: 'successQuery',
      ast: expect.objectContaining({table: 'basic'}),
    });
  });

  test('returns transformFailed for infrastructure errors during schema processing', async () => {
    const ast: AST = {
      table: 'basic',
    };

    // Mock clientToServer to throw an infrastructure error
    const spy = vi
      .spyOn(nameMapperModule, 'clientToServer')
      .mockImplementation(() => {
        throw new TypeError('Schema processing failed');
      });

    try {
      // oxlint-disable-next-line require-await
      const cb = vi.fn(async () => ({query: makeQuery(ast)}));

      const result = await handleGetQueriesRequest(cb, schema, [
        'transform',
        [{id: 'q1', name: 'test', args: []}],
      ]);

      expect(result[0]).toBe('transformFailed');
      assert(result[0] === 'transformFailed');
      expect(result[1]).toEqual({
        reason: ErrorReason.Internal,
        kind: expect.any(String),
        origin: expect.any(String),
        message: 'Schema processing failed',
        queryIDs: ['q1'],
        details: expect.objectContaining({name: 'TypeError'}),
      });
    } finally {
      spy.mockRestore();
    }
  });
});
