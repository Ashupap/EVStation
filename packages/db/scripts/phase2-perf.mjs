#!/usr/bin/env node
/**
 * Phase 2 RLS performance evidence (local/dev only).
 *
 * Seeds a multi-tenant, multi-month, 1M-row dataset and runs tenant-admin,
 * site-manager and station-list plans under RLS.
 *
 *   node packages/db/scripts/phase2-perf.mjs
 *
 * Refuses NODE_ENV=production. The script truncates only Phase 2 tables.
 */
import { Client } from 'pg';
import { dbCredentials } from './lib.mjs';
import { SEED_IDS } from './seed.mjs';

if (process.env.NODE_ENV === 'production') {
  throw new Error('refusing to run Phase 2 performance seeding with NODE_ENV=production');
}

const A = SEED_IDS.acmeTenant;
const B = SEED_IDS.betaTenant;
const SITE_A1 = SEED_IDS.acmeSite1;
const SITE_B1 = SEED_IDS.betaSite1;
const ADMIN = SEED_IDS.acmeAdmin;
const MANAGER = SEED_IDS.acmeSiteManager;
const STATION_B = '91000000-0000-4000-8000-000000000001';
const CONNECTOR_B = '91000000-0000-4000-8000-000000000002';
const SESSION_B = '91000000-0000-4000-8000-000000000003';
const START = '2026-11-01T00:00:00Z';
const END = '2027-02-01T00:00:00Z';
const A_ROWS = 900_000;
const B_ROWS = 100_000;
const SITES = 1_000;

const credentials = dbCredentials();
const admin = new Client({ connectionString: credentials.migrator });
await admin.connect();
await admin.query('SET synchronous_commit = off');
await admin.query(
  `TRUNCATE app.ingestion_events, app.pending_transaction_starts,
     app.station_status_events, app.session_meter_values, app.sessions,
     app.connectors, app.station_runtime_state, app.stations CASCADE`,
);

// 999 extra Acme sites; seed site A1 is n=0. Beta uses seed site B1.
await admin.query(
  `INSERT INTO app.sites (id, tenant_id, name, site_code)
   SELECT md5('perf-site-' || n)::uuid, $1, 'Perf Site ' || n,
          'S' || lpad(n::text, 5, '0')
   FROM generate_series(1, $2) n`,
  [A, SITES - 1],
);

await admin.query(
  `INSERT INTO app.stations (id, tenant_id, site_id, org_code, station_ref,
     registration_status, credentials_state)
   SELECT md5('perf-station-' || n)::uuid, $1,
          CASE WHEN n = 0 THEN $2::uuid ELSE md5('perf-site-' || n)::uuid END,
          'ACME',
          CASE WHEN n = 0 THEN 'ACME-BLR-900'
               ELSE 'ACME-S' || lpad(n::text, 5, '0') || '-001' END,
          'registered', 'provisioned'
   FROM generate_series(0, $3 - 1) n`,
  [A, SITE_A1, SITES],
);
await admin.query(
  `INSERT INTO app.connectors (id, tenant_id, site_id, station_id, connector_number, type, status)
   SELECT md5('perf-connector-' || n)::uuid, $1,
          CASE WHEN n = 0 THEN $2::uuid ELSE md5('perf-site-' || n)::uuid END,
          md5('perf-station-' || n)::uuid, 1, 'CCS2', 'charging'
   FROM generate_series(0, $3 - 1) n`,
  [A, SITE_A1, SITES],
);
await admin.query(
  `UPDATE app.station_runtime_state SET connection_state = 'connected', last_heartbeat_at = now()
   WHERE tenant_id = $1`,
  [A],
);

// Beta tenant has one station for multi-tenant isolation/plan coverage.
await admin.query(
  `INSERT INTO app.stations (id, tenant_id, site_id, org_code, station_ref,
     registration_status, credentials_state)
   VALUES ($1, $2, $3, 'BETA', 'BETA-BOM-900', 'registered', 'provisioned')`,
  [STATION_B, B, SITE_B1],
);
await admin.query(
  `INSERT INTO app.connectors (id, tenant_id, site_id, station_id, connector_number, type, status)
   VALUES ($1, $2, $3, $4, 1, 'CCS2', 'charging')`,
  [CONNECTOR_B, B, SITE_B1, STATION_B],
);
await admin.query(
  `UPDATE app.station_runtime_state SET connection_state = 'connected', last_heartbeat_at = now()
   WHERE station_id = $1`,
  [STATION_B],
);

// One durable session per Acme site, used as the FK target for meter values.
await admin.query(
  `INSERT INTO app.sessions (id, tenant_id, site_id, station_id, connector_id,
     csms_transaction_ref, csms_start_correlation_id, started_at, energy_wh, status)
   SELECT md5('perf-seed-session-' || n)::uuid, $1,
          CASE WHEN n = 0 THEN $2::uuid ELSE md5('perf-site-' || n)::uuid END,
          md5('perf-station-' || n)::uuid, md5('perf-connector-' || n)::uuid,
          'perf-seed-tx-' || n, 'perf-seed-corr-' || n, $3, 0, 'completed'
   FROM generate_series(0, $4 - 1) n`,
  [A, SITE_A1, START, SITES],
);
await admin.query(
  `INSERT INTO app.sessions (id, tenant_id, site_id, station_id, connector_id,
     csms_transaction_ref, csms_start_correlation_id, started_at, energy_wh, status)
   VALUES ($1, $2, $3, $4, $5, 'perf-seed-tx-beta', 'perf-seed-corr-beta', $6, 0, 'completed')`,
  [SESSION_B, B, SITE_B1, STATION_B, CONNECTOR_B, START],
);

let seedStarted = Date.now();
console.log(`phase2-perf: seeding ${(A_ROWS + B_ROWS).toLocaleString()} sessions`);
await admin.query(
  `INSERT INTO app.sessions (id, tenant_id, site_id, station_id, connector_id,
     csms_transaction_ref, csms_start_correlation_id, started_at, energy_wh, status)
   SELECT md5('perf-session-a-' || i)::uuid, $1,
          CASE WHEN (i % $3) = 0 THEN $4::uuid ELSE md5('perf-site-' || (i % $3))::uuid END,
          md5('perf-station-' || (i % $3))::uuid, md5('perf-connector-' || (i % $3))::uuid,
          'perf-tx-a-' || i, 'perf-corr-a-' || i,
          $5::timestamptz + ((i % 7776000) * interval '1 second'),
          i % 10000, 'completed'
   FROM generate_series(1, $2) i`,
  [A, A_ROWS, SITES, SITE_A1, START],
);
await admin.query(
  `INSERT INTO app.sessions (id, tenant_id, site_id, station_id, connector_id,
     csms_transaction_ref, csms_start_correlation_id, started_at, energy_wh, status)
   SELECT md5('perf-session-b-' || i)::uuid, $1, $2, $3, $4,
          'perf-tx-b-' || i, 'perf-corr-b-' || i,
          $5::timestamptz + ((i % 7776000) * interval '1 second'),
          i % 10000, 'completed'
   FROM generate_series(1, $6) i`,
  [B, SITE_B1, STATION_B, CONNECTOR_B, START, B_ROWS],
);
console.log(`phase2-perf: sessions seeded in ${Date.now() - seedStarted}ms`);

seedStarted = Date.now();
console.log(`phase2-perf: seeding ${(A_ROWS + B_ROWS).toLocaleString()} meter values`);
await admin.query(
  `INSERT INTO app.session_meter_values
     (tenant_id, site_id, station_id, session_id, csms_event_ref, csms_timestamp,
      charger_reported_at, energy_wh, power_w)
   SELECT $1,
          CASE WHEN (i % $3) = 0 THEN $4::uuid ELSE md5('perf-site-' || (i % $3))::uuid END,
          md5('perf-station-' || (i % $3))::uuid,
          md5('perf-seed-session-' || (i % $3))::uuid,
          'perf-meter-a-' || i,
          $5::timestamptz + ((i % 7776000) * interval '1 second'),
          $5::timestamptz + ((i % 7776000) * interval '1 second'),
          i % 10000, 30000
   FROM generate_series(1, $2) i`,
  [A, A_ROWS, SITES, SITE_A1, START],
);
await admin.query(
  `INSERT INTO app.session_meter_values
     (tenant_id, site_id, station_id, session_id, csms_event_ref, csms_timestamp,
      charger_reported_at, energy_wh, power_w)
   SELECT $1, $2, $3, $4, 'perf-meter-b-' || i,
          $5::timestamptz + ((i % 7776000) * interval '1 second'),
          $5::timestamptz + ((i % 7776000) * interval '1 second'),
          i % 10000, 30000
   FROM generate_series(1, $6) i`,
  [B, SITE_B1, STATION_B, SESSION_B, START, B_ROWS],
);
console.log(`phase2-perf: meter values seeded in ${Date.now() - seedStarted}ms`);

seedStarted = Date.now();
console.log(`phase2-perf: seeding ${(A_ROWS + B_ROWS).toLocaleString()} status events`);
await admin.query(
  `INSERT INTO app.station_status_events
     (tenant_id, site_id, station_id, connector_id, status, error_code, csms_event_ref,
      csms_timestamp, charger_reported_at)
   SELECT $1,
          CASE WHEN (i % $3) = 0 THEN $4::uuid ELSE md5('perf-site-' || (i % $3))::uuid END,
          md5('perf-station-' || (i % $3))::uuid,
          md5('perf-connector-' || (i % $3))::uuid,
          'available', 'NoError', 'perf-status-a-' || i,
          $5::timestamptz + ((i % 7776000) * interval '1 second'),
          $5::timestamptz + ((i % 7776000) * interval '1 second')
   FROM generate_series(1, $2) i`,
  [A, A_ROWS, SITES, SITE_A1, START],
);
await admin.query(
  `INSERT INTO app.station_status_events
     (tenant_id, site_id, station_id, connector_id, status, error_code, csms_event_ref,
      csms_timestamp, charger_reported_at)
   SELECT $1, $2, $3, $4, 'available', 'NoError', 'perf-status-b-' || i,
          $5::timestamptz + ((i % 7776000) * interval '1 second'),
          $5::timestamptz + ((i % 7776000) * interval '1 second')
   FROM generate_series(1, $6) i`,
  [B, SITE_B1, STATION_B, CONNECTOR_B, START, B_ROWS],
);
console.log(`phase2-perf: status events seeded in ${Date.now() - seedStarted}ms`);

for (const table of ['sessions', 'session_meter_values', 'station_status_events', 'stations']) {
  await admin.query(`ANALYZE app.${table}`);
}

const queries = [
  [
    'sessions',
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT id, station_id, started_at, energy_wh FROM app.sessions
     WHERE tenant_id = $1 AND started_at < $2
     ORDER BY started_at DESC, id DESC LIMIT 51`,
    [A, END],
  ],
  [
    'session_meter_values',
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT id, session_id, csms_timestamp, energy_wh FROM app.session_meter_values
     WHERE tenant_id = $1 AND csms_timestamp < $2
     ORDER BY csms_timestamp DESC, id DESC LIMIT 51`,
    [A, END],
  ],
  [
    'station_status_events',
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT id, station_id, csms_timestamp, status FROM app.station_status_events
     WHERE tenant_id = $1 AND csms_timestamp < $2
     ORDER BY csms_timestamp DESC, id DESC LIMIT 51`,
    [A, END],
  ],
  [
    'stations',
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT s.id, s.station_ref, r.connection_state, r.last_heartbeat_at
     FROM app.stations s
     LEFT JOIN app.station_runtime_state r ON r.station_id = s.id
     ORDER BY s.station_ref, s.id LIMIT 51`,
    [],
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
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
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
