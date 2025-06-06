/**
 * This error is thrown when you try to call methods on a closed transaction.
 */
export class TransactionClosedError extends Error {
  constructor() {
    super('Transaction is closed');
  }
}

export type Closed = {closed: boolean};

export function throwIfClosed(tx: Closed): void {
  if (tx.closed) {
    throw new TransactionClosedError();
  }
}

export function rejectIfClosed(tx: Closed): undefined | Promise<never> {
  return tx.closed ? Promise.reject(new TransactionClosedError()) : undefined;
}
