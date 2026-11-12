import type { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { SEED_IDS, appCommit, appTx, resetDb, startDb, stopDb, type TestDb } from './helpers.js';

const A = SEED_IDS.acmeTenant;
const B = SEED_IDS.betaTenant;
const ADMIN_A = SEED_IDS.acmeAdmin;
const MANAGER_A = SEED_IDS.acmeSiteManager;
const VIEWER_A = SEED_IDS.acmeViewer;
const SITE_A1 = SEED_IDS.acmeSite1;
const SITE_A2 = SEED_IDS.acmeSite2;
const SITE_B1 = SEED_IDS.betaSite1;

const STATION_A1 = '30000000-0000-4000-8000-000000000001';
const STATION_A2 = '30000000-0000-4000-8000-000000000002';
const STATION_B1 = '30000000-0000-4000-8000-000000000003';
const CONNECTOR_A1 = '40000000-0000-4000-8000-000000000001';
const CONNECTOR_A2 = '40000000-0000-4000-8000-000000000002';
const CONNECTOR_B1 = '40000000-0000-4000-8000-000000000003';
const SESSION_A1 = '50000000-0000-4000-8000-000000000001';
const SESSION_A2 = '50000000-0000-4000-8000-000000000002';
const SESSION_B1 = '50000000-0000-4000-8000-000000000003';

let db: TestDb;

beforeAll(async () => {
  db = await startDb();
});

afterAll(async () => {
  await stopDb(db);
});

beforeEach(async () => {
  await resetDb(db);
  await seedStations();
});

async function fail(client: Client, sql: string, params: unknown[] = []) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await client.query(sql, params);
    throw new Error(`expected failure but query succeeded: ${sql}`);
  } catch (error) {
    const err = error as { code?: string; message: string };
    if (err.message.startsWith('expected failure but')) throw err;
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    return err;
  }
}

async function seedStations() {
  const client = db.superuser;
  const rows: Array<[string, string, string, string, string]> = [
    [STATION_A1, A, SITE_A1, 'ACME', 'ACME-BLR-001'],
    [STATION_A2, A, SITE_A2, 'ACME', 'ACME-PUN-001'],
    [STATION_B1, B, SITE_B1, 'BETA', 'BETA-BOM-001'],
  ];
  for (const [id, tenantId, siteId, orgCode, stationRef] of rows) {
    await client.query(
      `INSERT INTO app.stations (id, tenant_id, site_id, org_code, station_ref, registration_status,
         credentials_state, vendor, model, firmware_version)
       VALUES ($1, $2, $3, $4, $5, 'registered', 'provisioned', 'Demo', 'SIM', '1.0.0')`,
      [id, tenantId, siteId, orgCode, stationRef],
    );
    await client.query(
      `INSERT INTO app.station_runtime_state (station_id, tenant_id, site_id, connection_state, last_heartbeat_at)
       VALUES ($1, $2, $3, 'connected', now())`,
      [id, tenantId, siteId],
    );
  }
  const connectors: Array<[string, string, string, string, number]> = [
    [CONNECTOR_A1, A, SITE_A1, STATION_A1, 1],
    [CONNECTOR_A2, A, SITE_A2, STATION_A2, 1],
    [CONNECTOR_B1, B, SITE_B1, STATION_B1, 1],
  ];
  for (const [id, tenantId, siteId, stationId, number] of connectors) {
    await client.query(
      `INSERT INTO app.connectors (id, tenant_id, site_id, station_id, connector_number, type, status)
       VALUES ($1, $2, $3, $4, $5, 'CCS2', 'charging')`,
      [id, tenantId, siteId, stationId, number],
    );
  }
  const sessions: Array<[string, string, string, string, string, string]> = [
    [SESSION_A1, A, SITE_A1, STATION_A1, CONNECTOR_A1, 'txn-a1'],
    [SESSION_A2, A, SITE_A2, STATION_A2, CONNECTOR_A2, 'txn-a2'],
    [SESSION_B1, B, SITE_B1, STATION_B1, CONNECTOR_B1, 'txn-b1'],
  ];
  for (const [id, tenantId, siteId, stationId, connectorId, transactionRef] of sessions) {
    await client.query(
      `INSERT INTO app.sessions (id, tenant_id, site_id, station_id, connector_id,
         csms_transaction_ref, csms_start_correlation_id, id_tag, started_at, energy_wh, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'TESTTAG', '2026-11-10T10:00:00Z', 1000, 'active')`,
      [id, tenantId, siteId, stationId, connectorId, transactionRef, `corr-${transactionRef}`],
    );
  }
}

async function statusCount(client: Client, where: string, params: unknown[] = []) {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.station_status_events ${where}`,
    params,
  );
  return Number(rows[0]?.n);
}

describe('Phase 2 station identity', () => {
  test('org_code/site_code are immutable and site_code is unique per tenant', async () => {
    await expect(
      db.superuser.query("UPDATE app.tenants SET org_code = 'OTHER' WHERE id = $1", [A]),
    ).rejects.toThrow(/org_code is immutable/);
    await expect(
      db.superuser.query("UPDATE app.sites SET site_code = 'XXX' WHERE id = $1", [SITE_A1]),
    ).rejects.toThrow(/site_code is immutable/);
    await expect(
      db.superuser.query(
        "INSERT INTO app.sites (tenant_id, name, site_code) VALUES ($1, 'Dup', 'BLR')",
        [A],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  test('station_ref enforces uppercase format, length, org and site binding', async () => {
    const insert = (ref: string) =>
      db.superuser.query(
        `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref, ocpp_version)
         VALUES ($1, $2, 'ACME', $3, 'ocpp1.6')`,
        [A, SITE_A1, ref],
      );

    await expect(insert('acme-blr-001')).rejects.toThrow(/station_ref format/);
    await expect(insert('ACME-BLR-1')).rejects.toThrow(/station_ref format/);
    await expect(insert('ACME-PUN-002')).rejects.toThrow(/SITE segment/);
    await expect(insert('BETA-BLR-002')).rejects.toThrow(/ORG segment/);
    await expect(insert('ACME-BLR-002')).resolves.toMatchObject({ rowCount: 1 });
  });

  test('station identity and site_id are immutable, and ocpp_version is limited to 1.6', async () => {
    await expect(
      db.superuser.query("UPDATE app.stations SET station_ref = 'ACME-BLR-999' WHERE id = $1", [
        STATION_A1,
      ]),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      db.superuser.query('UPDATE app.stations SET site_id = $1 WHERE id = $2', [
        SITE_A2,
        STATION_A1,
      ]),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      db.superuser.query(
        `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref, ocpp_version)
         VALUES ($1, $2, 'ACME', 'ACME-BLR-003', 'ocpp2.0.1')`,
        [A, SITE_A1],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('Phase 2 station/session RLS', () => {
  test('tenant admin sees own stations only; site manager is site-scoped; viewer is read-only', async () => {
    await appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      const refs = await client.query<{ station_ref: string }>(
        'SELECT station_ref FROM app.stations ORDER BY station_ref',
      );
      expect(refs.rows.map((r) => r.station_ref)).toEqual(['ACME-BLR-001', 'ACME-PUN-001']);
      await expect(
        client.query('SELECT station_ref FROM app.stations WHERE id = $1', [STATION_B1]),
      ).resolves.toMatchObject({ rowCount: 0 });
    });

    await appTx(db, { actor: MANAGER_A, tenant: A }, async (client) => {
      expect(
        (await client.query<{ station_ref: string }>('SELECT station_ref FROM app.stations')).rows,
      ).toEqual([{ station_ref: 'ACME-BLR-001' }]);
      expect(
        (await client.query('SELECT station_ref FROM app.stations WHERE id = $1', [STATION_A2]))
          .rowCount,
      ).toBe(0);
    });

    await appTx(db, { actor: VIEWER_A, tenant: A }, async (client) => {
      expect((await client.query('SELECT id FROM app.stations')).rowCount).toBe(2);
      const err = await fail(
        client,
        `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref)
         VALUES ($1, $2, 'ACME', 'ACME-BLR-010')`,
        [A, SITE_A1],
      );
      expect(err.code).toBe('42501');
    });
  });

  test('site manager may register a station only in an assigned site', async () => {
    await appCommit(db, { actor: MANAGER_A, tenant: A }, async (client) => {
      await client.query(
        `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref)
         VALUES ($1, $2, 'ACME', 'ACME-BLR-020')`,
        [A, SITE_A1],
      );
    });
    await appTx(db, { actor: MANAGER_A, tenant: A }, async (client) => {
      const err = await fail(
        client,
        `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref)
         VALUES ($1, $2, 'ACME', 'ACME-PUN-020')`,
        [A, SITE_A2],
      );
      expect(err.code).toBe('42501');
    });
  });

  test('sessions and meter/status reads are tenant/site scoped and app has no write grants', async () => {
    await appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      expect((await client.query('SELECT id FROM app.sessions')).rowCount).toBe(2);
      const err = await fail(
        client,
        `INSERT INTO app.sessions (tenant_id, site_id, station_id, connector_id, started_at)
         VALUES ($1, $2, $3, $4, now())`,
        [A, SITE_A1, STATION_A1, CONNECTOR_A1],
      );
      expect(err.code).toBe('42501');
      expect(
        (
          await fail(
            client,
            `INSERT INTO app.station_status_events
          (tenant_id, site_id, station_id, connector_id, status, csms_event_ref, csms_timestamp)
          VALUES ($1, $2, $3, $4, 'available', 'x', now())`,
            [A, SITE_A1, STATION_A1, CONNECTOR_A1],
          )
        ).code,
      ).toBe('42501');
    });

    await appTx(db, { actor: MANAGER_A, tenant: A }, async (client) => {
      expect((await client.query('SELECT id FROM app.sessions')).rowCount).toBe(1);
      expect((await client.query('SELECT station_id FROM app.station_runtime_state')).rows).toEqual(
        [{ station_id: STATION_A1 }],
      );
    });
  });

  test('direct partition access is denied; parent access remains RLS-scoped', async () => {
    await db.superuser.query(
      `INSERT INTO app.station_status_events
         (tenant_id, site_id, station_id, connector_id, status, csms_event_ref, csms_timestamp)
       VALUES ($1, $2, $3, $4, 'available', 'evt-1', '2026-11-15T00:00:00Z')`,
      [A, SITE_A1, STATION_A1, CONNECTOR_A1],
    );
    await appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      expect(await statusCount(client, "WHERE status = 'available'")).toBe(1);
      const err = await fail(client, 'SELECT id FROM app.station_status_events_2026_11');
      expect(err.code).toBe('42501');
    });
  });
});

describe('Phase 2 partition and dedup invariants', () => {
  test('the unique key is global across the partitioned parent', async () => {
    const insert = (timestamp: string, ref: string) =>
      db.superuser.query(
        `INSERT INTO app.station_status_events
           (tenant_id, site_id, station_id, connector_id, status, csms_event_ref, csms_timestamp)
         VALUES ($1, $2, $3, $4, 'available', $5, $6)`,
        [A, SITE_A1, STATION_A1, CONNECTOR_A1, ref, timestamp],
      );
    await insert('2026-11-30T23:59:00Z', 'month-boundary-replay');
    await expect(insert('2026-11-30T23:59:00Z', 'month-boundary-replay')).rejects.toMatchObject({
      code: '23505',
    });
    await insert('2026-12-01T00:00:00Z', 'different-timestamp');
  });

  test('ingestion/pending tables are not exposed to the app role', async () => {
    await appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      expect((await fail(client, 'SELECT * FROM app.ingestion_events')).code).toBe('42501');
      expect((await fail(client, 'SELECT * FROM app.pending_transaction_starts')).code).toBe(
        '42501',
      );
      expect((await fail(client, 'SELECT * FROM app.ingestion_events_2026_11')).code).toBe('42501');
    });
  });
});
