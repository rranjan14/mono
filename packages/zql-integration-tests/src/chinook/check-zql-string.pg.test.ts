import {test} from 'vitest';
import {defaultFormat} from '../../../zql/src/ivm/default-format.ts';
import {StaticQuery} from '../../../zql/src/query/static-query.ts';
import type {AnyStaticQuery} from '../../../zql/src/query/test/util.ts';
import '../helpers/comparePg.ts';
import {bootstrap, runAndCompare} from '../helpers/runner.ts';
import {staticToRunnable} from '../helpers/static.ts';
import {getChinook} from './get-deps.ts';
import {schema} from './schema.ts';

const QUERY_STRING = `track
  .whereExists('invoiceLines', q =>
    q
      .limit(0),
  ).limit(1)`;

const pgContent = await getChinook();

const harness = await bootstrap({
  suiteName: 'frontend_analysis',
  zqlSchema: schema,
  pgContent,
});

const z = {
  query: Object.fromEntries(
    Object.entries(schema.tables).map(([name]) => [
      name,
      new StaticQuery(
        schema,
        name as keyof typeof schema.tables,
        {table: name},
        defaultFormat,
      ),
    ]),
  ),
};

const f = new Function('z', `return z.query.${QUERY_STRING};`);
const query: AnyStaticQuery = f(z);

test('manual zql string', async () => {
  await runAndCompare(
    schema,
    staticToRunnable({
      query,
      schema,
      harness,
    }),
    undefined,
  );
});
