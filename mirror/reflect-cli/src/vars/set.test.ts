import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from '@jest/globals';
import {existsSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {listDevVars, setFileOverriddeForTests} from '../dev/vars.js';
import {UserError} from '../error.js';
import {setVarsHandler} from './set.js';

describe('set vars', () => {
  let varsFile: string;

  beforeAll(async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'reflect-dev-vars-test-'),
    );
    varsFile = path.join(dir, 'dev-vars.env');
    setFileOverriddeForTests(varsFile);
  });

  afterEach(async () => {
    if (existsSync(varsFile)) {
      await fs.unlink(varsFile);
    }
  });

  afterAll(() => {
    setFileOverriddeForTests(undefined);
  });

  const ignoredYargs = {
    stack: 'sandbox',
    v: undefined,
    runAs: undefined,
    local: false,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    _: [],
    $0: '',
  };

  /* eslint-disable @typescript-eslint/naming-convention */
  test('set and list', async () => {
    await setVarsHandler({
      ...ignoredYargs,
      dev: true,
      keysAndValues: ['FOO=bar', 'BAR=baz'],
    });
    expect(await fs.readFile(varsFile, 'utf-8')).toBe('BAR=baz\nFOO=bar');
    expect(listDevVars()).toEqual({
      BAR: 'baz',
      FOO: 'bar',
    });
  });

  test('set keys with javascript Object method names', async () => {
    await setVarsHandler({
      ...ignoredYargs,
      dev: true,
      keysAndValues: ['FOO=bar', 'toString=this-should-still-work'],
    });
    expect(listDevVars()).toEqual({
      FOO: 'bar',
      toString: 'this-should-still-work',
    });
  });

  test('rejects duplicate keys', async () => {
    let err;
    try {
      await setVarsHandler({
        ...ignoredYargs,
        dev: true,
        keysAndValues: ['FOO=bar', 'FOO=boo'],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UserError);
    expect(listDevVars()).toEqual({});
  });
  /* eslint-enable @typescript-eslint/naming-convention */
});