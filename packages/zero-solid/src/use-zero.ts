import {
  batch,
  createContext,
  createMemo,
  onCleanup,
  splitProps,
  useContext,
  type Accessor,
  type JSX,
} from 'solid-js';
import type {CustomMutatorDefs} from '../../zero-client/src/client/custom.ts';
import type {ZeroOptions} from '../../zero-client/src/client/options.ts';
import {Zero} from '../../zero-client/src/client/zero.ts';
import type {Schema} from '../../zero-schema/src/builder/schema-builder.ts';

// oxlint-disable-next-line no-explicit-any
const ZeroContext = createContext<Accessor<Zero<any, any>> | undefined>(
  undefined,
);

export function createZero<S extends Schema, MD extends CustomMutatorDefs>(
  options: ZeroOptions<S, MD>,
): Zero<S, MD> {
  const opts = {
    ...options,
    batchViewUpdates: batch,
  };
  return new Zero(opts);
}

export function useZero<
  S extends Schema,
  MD extends CustomMutatorDefs | undefined = undefined,
>(): () => Zero<S, MD> {
  const zero = useContext(ZeroContext);

  if (zero === undefined) {
    throw new Error('useZero must be used within a ZeroProvider');
  }
  return zero;
}

export function createUseZero<
  S extends Schema,
  MD extends CustomMutatorDefs | undefined = undefined,
>() {
  return () => useZero<S, MD>();
}

export function ZeroProvider<
  S extends Schema,
  MD extends CustomMutatorDefs | undefined = undefined,
>(
  props: {children: JSX.Element} & (
    | {
        zero: Zero<S, MD>;
      }
    | ZeroOptions<S, MD>
  ),
) {
  const zero = createMemo(() => {
    if ('zero' in props) {
      return props.zero;
    }
    const [, options] = splitProps(props, ['children']);
    const createdZero = new Zero({
      ...options,
      batchViewUpdates: batch,
    });
    onCleanup(() => createdZero.close());
    return createdZero;
  });

  return ZeroContext.Provider({
    value: zero,
    get children() {
      return props.children;
    },
  });
}
