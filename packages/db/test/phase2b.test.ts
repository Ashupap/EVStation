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

const HASH = 'a'.repeat(64);
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

describe('Phase 2b roles and ownership', () => {
  test('ingest and jobs are execute-only; event trees are owned by event owner', async () => {
    for (const [role, fn, expected] of [
      ['evstation_ingest', 'ingest_boot', true],
      ['evstation_ingest', 'reject_ingest_event', true],
      ['evstation_ingest', 'drop_expired_event_partitions', false],
      ['evstation_jobs', 'drop_expired_event_partitions', true],
      ['evstation_jobs', 'ingest_boot', false],
    ] as const) {
      const { rows } = await db.superuser.query<{ ok: boolean }>(
        `SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS ok
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app' AND p.proname = $2
         LIMIT 1`,
        [role, fn],
      );
      expect(rows[0]?.ok, `${role} ${fn}`).toBe(expected);
    }
    const table = await db.superuser.query<{ ok: boolean }>(
      "SELECT has_table_privilege('evstation_ingest', 'app.sessions', 'SELECT') AS ok",
    );
    expect(table.rows[0]?.ok).toBe(false);
    const owners = await db.superuser.query<{ relname: string; owner: string }>(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app'
         AND c.relname IN ('session_meter_values', 'station_status_events', 'ingestion_events')
       ORDER BY c.relname`,
    );
    expect(owners.rows.map((row) => row.owner)).toEqual([
      'evstation_event_owner',
      'evstation_event_owner',
      'evstation_event_owner',
    ]);
  });
});

describe('Phase 2b ingestion behavior', () => {
  test('boot records reported fields, while heartbeat/status stay out of the ledger', async () => {
    await call(ingest, 'ingest_boot', [
      STATION_REF,
      'evt-boot',
      '2026-11-12T10:00:00Z',
      null,
      'Acme',
      'M1',
      'SN1',
      '1.2',
      'ocpp1.6',
      HASH,
    ]);
    await call(ingest, 'ingest_heartbeat', [
      STATION_REF,
      'evt-heartbeat',
      '2026-11-12T10:00:01Z',
      HASH,
    ]);
    await call(ingest, 'ingest_status', [
      STATION_REF,
      0,
      'Available',
      null,
      '2026-11-12T10:00:01Z',
      'evt-status-station',
      '2026-11-12T10:00:01Z',
      HASH,
    ]);
    await call(ingest, 'ingest_status', [
      STATION_REF,
      1,
      'Charging',
      null,
      '2026-11-12T10:00:02Z',
      'evt-status-connector',
      '2026-11-12T10:00:02Z',
      HASH,
    ]);
    const station = await db.superuser.query<{
      reported_vendor: string;
      vendor: string | null;
    }>('SELECT reported_vendor, vendor FROM app.stations WHERE id = $1', [stationId]);
    expect(station.rows[0]).toEqual({ reported_vendor: 'Acme', vendor: null });
    const status = await db.superuser.query<{ connector_id: string | null }>(
      'SELECT connector_id FROM app.station_status_events ORDER BY csms_timestamp',
    );
    expect(status.rows).toEqual([{ connector_id: null }, { connector_id: connectorId }]);
    const ledger = await db.superuser.query<{ kind: string }>(
      'SELECT kind FROM app.ingestion_events ORDER BY csms_timestamp',
    );
    expect(ledger.rows).toEqual([{ kind: 'boot' }]);
  });

  test('out-of-order connection events do not override a newer closed state', async () => {
    await call(ingest, 'ingest_connection', [
      STATION_REF,
      'connected',
      'connection:connected',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    await call(ingest, 'ingest_connection', [
      STATION_REF,
      'closed',
      'connection:closed',
      '2026-11-12T10:01:00Z',
      HASH,
    ]);
    await call(ingest, 'ingest_connection', [
      STATION_REF,
      'connected',
      'connection:stale',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    const runtime = await db.superuser.query<{ connection_state: string }>(
      'SELECT connection_state FROM app.station_runtime_state WHERE station_id = $1',
      [stationId],
    );
    expect(runtime.rows[0]?.connection_state).toBe('disconnected');
  });

  test('start response supersedes the previous live session; meter redelivery and stop are idempotent', async () => {
    await call(ingest, 'ingest_transaction_start', [
      STATION_REF,
      'corr-1',
      1,
      'TAG1',
      100,
      '2026-11-12T10:00:00Z',
      'start-1',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_start_response', [
      STATION_REF,
      'corr-1',
      'tx-1',
      'Accepted',
      'start-response-1',
      '2026-11-12T10:00:01Z',
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_start', [
      STATION_REF,
      'corr-2',
      1,
      'TAG2',
      0,
      '2026-11-12T11:00:00Z',
      'start-2',
      '2026-11-12T11:00:00Z',
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_start_response', [
      STATION_REF,
      'corr-2',
      'tx-2',
      'Accepted',
      'start-response-2',
      '2026-11-12T11:00:01Z',
      HASH,
    ]);
    const sessions = await db.superuser.query<{
      csms_transaction_ref: string;
      status: string;
      stop_reason: string | null;
      ended_at: string | null;
    }>(
      `SELECT csms_transaction_ref, status, stop_reason, ended_at
       FROM app.sessions ORDER BY started_at`,
    );
    expect(
      sessions.rows.map((row) => [row.csms_transaction_ref, row.status, row.stop_reason]),
    ).toEqual([
      ['tx-1', 'failed', 'superseded'],
      ['tx-2', 'active', null],
    ]);
    expect(sessions.rows[0]?.ended_at).not.toBeNull();

    const samples = JSON.stringify([
      { recorded_at: '2026-11-12T11:01:00Z', energy_wh: 250, power_w: 7000 },
      { recorded_at: '2026-11-12T11:01:30Z', energy_wh: 500, power_w: 7100 },
    ]);
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'tx-2',
      'meter-1',
      '2026-11-12T11:01:30Z',
      samples,
      HASH,
    ]);
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'tx-2',
      'meter-1',
      '2026-11-12T11:01:30Z',
      samples,
      HASH,
    ]);
    const meters = await db.superuser.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.session_meter_values',
    );
    expect(meters.rows[0]?.n).toBe('2');

    expect(
      await call(ingest, 'ingest_transaction_stop', [
        STATION_REF,
        'tx-2',
        750,
        'Local',
        '2026-11-12T11:02:00Z',
        'stop-1',
        '2026-11-12T11:02:00Z',
        HASH,
      ]),
    ).toBe('accepted');
    expect(
      await call(ingest, 'ingest_transaction_stop', [
        STATION_REF,
        'tx-2',
        750,
        'Local',
        '2026-11-12T11:02:00Z',
        'stop-2',
        '2026-11-12T11:02:00Z',
        HASH,
      ]),
    ).toBe('duplicate');
    const stopped = await db.superuser.query<{
      status: string;
      energy_wh: string;
      started_at_source: string;
      charger_started_at: Date;
    }>(
      `SELECT status, energy_wh::text, started_at_source, charger_started_at
       FROM app.sessions WHERE csms_transaction_ref = 'tx-2'`,
    );
    expect(stopped.rows[0]).toMatchObject({
      status: 'completed',
      energy_wh: '750',
      started_at_source: 'charger',
    });
    expect(stopped.rows[0]?.charger_started_at.toISOString()).toBe('2026-11-12T11:00:00.000Z');
    const ledger = await db.superuser.query<{ kind: string; n: string }>(
      'SELECT kind, count(*)::text AS n FROM app.ingestion_events GROUP BY kind ORDER BY kind',
    );
    expect(Object.fromEntries(ledger.rows.map((row) => [row.kind, row.n]))).toEqual({
      start: '2',
      start_response: '2',
      stop: '1',
    });
  });

  test('unknown-station rejection is collapsed per station/reason/day', async () => {
    for (let index = 0; index < 3; index += 1) {
      expect(
        await call(ingest, 'ingest_heartbeat', [
          'NOPE',
          `evt-${index}`,
          '2026-11-12T10:00:00Z',
          HASH,
        ]),
      ).toBe('rejected');
    }
    const { rows } = await db.superuser.query<{
      station_ref: string;
      reason_code: string;
      occurrence_count: number;
    }>('SELECT station_ref, reason_code, occurrence_count FROM app.ingestion_rejections');
    expect(rows).toEqual([
      { station_ref: 'NOPE', reason_code: 'UNKNOWN_STATION', occurrence_count: 3 },
    ]);
  });

  test('replay of the same captured events is idempotent and does not inflate rows', async () => {
    const boot = [
      STATION_REF,
      'replay-boot',
      '2026-11-12T10:00:00Z',
      null,
      'Acme',
      'M1',
      'SN1',
      '1.2',
      'ocpp1.6',
      HASH,
    ];
    await call(ingest, 'ingest_boot', boot);
    await call(ingest, 'ingest_connection', [
      STATION_REF,
      'connected',
      'replay-connection',
      '2026-11-12T10:00:01Z',
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_start', [
      STATION_REF,
      'replay-corr',
      1,
      'TAG',
      0,
      '2026-11-12T10:00:02Z',
      'replay-start',
      '2026-11-12T10:00:02Z',
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_start_response', [
      STATION_REF,
      'replay-corr',
      'replay-tx',
      'Accepted',
      'replay-response',
      '2026-11-12T10:00:03Z',
      HASH,
    ]);
    const samples = JSON.stringify([
      { recorded_at: '2026-11-12T10:01:00Z', energy_wh: 250, power_w: 7000 },
    ]);
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'replay-tx',
      'replay-meter',
      '2026-11-12T10:01:00Z',
      samples,
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_stop', [
      STATION_REF,
      'replay-tx',
      250,
      'Local',
      '2026-11-12T10:02:00Z',
      'replay-stop',
      '2026-11-12T10:02:00Z',
      HASH,
    ]);
    const count = async (table: string) =>
      Number(
        (await db.superuser.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))
          .rows[0]?.n,
      );
    const before = {
      sessions: await count('app.sessions'),
      meters: await count('app.session_meter_values'),
      status: await count('app.station_status_events'),
      ledger: await count('app.ingestion_events'),
    };
    await call(ingest, 'ingest_boot', boot);
    await call(ingest, 'ingest_connection', [
      STATION_REF,
      'connected',
      'replay-connection',
      '2026-11-12T10:00:01Z',
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_start', [
      STATION_REF,
      'replay-corr',
      1,
      'TAG',
      0,
      '2026-11-12T10:00:02Z',
      'replay-start',
      '2026-11-12T10:00:02Z',
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_start_response', [
      STATION_REF,
      'replay-corr',
      'replay-tx',
      'Accepted',
      'replay-response',
      '2026-11-12T10:00:03Z',
      HASH,
    ]);
    await call(ingest, 'ingest_meter_values', [
      STATION_REF,
      'replay-tx',
      'replay-meter',
      '2026-11-12T10:01:00Z',
      samples,
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_stop', [
      STATION_REF,
      'replay-tx',
      250,
      'Local',
      '2026-11-12T10:02:00Z',
      'replay-stop',
      '2026-11-12T10:02:00Z',
      HASH,
    ]);
    expect({
      sessions: await count('app.sessions'),
      meters: await count('app.session_meter_values'),
      status: await count('app.station_status_events'),
      ledger: await count('app.ingestion_events'),
    }).toEqual(before);
  });

  test('cross-tenant events resolve tenant from station_ref and cannot touch tenant A', async () => {
    const stationB = await db.superuser.query<{ id: string }>(
      `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref, registration_status)
       VALUES ($1, $2, 'BETA', 'BETA-BOM-001', 'registered') RETURNING id`,
      [SEED_IDS.betaTenant, SEED_IDS.betaSite1],
    );
    const stationBId = stationB.rows[0]!.id;
    await db.superuser.query(
      `INSERT INTO app.connectors (tenant_id, site_id, station_id, connector_number)
       VALUES ($1, $2, $3, 1)`,
      [SEED_IDS.betaTenant, SEED_IDS.betaSite1, stationBId],
    );
    await call(ingest, 'ingest_transaction_start', [
      'BETA-BOM-001',
      'cross-corr',
      1,
      'BETA_TAG',
      0,
      '2026-11-12T10:00:00Z',
      'cross-start',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    await call(ingest, 'ingest_transaction_start_response', [
      'BETA-BOM-001',
      'cross-corr',
      'cross-tx',
      'Accepted',
      'cross-response',
      '2026-11-12T10:00:01Z',
      HASH,
    ]);
    const sessions = await db.superuser.query<{
      tenant_id: string;
      station_ref: string;
      csms_transaction_ref: string;
    }>(
      `SELECT s.tenant_id, st.station_ref, s.csms_transaction_ref
       FROM app.sessions s JOIN app.stations st ON st.id = s.station_id
       ORDER BY st.station_ref`,
    );
    expect(sessions.rows).toEqual([
      {
        tenant_id: SEED_IDS.betaTenant,
        station_ref: 'BETA-BOM-001',
        csms_transaction_ref: 'cross-tx',
      },
    ]);
    const tenantARows = await db.superuser.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.sessions WHERE tenant_id = $1',
      [SEED_IDS.acmeTenant],
    );
    expect(tenantARows.rows[0]?.n).toBe('0');
  });

  test('rejected start responses create a failed session and suspended tenants still ingest', async () => {
    await call(ingest, 'ingest_transaction_start', [
      STATION_REF,
      'blocked-corr',
      1,
      'BLOCKED_TAG',
      0,
      '2026-11-12T10:00:00Z',
      'blocked-start',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    expect(
      await call(ingest, 'ingest_transaction_start_response', [
        STATION_REF,
        'blocked-corr',
        'blocked-tx',
        'Blocked',
        'blocked-response',
        '2026-11-12T10:00:01Z',
        HASH,
      ]),
    ).toBe('accepted');
    const failed = await db.superuser.query<{
      status: string;
      stop_reason: string;
      id_tag: string | null;
    }>(
      "SELECT status, stop_reason, id_tag FROM app.sessions WHERE csms_transaction_ref = 'blocked-tx'",
    );
    expect(failed.rows[0]).toEqual({
      status: 'failed',
      stop_reason: 'START_REJECTED',
      id_tag: 'BLOCKED_TAG',
    });

    await db.superuser.query("UPDATE app.tenants SET status = 'suspended' WHERE id = $1", [
      SEED_IDS.acmeTenant,
    ]);
    expect(
      await call(ingest, 'ingest_heartbeat', [
        STATION_REF,
        'suspended-heartbeat',
        '2026-11-12T10:05:00Z',
        HASH,
      ]),
    ).toBe('accepted');
    const runtime = await db.superuser.query<{ last_heartbeat_at: Date }>(
      'SELECT last_heartbeat_at FROM app.station_runtime_state WHERE station_id = $1',
      [stationId],
    );
    expect(runtime.rows[0]?.last_heartbeat_at.toISOString()).toBe('2026-11-12T10:05:00.000Z');
  });

  test('jobs expire pending starts, close stale sessions, and validate partition parents', async () => {
    await call(ingest, 'ingest_transaction_start', [
      STATION_REF,
      'expired-corr',
      1,
      'TAG',
      0,
      '2026-11-12T10:00:00Z',
      'expired-start',
      '2026-11-12T10:00:00Z',
      HASH,
    ]);
    await db.superuser.query(
      "UPDATE app.pending_transaction_starts SET expires_at = now() - interval '1 minute'",
    );
    const expired = await jobs.query<{ result: number }>(
      'SELECT app.expire_pending_starts(100) AS result',
    );
    expect(Number(expired.rows[0]?.result)).toBe(1);
    expect(
      (await db.superuser.query('SELECT 1 FROM app.pending_transaction_starts')).rowCount,
    ).toBe(0);

    await db.superuser.query(
      `INSERT INTO app.sessions
         (tenant_id, site_id, station_id, connector_id, started_at, status, meter_start_wh)
       VALUES ($1, $2, $3, $4, now() - interval '2 days', 'active', 0)`,
      [SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, stationId, connectorId],
    );
    const stale = await jobs.query<{ result: number }>(
      'SELECT app.close_stale_sessions(86400) AS result',
    );
    expect(Number(stale.rows[0]?.result)).toBe(1);
    const session = await db.superuser.query<{ stop_reason: string }>(
      'SELECT stop_reason FROM app.sessions WHERE status = $1',
      ['failed'],
    );
    expect(session.rows[0]?.stop_reason).toBe('STALE_SESSION_CLOSED');

    await expect(
      jobs.query("SELECT app.drop_expired_event_partitions('sessions', '2020-01-01')"),
    ).rejects.toThrow(/unsupported event parent/);
    await jobs.query("SELECT app.ensure_event_partition('session_meter_values', '2020-01-01')");
    const dropped = await jobs.query<{ result: number }>(
      "SELECT app.drop_expired_event_partitions('session_meter_values', '2021-01-01') AS result",
    );
    expect(Number(dropped.rows[0]?.result)).toBe(1);
  });
});
