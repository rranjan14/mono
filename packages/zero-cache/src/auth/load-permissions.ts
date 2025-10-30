import type {LogContext} from '@rocicorp/logger';
import * as v from '../../../shared/src/valita.ts';
import type {Schema} from '../../../zero-schema/src/builder/schema-builder.ts';
import {
  permissionsConfigSchema,
  type PermissionsConfig,
} from '../../../zero-schema/src/compiled-permissions.ts';
import type {TableSchema} from '../../../zero-schema/src/table-schema.ts';
import type {Database} from '../../../zqlite/src/db.ts';
import {computeZqlSpecs} from '../db/lite-tables.ts';
import type {StatementRunner} from '../db/statements.ts';
import {elide} from '../types/strings.ts';

export type LoadedPermissions = {
  permissions: PermissionsConfig | null;
  hash: string | null;
};

export function loadPermissions(
  lc: LogContext,
  replica: StatementRunner,
  appID: string,
): LoadedPermissions {
  const {permissions, hash} = replica.get(
    `SELECT permissions, hash FROM "${appID}.permissions"`,
  );
  if (permissions === null) {
    const appIDFlag = appID === 'zero' ? '' : ` --app-id=${appID}`;
    lc.warn?.(
      `\n\n\n` +
        `No upstream permissions deployed.\n` +
        `Run 'npx zero-deploy-permissions${appIDFlag}' to enforce permissions.` +
        `\n\n\n`,
    );
    return {permissions, hash: null};
  }
  let obj;
  let parsed;
  try {
    obj = JSON.parse(permissions);
    parsed = v.parse(obj, permissionsConfigSchema);
  } catch (e) {
    // TODO: Plumb the --server-version and include in error message.
    throw new Error(
      `Could not parse upstream permissions: ` +
        `'${elide(String(permissions), 100)}'.\n` +
        `This may happen if Permissions with a new internal format are ` +
        `deployed before the supporting server has been fully rolled out.`,
      {cause: e},
    );
  }
  return {permissions: parsed, hash};
}

export function reloadPermissionsIfChanged(
  lc: LogContext,
  replica: StatementRunner,
  appID: string,
  current: LoadedPermissions | null,
): {permissions: LoadedPermissions; changed: boolean} {
  if (current === null) {
    return {permissions: loadPermissions(lc, replica, appID), changed: true};
  }
  const {hash} = replica.get(`SELECT hash FROM "${appID}.permissions"`);
  return hash === current.hash
    ? {permissions: current, changed: false}
    : {permissions: loadPermissions(lc, replica, appID), changed: true};
}

export function getSchema(lc: LogContext, replica: Database): Schema {
  const specs = computeZqlSpecs(lc, replica);
  const tables = Object.fromEntries(
    [...specs.values()].map(table => {
      const {
        tableSpec: {name, primaryKey},
        zqlSpec: columns,
      } = table;
      return [name, {name, columns, primaryKey} satisfies TableSchema];
    }),
  );
  return {
    tables,
    relationships: {}, // relationships are already denormalized in ASTs
  };
}
