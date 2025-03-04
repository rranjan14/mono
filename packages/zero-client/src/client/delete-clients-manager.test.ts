import {beforeEach, expect, test, vi, type Mock} from 'vitest';
import type {Store} from '../../../replicache/src/dag/store.ts';
import {TestStore} from '../../../replicache/src/dag/test-store.ts';
import {
  getDeletedClients,
  setDeletedClients,
} from '../../../replicache/src/deleted-clients.ts';
import {
  withRead,
  withWrite,
} from '../../../replicache/src/with-transactions.ts';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import type {DeleteClientsMessage} from '../../../zero-protocol/src/delete-clients.ts';
import {DeleteClientsManager} from './delete-clients-manager.ts';

let send: Mock<(msg: DeleteClientsMessage) => void>;
let dagStore: Store;
const lc = createSilentLogContext();
let manager: DeleteClientsManager;

beforeEach(() => {
  send = vi.fn<(msg: DeleteClientsMessage) => void>();
  dagStore = new TestStore();
  manager = new DeleteClientsManager(send, dagStore, lc);
  return async () => {
    await dagStore.close();
  };
});

test('onClientsDeleted', () => {
  manager.onClientsDeleted(['a', 'b'], []);
  expect(send).toBeCalledWith([
    'deleteClients',
    {clientIDs: ['a', 'b'], clientGroupIDs: []},
  ]);
});

test('clientsDeletedOnServer', async () => {
  await withWrite(dagStore, dagWrite =>
    setDeletedClients(dagWrite, ['c', 'd', 'e'], []),
  );
  await manager.clientsDeletedOnServer({clientIDs: ['c', 'd']});
  expect(await withRead(dagStore, getDeletedClients)).toEqual({
    clientIDs: ['e'],
    clientGroupIDs: [],
  });
});
