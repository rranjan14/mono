import {describe, expect, expectTypeOf, test} from 'vitest';
import * as v from '../../../shared/src/valita.ts';
import {
  createBuilder,
  syncedQuery,
  syncedQueryWithContext,
  withValidation,
} from './named.ts';
import {ast} from './query-impl.ts';
import type {QueryResultType, QueryRowType, Row} from './query.ts';
import {schema} from './test/test-schemas.ts';
import {QueryParseError} from './error.ts';

const builder = createBuilder(schema);

type IssueRow = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly closed: boolean;
  readonly ownerId: string | null;
  readonly createdAt: number;
};

describe('types', () => {
  test('helpers for named query instances', () => {
    const idArgs = v.tuple([v.string()]);
    const def = syncedQuery('myQuery', idArgs, (id: string) =>
      builder.issue.where('id', id),
    );

    const query = def('123');
    type NamedQuery = typeof query;

    expectTypeOf<Row<NamedQuery>>().toEqualTypeOf<IssueRow>();
    expectTypeOf<QueryRowType<NamedQuery>>().toEqualTypeOf<IssueRow>();
    expectTypeOf<QueryResultType<NamedQuery>>().toEqualTypeOf<IssueRow[]>();

    type OneNamedQuery = ReturnType<typeof query.one>;
    expectTypeOf<QueryRowType<OneNamedQuery>>().toEqualTypeOf<
      IssueRow | undefined
    >();
    expectTypeOf<QueryResultType<OneNamedQuery>>().toEqualTypeOf<
      IssueRow | undefined
    >();
  });

  test('helpers for validated named query instances', () => {
    const idArgs = v.tuple([v.string()]);
    const def = syncedQuery('myQuery', idArgs, (id: string) =>
      builder.issue.where('id', id),
    );
    const validated = withValidation(def);

    const query = validated('ignored', '123');
    type NamedQuery = typeof query;

    expectTypeOf<Row<NamedQuery>>().toEqualTypeOf<IssueRow>();
    expectTypeOf<QueryRowType<NamedQuery>>().toEqualTypeOf<IssueRow>();
    expectTypeOf<QueryResultType<NamedQuery>>().toEqualTypeOf<IssueRow[]>();

    type OneNamedQuery = ReturnType<typeof query.one>;
    expectTypeOf<QueryRowType<OneNamedQuery>>().toEqualTypeOf<
      IssueRow | undefined
    >();
    expectTypeOf<QueryResultType<OneNamedQuery>>().toEqualTypeOf<
      IssueRow | undefined
    >();
  });
});

test('syncedQuery', () => {
  const idArgs = v.tuple([v.string()]);
  const def = syncedQuery('myQuery', idArgs, (id: string) =>
    builder.issue.where('id', id),
  );
  expect(def.queryName).toEqual('myQuery');
  expect(def.parse).toBeDefined();
  expect(def.takesContext).toEqual(false);

  expectTypeOf<Row<typeof def>>().toEqualTypeOf<QueryRowType<typeof def>>();
  expectTypeOf<QueryRowType<typeof def>>().toEqualTypeOf<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly closed: boolean;
    readonly ownerId: string | null;
    readonly createdAt: number;
  }>();
  expectTypeOf<QueryResultType<typeof def>>().toEqualTypeOf<
    {
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly closed: boolean;
      readonly ownerId: string | null;
      readonly createdAt: number;
    }[]
  >();

  const q = def('123');
  expectTypeOf<ReturnType<typeof q.run>>().toEqualTypeOf<
    Promise<
      {
        readonly id: string;
        readonly title: string;
        readonly description: string;
        readonly closed: boolean;
        readonly ownerId: string | null;
        readonly createdAt: number;
      }[]
    >
  >();

  expect(q.customQueryID).toEqual({
    name: 'myQuery',
    args: ['123'],
  });

  expect(q.ast).toEqual({
    table: 'issue',
    where: {
      left: {
        name: 'id',
        type: 'column',
      },
      op: '=',
      right: {
        type: 'literal',
        value: '123',
      },
      type: 'simple',
    },
    orderBy: [['id', 'asc']],
  });

  const wv = withValidation(def);
  expect(wv.queryName).toEqual('myQuery');
  expect(wv.parse).toBeDefined();
  expect(wv.takesContext).toEqual(true);
  expect(() => wv('ignored', 123)).toThrow(
    'invalid_type at .0 (expected string)',
  );

  expectTypeOf<Row<typeof wv>>().toEqualTypeOf<QueryRowType<typeof wv>>();
  expectTypeOf<QueryRowType<typeof wv>>().toEqualTypeOf<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly closed: boolean;
    readonly ownerId: string | null;
    readonly createdAt: number;
  }>();
  expectTypeOf<QueryResultType<typeof wv>>().toEqualTypeOf<
    {
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly closed: boolean;
      readonly ownerId: string | null;
      readonly createdAt: number;
    }[]
  >();

  const vq = wv('ignored', '123');
  expectTypeOf<ReturnType<typeof vq.run>>().toEqualTypeOf<
    Promise<
      {
        readonly id: string;
        readonly title: string;
        readonly description: string;
        readonly closed: boolean;
        readonly ownerId: string | null;
        readonly createdAt: number;
      }[]
    >
  >();

  expect(vq.customQueryID).toEqual({
    name: 'myQuery',
    args: ['123'],
  });

  expect(vq.ast).toEqual({
    table: 'issue',
    where: {
      left: {
        name: 'id',
        type: 'column',
      },
      op: '=',
      right: {
        type: 'literal',
        value: '123',
      },
      type: 'simple',
    },
    orderBy: [['id', 'asc']],
  });
});

test('syncedQueryWithContext', () => {
  const idArgs = v.tuple([v.string()]);
  const def = syncedQueryWithContext(
    'myQuery',
    idArgs,
    (context: string, id: string) =>
      builder.issue.where('id', id).where('ownerId', context),
  );
  expect(def.queryName).toEqual('myQuery');
  expect(def.parse).toBeDefined();
  expect(def.takesContext).toEqual(true);

  expectTypeOf<Row<typeof def>>().toEqualTypeOf<QueryRowType<typeof def>>();
  expectTypeOf<QueryRowType<typeof def>>().toEqualTypeOf<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly closed: boolean;
    readonly ownerId: string | null;
    readonly createdAt: number;
  }>();
  expectTypeOf<QueryResultType<typeof def>>().toEqualTypeOf<
    {
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly closed: boolean;
      readonly ownerId: string | null;
      readonly createdAt: number;
    }[]
  >();

  const q = def('user1', '123');
  expectTypeOf<ReturnType<typeof q.run>>().toEqualTypeOf<
    Promise<
      {
        readonly id: string;
        readonly title: string;
        readonly description: string;
        readonly closed: boolean;
        readonly ownerId: string | null;
        readonly createdAt: number;
      }[]
    >
  >();

  expect(q.customQueryID).toEqual({
    name: 'myQuery',
    args: ['123'],
  });

  expect(q.ast).toEqual({
    table: 'issue',
    where: {
      conditions: [
        {
          left: {
            name: 'id',
            type: 'column',
          },
          op: '=',
          right: {
            type: 'literal',
            value: '123',
          },
          type: 'simple',
        },
        {
          left: {
            name: 'ownerId',
            type: 'column',
          },
          op: '=',
          right: {
            type: 'literal',
            value: 'user1',
          },
          type: 'simple',
        },
      ],
      type: 'and',
    },
    orderBy: [['id', 'asc']],
  });

  const wv = withValidation(def);
  expect(wv.queryName).toEqual('myQuery');
  expect(wv.parse).toBeDefined();
  expect(wv.takesContext).toEqual(true);
  expect(() => wv('ignored', 123)).toThrow(
    'invalid_type at .0 (expected string)',
  );

  expectTypeOf<Row<typeof wv>>().toEqualTypeOf<QueryRowType<typeof wv>>();
  expectTypeOf<QueryRowType<typeof wv>>().toEqualTypeOf<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly closed: boolean;
    readonly ownerId: string | null;
    readonly createdAt: number;
  }>();
  expectTypeOf<QueryResultType<typeof wv>>().toEqualTypeOf<
    {
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly closed: boolean;
      readonly ownerId: string | null;
      readonly createdAt: number;
    }[]
  >();

  const vq = wv('user1', '123');
  expectTypeOf<ReturnType<typeof vq.run>>().toEqualTypeOf<
    Promise<
      {
        readonly id: string;
        readonly title: string;
        readonly description: string;
        readonly closed: boolean;
        readonly ownerId: string | null;
        readonly createdAt: number;
      }[]
    >
  >();

  expect(vq.customQueryID).toEqual({
    name: 'myQuery',
    args: ['123'],
  });

  expect(vq.ast).toEqual({
    table: 'issue',
    where: {
      conditions: [
        {
          left: {
            name: 'id',
            type: 'column',
          },
          op: '=',
          right: {
            type: 'literal',
            value: '123',
          },
          type: 'simple',
        },
        {
          left: {
            name: 'ownerId',
            type: 'column',
          },
          op: '=',
          right: {
            type: 'literal',
            value: 'user1',
          },
          type: 'simple',
        },
      ],
      type: 'and',
    },
    orderBy: [['id', 'asc']],
  });
});

test('withValidation throws QueryParseError on parse failure', () => {
  const idArgs = v.tuple([v.string()]);
  const def = syncedQuery('myQuery', idArgs, (id: string) =>
    builder.issue.where('id', id),
  );
  const wv = withValidation(def);

  let thrownError: Error | undefined;
  try {
    wv('ignored', 123);
    expect.fail('Expected QueryParseError to be thrown');
  } catch (error) {
    thrownError = error as Error;
  }

  expect(thrownError).toBeInstanceOf(QueryParseError);
  expect(thrownError?.name).toBe('QueryParseError');
  expect(thrownError?.message).toMatchInlineSnapshot(
    `"Failed to parse arguments for query: invalid_type at .0 (expected string)"`,
  );
});

test('withValidation throws QueryParseError for syncedQueryWithContext', () => {
  const idArgs = v.tuple([v.string(), v.number()]);
  const def = syncedQueryWithContext(
    'contextQuery',
    idArgs,
    (context: string, id: string, _count: number) =>
      builder.issue.where('id', id).where('ownerId', context),
  );
  const wv = withValidation(def);

  let thrownError: Error | undefined;
  try {
    wv('user1', 'not-a-number', 'also-not-a-number');
    expect.fail('Expected QueryParseError to be thrown');
  } catch (error) {
    thrownError = error as Error;
  }

  expect(thrownError).toBeInstanceOf(QueryParseError);
  expect(thrownError?.name).toBe('QueryParseError');
  expect(thrownError?.message).toMatchInlineSnapshot(
    `"Failed to parse arguments for query: invalid_type at .1 (expected number)"`,
  );
});

// TODO: test unions

test('makeSchemaQuery', () => {
  const builders = createBuilder(schema);
  const q1 = builders.issue.where('id', '123').nameAndArgs('myName', ['123']);
  expect(ast(q1)).toMatchInlineSnapshot(`
    {
      "table": "issue",
      "where": {
        "left": {
          "name": "id",
          "type": "column",
        },
        "op": "=",
        "right": {
          "type": "literal",
          "value": "123",
        },
        "type": "simple",
      },
    }
  `);
});
