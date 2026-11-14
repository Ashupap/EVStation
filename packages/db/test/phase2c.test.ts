import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  INGEST_PASSWORD,
  JOBS_PASSWORD,
  SEED_IDS,
  resetDb,
  startDb,
  stopDb,
  type TestDb,
} from './helpers.js';

const HASH = 'd'.repeat(64);
const STATION_REF = 'ACME-BLR-001';
let db: TestDb;
let ingest: Client;
let jobs: Client;
let listener: Client;
let stationId: string;
let connectorId: string;
let notifications: string[] = [];

beforeAll(async () => {
  db = await startDb();
  const ingestUrl = new URL(db.appUrl);
  ingestUrl.username = 'evstation_ingest';
  ingestUrl.password = INGEST_PASSWORD;
  const jobsUrl = new URL(db.appUrl);
  jobsUrl.username = 'evstation_jobs';
  jobsUrl.password = JOBS_PASSWORD;
  ingest = new Client({ connectionString: ingestUrl.toString() });
  jobs = new Client({ connectionString: jobsUrl.toString() });
  listener = new Client({ connectionString: db.migratorUrl });
  await Promise.all([ingest.connect(), jobs.connect(), listener.connect()]);
  listener.on('notification', (message) => {
    if (message.payload) notifications.push(message.payload);
  });
  await listener.query('LISTEN evstation_events');
});
afterAll(async () => {
  await listener.query('UNLISTEN evstation_events');
  await Promise.all([ingest.end(), jobs.end(), listener.end()]);
  await stopDb(db);
});
beforeEach(async () => {
  await resetDb(db);
  const station = await db.superuser.query<{ id: string }>(
    `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref, registration_status)
     VALUES ($1, $2, 'ACME', $3, 'registered') RETURNING id`,
    [SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, STATION_REF],
  );
  stationId = station.rows[0]!.id;
  const connector = await db.superuser.query<{ id: string }>(
    `INSERT INTO app.connectors (tenant_id, site_id, station_id, connector_number)
     VALUES ($1, $2, $3, 1) RETURNING id`,
    [SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, stationId],
  );
  connectorId = connector.rows[0]!.id;
  notifications = [];
});

async function call(client: Client, fn: string, args: unknown[]): Promise<string> {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
  const { rows } = await client.query<{ result: string }>(
    `SELECT app.${fn}(${placeholders}) AS result`,
    args,
  );
  return rows[0]!.result;
}

async function waitNotifications(ms = 300): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return [...notifications];
}

describe('Phase 2c NOTIFY emission', () => {
  test('heartbeat emits nothing and a committed status emits IDs only', async () => {
    await call(ingest, 'ingest_heartbeat', [STATION_REF, 'hb-1', '2026-11-12T10:00:00Z', HASH]);
    expect(await waitNotifications()).toEqual([]);

    await call(ingest, 'ingest_status', [
      STATION_REF,
      1,
      'Available',
      'NoError',
      '2026-11-12T10:00:01Z',
      'status-1',
      '2026-11-12T10:00:01Z',
      HASH,
    ]);
    const payloads = await waitNotifications();
    expect(payloads).toHaveLength(1);
    const payload = JSON.parse(payloads[0]!) as Record<string, unknown>;
    expect(payload).toMatchObject({
      v: 1,
      kind: 'station.status',
      tenant_id: SEED_IDS.acmeTenant,
      site_id: SEED_IDS.acmeSite1,
      station_id: stationId,
    });
    expect(JSON.stringify(payload)).not.toContain('idTag');
    expect(payload).not.toHaveProperty('data');
  });

  test('rollback emits nothing; commit emits', async () => {
    await ingest.query('BEGIN');
    await call(ingest, 'ingest_status', [
      STATION_REF,
      1,
      'Faulted',
      'NoError',
      '2026-11-12T10:00:02Z',
      'status-rollback',
      '2026-11-12T10:00:02Z',
      HASH,
    ]);
    await ingest.query('ROLLBACK');
    expect(await waitNotifications()).toEqual([]);

    await ingest.query('BEGIN');
    await call(ingest, 'ingest_status', [
      STATION_REF,
      1,
      'Available',
      'NoError',
      '2026-11-12T10:00:03Z',
      'status-commit',
      '2026-11-12T10:00:03Z',
      HASH,
    ]);
    await ingest.query('COMMIT');
    expect(await waitNotifications()).toHaveLength(1);
  });

  test('status NOTIFY carries connector id so same-timestamp statuses cannot collide', async () => {
    const connector2 = await db.superuser.query<{ id: string }>(
      `INSERT INTO app.connectors (tenant_id, site_id, station_id, connector_number)
       VALUES ($1, $2, $3, 2) RETURNING id`,
      [SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, stationId],
    );
    await call(ingest, 'ingest_status', [
      STATION_REF,
      1,
      'Available',
      'NoError',
      '2026-11-12T10:00:05Z',
      'status-connector-1',
      '2026-11-12T10:00:05Z',
      HASH,
    ]);
    await call(ingest, 'ingest_status', [
      STATION_REF,
      2,
      'Faulted',
      'NoError',
      '2026-11-12T10:00:05Z',
      'status-connector-2',
      '2026-11-12T10:00:05Z',
      HASH,
    ]);
    const payloads = (await waitNotifications()).map((item) => JSON.parse(item));
    expect(payloads).toHaveLength(2);
    expect(payloads[1].connector_id).toBe(connector2.rows[0]!.id);
  });

  test('meter notification is throttled and no-op energy does not notify', async () => {
    await call(ingest, 'ingest_transaction_start', [
      STATION_REF,
      'notify-corr',
      1,
      'TAG',
      0,
      '2026-11-12T10:00:00Z',
      'notify-start',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_start_response', [
      STATION_REF,
      'notify-corr',
      'notify-tx',
      'Accepted',
      'notify-response',
      '2026-11-12T10:00:01Z',
      HASH,
    ]);
    await waitNotifications();
    notifications = [];
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'notify-tx',
      'notify-meter-1',
      '2026-11-12T10:01:00Z',
      JSON.stringify([{ recorded_at: '2026-11-12T10:01:00Z', energy_wh: 500 }]),
      HASH,
    ]);
    expect((await waitNotifications()).map((item) => JSON.parse(item).kind)).toEqual([
      'session.meter',
    ]);
    notifications = [];
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'notify-tx',
      'notify-meter-2',
      '2026-11-12T10:01:01Z',
      JSON.stringify([{ recorded_at: '2026-11-12T10:01:01Z', energy_wh: 500 }]),
      HASH,
    ]);
    expect(await waitNotifications()).toEqual([]);
    notifications = [];
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'notify-tx',
      'notify-meter-3',
      '2026-11-12T10:01:06Z',
      JSON.stringify([{ recorded_at: '2026-11-12T10:01:06Z', energy_wh: 750 }]),
      HASH,
    ]);
    expect((await waitNotifications()).map((item) => JSON.parse(item).kind)).toEqual([
      'session.meter',
    ]);
  });

  test('identical csms timestamp does not re-notify meter events', async () => {
    await call(ingest, 'ingest_transaction_start', [
      STATION_REF,
      'same-ts',
      1,
      'TAG',
      0,
      '2026-11-12T10:00:00Z',
      'same-ts-start',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_start_response', [
      STATION_REF,
      'same-ts',
      'same-ts-tx',
      'Accepted',
      'same-ts-response',
      '2026-11-12T10:00:01Z',
      HASH,
    ]);
    await waitNotifications();
    notifications = [];
    const samples = JSON.stringify([{ recorded_at: '2026-11-12T10:01:00Z', energy_wh: 500 }]);
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'same-ts-tx',
      'same-meter-1',
      '2026-11-12T10:01:00Z',
      samples,
      HASH,
    ]);
    expect((await waitNotifications()).map((item) => JSON.parse(item).kind)).toEqual([
      'session.meter',
    ]);
    notifications = [];
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'same-ts-tx',
      'same-meter-2',
      '2026-11-12T10:01:00Z',
      JSON.stringify([{ recorded_at: '2026-11-12T10:01:02Z', energy_wh: 750 }]),
      HASH,
    ]);
    expect(await waitNotifications()).toEqual([]);
  });

  test('job functions emit through the same notifier', async () => {
    await db.superuser.query(
      "UPDATE app.station_runtime_state SET connection_state='connected', last_seen_at=now()-interval '5 minutes' WHERE station_id=$1",
      [stationId],
    );
    await jobs.query('SELECT app.sweep_offline_stations(60)');
    expect((await waitNotifications()).map((item) => JSON.parse(item).kind)).toEqual([
      'station.connection',
    ]);

    notifications = [];
    await db.superuser.query(
      `INSERT INTO app.sessions (tenant_id, site_id, station_id, connector_id, started_at, status)
       VALUES ($1, $2, $3, $4, now() - interval '2 days', 'active')`,
      [SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, stationId, connectorId],
    );
    await jobs.query('SELECT app.close_stale_sessions(86400)');
    expect((await waitNotifications()).map((item) => JSON.parse(item).kind)).toEqual([
      'session.ended',
    ]);

    notifications = [];
    await call(ingest, 'ingest_transaction_start', [
      STATION_REF,
      'expire-notify',
      1,
      'TAG',
      0,
      '2026-11-12T10:00:00Z',
      'expire-notify-start',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    await db.superuser.query(
      "UPDATE app.pending_transaction_starts SET expires_at=now()-interval '1 minute'",
    );
    await jobs.query('SELECT app.expire_pending_starts(100)');
    expect(await waitNotifications()).toEqual([]);
  });

  test('NOTIFY helper and job functions keep the 0032 owner pattern', async () => {
    const owners = await db.superuser.query<{ proname: string; owner: string; secdef: boolean }>(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='app'
         AND p.proname IN ('notify_event','ingest_status','sweep_offline_stations','close_stale_sessions')
       ORDER BY p.proname`,
    );
    expect(owners.rows.find((row) => row.proname === 'notify_event')?.secdef).toBe(false);
    for (const row of owners.rows.filter((row) => row.proname !== 'notify_event')) {
      expect(row.owner).toBe('evstation_ingest_definer');
      expect(row.secdef).toBe(true);
    }
  });
});
