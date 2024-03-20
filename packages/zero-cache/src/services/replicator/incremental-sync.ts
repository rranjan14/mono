import type {LogContext} from '@rocicorp/logger';
import type postgres from 'postgres';
import {ZERO_VERSION_COLUMN_NAME} from './initial-sync.js';
import {getPublicationInfo} from './tables/published.js';

/**
 * Replication metadata, used for invalidation and catchup. These tables
 * are created atomically with the logical replication handoff, after initial
 * data synchronization has completed.
 */
export const CREATE_REPLICATION_TABLES =
  // The transaction log maps each LSN to transaction information.
  // Note that the lsn may become optional for supporting non-Postgres upstreams.
  `
  CREATE SCHEMA IF NOT EXISTS _zero;
  CREATE TABLE _zero.tx_log (
    db_version VARCHAR(38) NOT NULL,
    lsn PG_LSN             NOT NULL,
    time TIMESTAMPTZ       NOT NULL,
    xid INTEGER            NOT NULL,
    PRIMARY KEY(db_version)
  );
` +
  // The change log contains row changes.
  //
  // * `op`: 'i' for INSERT, 'u' for UPDATE, 'd' for DELETE, 't' for TRUNCATE
  // * `row_key`: Empty string for the TRUNCATE op (because primary keys cannot be NULL).
  // * `row`: JSON formatted full row contents, NULL for DELETE / TRUNCATE
  //
  // Note that the `row` data is stored as JSON rather than JSONB to prioritize write
  // throughput, as replication is critical bottleneck in the system. Row values are
  // only needed for catchup, for which JSONB is not particularly advantageous over JSON.
  `
  CREATE TABLE _zero.change_log (
    db_version VARCHAR(38)  NOT NULL,
    table_name VARCHAR(128) NOT NULL,
    row_key TEXT            NOT NULL,
    op CHAR(1)              NOT NULL,
    row JSON,
    PRIMARY KEY(db_version, table_name, row_key)
  );
` +
  // Invalidation registry.
  //
  // * `spec` defines the invalidation function to run,
  //
  // * `bits` indicates the number of bits used to create the
  //    corresponding tag in the `invalidation_index`. The 'spec' is requested
  //    by View Syncers, while 'bits' is decided by the system.
  //
  //    For example, we may decide to start off with 32-bit hashes and later
  //    determine that it is worth increasing the table size to 40-bit hashes
  //    in order to reduce the number of collisions. During the transition, the
  //    Replicator would compute both sizes until the new size has sufficient
  //    coverage (over old versions).
  //
  // * `from_db_version` indicates when the Replicator first started running
  //   the filter. CVRs at or newer than the version are considered covered.
  //
  // * `last_requested` records (approximately) the last time the spec was
  //   requested. This is not exact. It may only be updated if the difference
  //   exceeds some interval, for example. This is used to clean up specs that
  //   are no longer used.
  `
CREATE TABLE _zero.invalidation_registry (
  spec TEXT                   NOT NULL,
  bits SMALLINT               NOT NULL,
  from_db_version VARCHAR(38) NOT NULL,
  last_requested TIMESTAMPTZ  NOT NULL,
  PRIMARY KEY(spec, bits)
);
` +
  // Invalidation index.
  `
CREATE TABLE _zero.invalidation_index (
  hash           BIGINT      NOT NULL,
  db_version     VARCHAR(38) NOT NULL,
  PRIMARY KEY(hash)
);
`;

/**
 * Migration step that sets up the initialized Sync Replica for incremental replication.
 * This includes:
 *
 * * Setting up in the internal _zero tables that track replication state.
 *
 * * Removing the _0_version DEFAULT (used only for initial sync)
 *   and requiring that it be NOT NULL. This is a defensive measure to
 *   enforce that the incremental replication logic always sets the _0_version.
 */
export async function setupReplicationTables(
  lc: LogContext,
  _replicaID: string,
  tx: postgres.TransactionSql,
  upstreamUri: string,
) {
  lc.info?.(`Setting up replication tables for ${upstreamUri}`);

  const replicated = await getPublicationInfo(tx, 'zero_');
  const alterStmts = Object.keys(replicated.tables).map(
    table =>
      `
      ALTER TABLE ${table} 
        ALTER COLUMN ${ZERO_VERSION_COLUMN_NAME} DROP DEFAULT, 
        ALTER COLUMN ${ZERO_VERSION_COLUMN_NAME} SET NOT NULL;
        `,
  );

  await tx.unsafe(alterStmts.join('') + CREATE_REPLICATION_TABLES);
}