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

const HASH = 'b'.repeat(64);
const STATION_REF = 'ACME-BLR-001';
let db: TestDb;
let ingest: Client;
let jobs: Client;
let stationId: string;
let connectorId: string;

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
  await Promise.all([ingest.connect(), jobs.connect()]);
});
afterAll(async () => {
  await Promise.all([ingest.end(), jobs.end()]);
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
});

async function call(client: Client, fn: string, args: unknown[]): Promise<string> {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
  const { rows } = await client.query<{ result: string }>(
    `SELECT app.${fn}(${placeholders}) AS result`,
    args,
  );
  return rows[0]!.result;
}

async function start(corr: string, meterStart = 0, tx = 'txn') {
  await call(ingest, 'ingest_transaction_start', [
    STATION_REF,
    corr,
    1,
    'TAG',
    meterStart,
    '2026-11-12T10:00:00Z',
    `start-${corr}`,
    '2026-11-12T10:00:00Z',
    HASH,
  ]);
  return call(ingest, 'ingest_transaction_start_response', [
    STATION_REF,
    corr,
    tx,
    'Accepted',
    `response-${corr}`,
    '2026-11-12T10:00:01Z',
    HASH,
  ]);
}

describe('Phase 2b review fixes', () => {
  test('session energy subtracts non-zero meterStart from the cumulative register', async () => {
    await start('energy', 1000, 'energy-tx');
    const samples = JSON.stringify([
      { recorded_at: '2026-11-12T10:01:00Z', energy_wh: 1500, power_w: 7000 },
    ]);
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'energy-tx',
      'energy-meter',
      '2026-11-12T10:01:00Z',
      samples,
      HASH,
    ]);
    let session = await db.superuser.query<{ energy_wh: string }>(
      "SELECT energy_wh::text FROM app.sessions WHERE csms_transaction_ref='energy-tx'",
    );
    expect(session.rows[0]?.energy_wh).toBe('500');
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'energy-tx',
      'energy-meter-2',
      '2026-11-12T10:02:00Z',
      JSON.stringify([{ recorded_at: '2026-11-12T10:02:00Z', energy_wh: 1700 }]),
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_stop', [
      STATION_REF,
      'energy-tx',
      1700,
      'Local',
      '2026-11-12T10:03:00Z',
      'energy-stop',
      '2026-11-12T10:03:00Z',
      HASH,
    ]);
    session = await db.superuser.query<{ energy_wh: string }>(
      "SELECT energy_wh::text FROM app.sessions WHERE csms_transaction_ref='energy-tx'",
    );
    expect(session.rows[0]?.energy_wh).toBe('700');
  });

  test('redelivered start response is duplicate by correlation id', async () => {
    expect(await start('redeliver', 0, 'redeliver-tx')).toBe('accepted');
    expect(
      await call(ingest, 'ingest_transaction_start_response', [
        STATION_REF,
        'redeliver',
        'redeliver-tx',
        'Accepted',
        'response-redeliver-2',
        '2026-11-12T10:00:02Z',
        HASH,
      ]),
    ).toBe('duplicate');
    const count = await db.superuser.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.sessions',
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  test('liveness revives a lost connected state and any frame updates last_seen', async () => {
    await call(ingest, 'ingest_connection', [
      STATION_REF,
      'connected',
      'liveness-connected',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    await call(ingest, 'ingest_connection', [
      STATION_REF,
      'closed',
      'liveness-closed',
      '2026-11-12T10:01:00Z',
      HASH,
    ]);
    await call(ingest, 'ingest_heartbeat', [
      STATION_REF,
      'liveness-heartbeat',
      '2026-11-12T10:02:00Z',
      HASH,
    ]);
    let runtime = await db.superuser.query<{ connection_state: string }>(
      'SELECT connection_state FROM app.station_runtime_state WHERE station_id=$1',
      [stationId],
    );
    expect(runtime.rows[0]?.connection_state).toBe('connected');

    await db.superuser.query(
      "UPDATE app.station_runtime_state SET connection_state='connected', last_seen_at=now()-interval '5 minutes' WHERE station_id=$1",
      [stationId],
    );
    expect(
      Number(
        (await jobs.query<{ result: number }>('SELECT app.sweep_offline_stations(60) AS result'))
          .rows[0]?.result,
      ),
    ).toBe(1);
    const afterSweep = await db.superuser.query<{
      connection_state: string;
      last_disconnected_at: Date;
    }>(
      'SELECT connection_state, last_disconnected_at FROM app.station_runtime_state WHERE station_id=$1',
      [stationId],
    );
    expect(afterSweep.rows[0]?.connection_state).toBe('disconnected');
    expect(afterSweep.rows[0]?.last_disconnected_at).not.toBeNull();
    await db.superuser.query(
      "UPDATE app.station_runtime_state SET last_disconnected_at='2026-11-12T10:03:00Z' WHERE station_id=$1",
      [stationId],
    );
    await call(ingest, 'ingest_heartbeat', [
      STATION_REF,
      'liveness-revive',
      '2026-11-12T10:04:00Z',
      HASH,
    ]);
    runtime = await db.superuser.query<{ connection_state: string }>(
      'SELECT connection_state FROM app.station_runtime_state WHERE station_id=$1',
      [stationId],
    );
    expect(runtime.rows[0]?.connection_state).toBe('connected');
  });

  test('stale sessions require station offline and use CSMS activity time', async () => {
    await db.superuser.query(
      `INSERT INTO app.sessions (tenant_id, site_id, station_id, connector_id, started_at, status)
       VALUES ($1, $2, $3, $4, now() - interval '2 days', 'active')`,
      [SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, stationId, connectorId],
    );
    await db.superuser.query(
      "UPDATE app.station_runtime_state SET connection_state='connected', last_seen_at=now() WHERE station_id=$1",
      [stationId],
    );
    let result = await jobs.query<{ result: number }>(
      'SELECT app.close_stale_sessions(86400) AS result',
    );
    expect(Number(result.rows[0]?.result)).toBe(0);
    await db.superuser.query(
      "UPDATE app.station_runtime_state SET connection_state='disconnected' WHERE station_id=$1",
      [stationId],
    );
    result = await jobs.query('SELECT app.close_stale_sessions(86400) AS result');
    expect(Number(result.rows[0]?.result)).toBe(1);
  });

  test('expired pending starts write START_RESPONSE_MISSING to the ledger', async () => {
    await call(ingest, 'ingest_transaction_start', [
      STATION_REF,
      'expire-corr',
      1,
      'TAG',
      0,
      '2026-11-12T10:00:00Z',
      'expire-start',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    await db.superuser.query(
      "UPDATE app.pending_transaction_starts SET expires_at=now()-interval '1 minute'",
    );
    await jobs.query('SELECT app.expire_pending_starts(100)');
    const ledger = await db.superuser.query<{ kind: string; reason_code: string }>(
      "SELECT kind, reason_code FROM app.ingestion_events WHERE reason_code='START_RESPONSE_MISSING'",
    );
    expect(ledger.rows).toEqual([{ kind: 'start', reason_code: 'START_RESPONSE_MISSING' }]);
  });

  test('invalid connection state is rejected in the database function', async () => {
    expect(
      await call(ingest, 'ingest_connection', [
        STATION_REF,
        'bogus',
        'bogus-connection',
        '2026-11-12T10:00:00Z',
        HASH,
      ]),
    ).toBe('rejected');
  });

  test('boot/status/stop string fields are length-capped', async () => {
    await call(ingest, 'ingest_boot', [
      STATION_REF,
      'cap-boot',
      '2026-11-12T10:00:00Z',
      null,
      'v'.repeat(300),
      'm'.repeat(300),
      's'.repeat(300),
      'f'.repeat(300),
      'ocpp1.6',
      HASH,
    ]);
    const station = await db.superuser.query<{
      reported_vendor: string;
      reported_model: string;
      reported_serial: string;
      reported_firmware: string;
    }>(
      'SELECT reported_vendor, reported_model, reported_serial, reported_firmware FROM app.stations WHERE id=$1',
      [stationId],
    );
    expect(station.rows[0]?.reported_vendor).toHaveLength(200);
    expect(station.rows[0]?.reported_model).toHaveLength(200);
    expect(station.rows[0]?.reported_serial).toHaveLength(200);
    expect(station.rows[0]?.reported_firmware).toHaveLength(200);
    await call(ingest, 'ingest_status', [
      STATION_REF,
      1,
      'Faulted',
      'e'.repeat(100),
      '2026-11-12T10:00:00Z',
      'cap-status',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    const status = await db.superuser.query<{ error_code: string }>(
      'SELECT error_code FROM app.station_status_events ORDER BY id DESC LIMIT 1',
    );
    expect(status.rows[0]?.error_code).toHaveLength(64);
  });

  test('ingestion rejection prune removes rows older than the retention window', async () => {
    await db.superuser.query(
      `INSERT INTO app.ingestion_rejections (station_ref, reason_code, day)
       VALUES ('OLD-STATION', 'UNKNOWN_STATION', current_date - 31)`,
    );
    await jobs.query('SELECT app.prune_ingestion_rejections(30)');
    const { rowCount } = await db.superuser.query(
      "SELECT 1 FROM app.ingestion_rejections WHERE station_ref='OLD-STATION'",
    );
    expect(rowCount).toBe(0);
  });

  test('partition drops require first-of-month p_before', async () => {
    await expect(
      jobs.query("SELECT app.drop_expired_event_partitions('session_meter_values', '2020-01-15')"),
    ).rejects.toThrow(/first day of a month/);
    await jobs.query("SELECT app.ensure_event_partition('session_meter_values', '2020-01-01')");
    const dropped = await jobs.query<{ result: number }>(
      "SELECT app.drop_expired_event_partitions('session_meter_values', '2021-01-01') AS result",
    );
    expect(Number(dropped.rows[0]?.result)).toBe(1);
  });
});
