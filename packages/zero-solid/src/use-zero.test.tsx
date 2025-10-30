import {renderHook} from '@solidjs/testing-library';
import {createSignal, type JSX} from 'solid-js';
import {expect, test, vi} from 'vitest';
import type {Zero} from '../../zero-client/src/client/zero.ts';
import type {Schema} from '../../zero-schema/src/builder/schema-builder.ts';
import {useZero, ZeroProvider} from './use-zero.ts';

vi.mock('../../zero-client/src/client/zero.ts', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../zero-client/src/client/zero.ts')
  >()),
  Zero: class {
    closed = false;

    close() {
      this.closed = true;
    }
  },
}));

class FakeZero {
  closed = false;

  close() {
    this.closed = true;
  }
}

test('if zero options change ZeroProvider closes previous instance if it created it', () => {
  const [server, setServer] = createSignal('foo');
  const MockZeroProvider = (props: {children: JSX.Element}) => (
    <ZeroProvider
      server={server()}
      userID={'u'}
      schema={{tables: {}, relationships: {}}}
    >
      {props.children}
    </ZeroProvider>
  );
  const {result} = renderHook(useZero, {
    initialProps: [],
    wrapper: MockZeroProvider,
  });

  const zero0 = result();
  expect(zero0?.closed).toBe(false);

  setServer('bar');

  expect(zero0?.closed).toBe(true);

  const zero1 = result();
  expect(zero0).not.toBe(zero1);
});

test('if Zero instance changes, ZeroProvider does not close Zero instance it did not create', () => {
  const fakeZero0 = new FakeZero() as unknown as Zero<Schema>;
  const [zero, setZero] = createSignal<Zero<Schema, undefined>>(fakeZero0);
  const MockZeroProvider = (props: {children: JSX.Element}) => (
    <ZeroProvider zero={zero()}>{props.children}</ZeroProvider>
  );
  const {result} = renderHook(useZero, {
    initialProps: [],
    wrapper: MockZeroProvider,
  });

  const zero0 = result();
  expect(zero0).toBe(fakeZero0);
  expect(zero0?.closed).toBe(false);

  const fakeZero1 = new FakeZero() as unknown as Zero<Schema>;

  setZero(fakeZero1);

  const zero1 = result();
  expect(zero1).not.toBe(zero0);

  expect(zero0?.closed).toBe(false);
  expect(zero1?.closed).toBe(false);
});

test('ZeroProvider does not recreate zero if just children change', () => {
  const [wrapInDiv, setWrapInDiv] = createSignal(false);
  const MockZeroProvider = (props: {children: JSX.Element}) => (
    <ZeroProvider
      server={'foo'}
      userID={'u'}
      schema={{tables: {}, relationships: {}}}
    >
      {wrapInDiv() ? <div>props.children</div> : props.children}
    </ZeroProvider>
  );
  const {result} = renderHook(useZero, {
    initialProps: [],
    wrapper: MockZeroProvider,
  });

  const zero0 = result();
  expect(zero0?.closed).toBe(false);

  setWrapInDiv(true);

  expect(zero0?.closed).toBe(false);

  const zero1 = result();
  expect(zero0).toBe(zero1);
});

test('if zero options change but are === to prev, instance ZeroProvider does not recreate Zero, but does if options are deep equal but not ===', () => {
  const [server, setServer] = createSignal('foo');
  const [schema, setSchema] = createSignal<Schema>({
    tables: {},
    relationships: {},
  });
  const MockZeroProvider = (props: {children: JSX.Element}) => (
    <ZeroProvider server={server()} userID={'u'} schema={schema()}>
      {props.children}
    </ZeroProvider>
  );
  const {result} = renderHook(useZero, {
    initialProps: [],
    wrapper: MockZeroProvider,
  });

  const zero0 = result();
  expect(zero0?.closed).toBe(false);

  setServer('foo');

  expect(zero0?.closed).toBe(false);

  expect(result()).toBe(zero0);

  setSchema(schema());

  expect(zero0?.closed).toBe(false);

  expect(result()).toBe(zero0);

  setSchema({...schema()});

  expect(zero0?.closed).toBe(true);

  const zero1 = result();
  expect(zero1).not.toBe(zero0);
});

test('useZero throws if not used within a ZeroProvider', () => {
  expect(() => {
    renderHook(useZero, {
      initialProps: [],
    });
  }).toThrow('useZero must be used within a ZeroProvider');
});
