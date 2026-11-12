#!/usr/bin/env node
/**
 * Phase 2 RLS performance evidence (local/dev only).
 *
 * Seeds 1M sessions, 1M meter values and 1M status events for the Acme site,
 * then runs tenant-admin and site-manager keyset pagination under RLS.
 *
 *   node packages/db/scripts/phase2-perf.mjs
 *
 * The script refuses to run when NODE_ENV=production and truncates only the
 * Phase 2 session/event tables. It is a reproducibility helper, not a runtime
 * job.
 */
import { Client } from 'pg';
import { dbCredentials } from './lib.mjs';
import { SEED_IDS } from './seed.mjs';

if (process.env.NODE_ENV === 'production') {
  throw new Error('refusing to run Phase 2 performance seeding with NODE_ENV=production');
}

const STATION = '90000000-0000-4000-8000-000000000001';
const CONNECTOR = '90000000-0000-4000-8000-000000000002';
const SESSION = '90000000-0000-4000-8000-000000000003';
const TENANT = SEED_IDS.acmeTenant;
const SITE = SEED_IDS.acmeSite1;
const ADMIN = SEED_IDS.acmeAdmin;
const MANAGER = SEED_IDS.acmeSiteManager;
const START = '2026-11-01T00:00:00Z';
const END = '2026-12-01T00:00:00Z';
const ROWS = 1_000_000;

const credentials = dbCredentials();
const admin = new Client({ connectionString: credentials.migrator });
await admin.connect();
await admin.query('SET synchronous_commit = off');
await admin.query(
  `TRUNCATE app.ingestion_events, app.pending_transaction_starts,
     app.station_status_events, app.session_meter_values, app.sessions,
     app.connectors, app.station_runtime_state, app.stations CASCADE`,
);
await admin.query(
  `INSERT INTO app.stations (id, tenant_id, site_id, org_code, station_ref, registration_status, credentials_state)
   VALUES ($1, $2, $3, 'ACME', 'ACME-BLR-900', 'registered', 'provisioned')`,
  [STATION, TENANT, SITE],
);
await admin.query(
  `INSERT INTO app.connectors (id, tenant_id, site_id, station_id, connector_number, type, status)
   VALUES ($1, $2, $3, $4, 1, 'CCS2', 'charging')`,
  [CONNECTOR, TENANT, SITE, STATION],
);
await admin.query(
  `INSERT INTO app.sessions (id, tenant_id, site_id, station_id, connector_id,
     csms_transaction_ref, csms_start_correlation_id, started_at, energy_wh, status)
   VALUES ($1, $2, $3, $4, $5, 'perf-seed', 'perf-seed-corr', $6, 0, 'completed')`,
  [SESSION, TENANT, SITE, STATION, CONNECTOR, START],
);

let seedStarted = Date.now();
console.log(`phase2-perf: seeding ${ROWS.toLocaleString()} sessions`);
await admin.query(
  `INSERT INTO app.sessions (id, tenant_id, site_id, station_id, connector_id,
     csms_transaction_ref, csms_start_correlation_id, started_at, energy_wh, status)
   SELECT md5('perf-session-' || i)::uuid, $1, $2, $3, $4,
          'perf-tx-' || i, 'perf-corr-' || i,
          $5::timestamptz + ((i % 2592000) * interval '1 second'),
          i % 10000, 'completed'
   FROM generate_series(1, $6) i`,
  [TENANT, SITE, STATION, CONNECTOR, START, ROWS],
);
console.log(`phase2-perf: sessions seeded in ${Date.now() - seedStarted}ms`);

seedStarted = Date.now();
console.log(`phase2-perf: seeding ${ROWS.toLocaleString()} meter values`);
await admin.query(
  `INSERT INTO app.session_meter_values
     (tenant_id, site_id, station_id, session_id, csms_event_ref, csms_timestamp,
      charger_reported_at, energy_wh, power_w)
   SELECT $1, $2, $3, $4, 'perf-meter-' || i,
          $5::timestamptz + ((i % 2592000) * interval '1 second'),
          $5::timestamptz + ((i % 2592000) * interval '1 second'),
          i % 10000, 30000
   FROM generate_series(1, $6) i`,
  [TENANT, SITE, STATION, SESSION, START, ROWS],
);
console.log(`phase2-perf: meter values seeded in ${Date.now() - seedStarted}ms`);

seedStarted = Date.now();
console.log(`phase2-perf: seeding ${ROWS.toLocaleString()} status events`);
await admin.query(
  `INSERT INTO app.station_status_events
     (tenant_id, site_id, station_id, connector_id, status, error_code, csms_event_ref,
      csms_timestamp, charger_reported_at)
   SELECT $1, $2, $3, $4, 'available', 'NoError', 'perf-status-' || i,
          $5::timestamptz + ((i % 2592000) * interval '1 second'),
          $5::timestamptz + ((i % 2592000) * interval '1 second')
   FROM generate_series(1, $6) i`,
  [TENANT, SITE, STATION, CONNECTOR, START, ROWS],
);
console.log(`phase2-perf: status events seeded in ${Date.now() - seedStarted}ms`);

await admin.query('ANALYZE app.sessions');
await admin.query('ANALYZE app.session_meter_values');
await admin.query('ANALYZE app.station_status_events');

const queries = [
  [
    'sessions',
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT id, station_id, started_at, energy_wh FROM app.sessions
     WHERE tenant_id = $1 AND started_at < $2
     ORDER BY started_at DESC, id DESC LIMIT 51`,
    [TENANT, END],
  ],
  [
    'session_meter_values',
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT id, session_id, csms_timestamp, energy_wh FROM app.session_meter_values
     WHERE tenant_id = $1 AND csms_timestamp < $2
     ORDER BY csms_timestamp DESC, id DESC LIMIT 51`,
    [TENANT, END],
  ],
  [
    'station_status_events',
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT id, station_id, csms_timestamp, status FROM app.station_status_events
     WHERE tenant_id = $1 AND csms_timestamp < $2
     ORDER BY csms_timestamp DESC, id DESC LIMIT 51`,
    [TENANT, END],
  ],
];

for (const [role, actor] of [
  ['tenant_admin', ADMIN],
  ['site_manager', MANAGER],
]) {
  const app = new Client({ connectionString: credentials.app });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.actor_id', $1, true)", [actor]);
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT]);
    for (const [name, sql, params] of queries) {
      const started = Date.now();
      const plan = await app.query(sql, params);
      console.log(`\n=== ${role} ${name} (${Date.now() - started}ms) ===`);
      console.log(plan.rows.map((row) => row['QUERY PLAN']).join('\n'));
    }
    await app.query('ROLLBACK');
  } finally {
    await app.end();
  }
}

await admin.end();
console.log('\nphase2-perf: done');
