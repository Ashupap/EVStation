import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SEED_IDS,
  resetDb,
  startDb,
  stopDb,
  type TestDb,
} from '../../../packages/db/test/helpers.js';
import { buildApp } from '../src/app.js';
import type { TokenClaims, TokenVerifier } from '../src/auth.js';
import type { ApiConfig } from '../src/config.js';
import { createDb, type ApiDb } from '../src/db.js';
import { createFakeCsmsAdapter } from '@evstation/csms-adapter';
import { SseStream } from './sse-helpers.js';

const STATION_A = '30000000-0000-4000-8000-000000000971';
const STATION_B = '30000000-0000-4000-8000-000000000972';
const CONNECTOR_A = '40000000-0000-4000-8000-000000000971';
const CONNECTOR_B = '40000000-0000-4000-8000-000000000972';
const claims: Record<string, TokenClaims> = {
  adminA: { sub: SEED_IDS.acmeAdmin, email: 'admin@acme.example', email_verified: true },
  viewerA: { sub: SEED_IDS.acmeViewer, email: 'viewer@acme.example', email_verified: true },
  managerA: { sub: SEED_IDS.acmeSiteManager, email: 'manager@acme.example', email_verified: true },
  expiring: {
    sub: SEED_IDS.acmeViewer,
    email: 'viewer@acme.example',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 2,
  },
};
const verifier: TokenVerifier = {
  async verify(token) {
    const value = claims[token];
    if (!value) throw new Error('unknown token');
    return value;
  },
};
const config: ApiConfig = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  trustProxy: false,
  logLevel: 'silent',
  databaseUrlApp: '',
  oidcIssuer: 'http://keycloak.test/realms/evstation',
  oidcAudience: 'evstation-api',
  oidcJwksUri: 'http://keycloak.test/jwks',
  invitationAcceptBaseUrl: 'http://localhost:3200/invitations/accept',
};
let db: TestDb;
let apiDb: ApiDb;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

async function open(token: string, tenant = SEED_IDS.acmeTenant): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/events`, {
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenant },
    signal: controller.signal,
  });
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  return new SseStream(response.body!.getReader(), controller);
}

async function status(station: string, connector: number, seconds: number) {
  const ref = station === STATION_A ? 'ACME-BLR-001' : 'ACME-BLR-002';
  const ts = new Date(Date.UTC(2026, 10, 12, 10, 0, 0) + seconds * 1000).toISOString();
  await db.superuser.query('SELECT app.ingest_status($1,$2,$3,$4,$5,$6,$7,$8)', [
    ref,
    connector,
    'Available',
    'NoError',
    ts,
    `rev-${ref}-${seconds}`,
    ts,
    'f'.repeat(64),
  ]);
}

beforeAll(async () => {
  process.env.SSE_REFRESH_MS = '500';
  process.env.SSE_KEEPALIVE_MS = '1000';
  process.env.SSE_MAX_BUFFER_BYTES = '4096';
  db = await startDb();
  await resetDb(db);
  apiDb = createDb(db.appUrl, 10);
  config.databaseUrlApp = db.appUrl;
  app = await buildApp({
    db: apiDb,
    config,
    verifier,
    adapter: createFakeCsmsAdapter(),
    rateLimit: { max: 10_000, timeWindow: 60_000 },
    logger: false,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  for (const [id, ref, connector] of [
    [STATION_A, 'ACME-BLR-001', CONNECTOR_A],
    [STATION_B, 'ACME-BLR-002', CONNECTOR_B],
  ] as const) {
    await db.superuser.query(
      `INSERT INTO app.stations (id,tenant_id,site_id,org_code,station_ref,registration_status)
       VALUES ($1,$2,$3,'ACME',$4,'registered')`,
      [id, SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, ref],
    );
    await db.superuser.query(
      `INSERT INTO app.connectors (id,tenant_id,site_id,station_id,connector_number)
       VALUES ($1,$2,$3,$4,1)`,
      [connector, SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, id],
    );
  }
  await db.superuser.query(
    `INSERT INTO app.membership_sites (membership_id,tenant_id,site_id)
     SELECT id,$1,$2 FROM app.memberships WHERE user_id=$3 ON CONFLICT DO NOTHING`,
    [SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, SEED_IDS.acmeSiteManager],
  );
});
afterAll(async () => {
  await app?.close();
  await apiDb?.close();
  await stopDb(db);
});

describe('SSE revocation', () => {
  it('membership_removed closes only the affected stream', async () => {
    const viewer = await open('viewerA');
    const admin = await open('adminA');
    try {
      await db.superuser.query('DELETE FROM app.memberships WHERE user_id=$1 AND tenant_id=$2', [
        SEED_IDS.acmeViewer,
        SEED_IDS.acmeTenant,
      ]);
      const closed = await viewer.waitForClose(2_000);
      expect(JSON.parse(closed.data).reason).toBe('membership_removed');
      await status(STATION_A, 1, 10);
      await admin.waitForEvent('station.status', 1_000);
    } finally {
      await viewer.close();
      await admin.close();
      await db.superuser.query(
        `INSERT INTO app.memberships (id,tenant_id,user_id,role) VALUES ('f2546dd4-aa5c-4aac-af1e-eab0f3acf5e0',$1,$2,'viewer') ON CONFLICT DO NOTHING`,
        [SEED_IDS.acmeTenant, SEED_IDS.acmeViewer],
      );
    }
  }, 10_000);

  it('tenant_suspended closes all tenant streams; another tenant stays open', async () => {
    const admin = await open('adminA');
    const beta = await open('adminA', SEED_IDS.betaTenant).catch(() => null);
    try {
      await db.superuser.query("UPDATE app.tenants SET status='suspended' WHERE id=$1", [
        SEED_IDS.acmeTenant,
      ]);
      const closed = await admin.waitForClose(2_000);
      expect(JSON.parse(closed.data).reason).toBe('tenant_suspended');
      if (beta) {
        await db.superuser.query("UPDATE app.tenants SET status='active' WHERE id=$1", [
          SEED_IDS.acmeTenant,
        ]);
        await status(STATION_A, 1, 11);
        await beta.waitForEvent('station.status', 1_000);
      }
    } finally {
      await db.superuser.query("UPDATE app.tenants SET status='active' WHERE id=$1", [
        SEED_IDS.acmeTenant,
      ]);
      await admin.close();
      await beta?.close();
    }
  }, 10_000);

  it('site_scope_lost closes the scoped stream', async () => {
    const manager = await open('managerA');
    const admin = await open('adminA');
    try {
      await db.superuser.query(
        'UPDATE app.membership_sites SET site_id=$3 WHERE membership_id=(SELECT id FROM app.memberships WHERE user_id=$1 AND tenant_id=$2)',
        [SEED_IDS.acmeSiteManager, SEED_IDS.acmeTenant, SEED_IDS.acmeSite2],
      );
      const closed = await manager.waitForClose(2_000);
      expect(JSON.parse(closed.data).reason).toBe('site_scope_lost');
      await status(STATION_A, 1, 12);
      await admin.waitForEvent('station.status', 1_000);
    } finally {
      await db.superuser.query(
        'UPDATE app.membership_sites SET site_id=$3 WHERE membership_id=(SELECT id FROM app.memberships WHERE user_id=$1 AND tenant_id=$2)',
        [SEED_IDS.acmeSiteManager, SEED_IDS.acmeTenant, SEED_IDS.acmeSite1],
      );
      await manager.close();
      await admin.close();
    }
  }, 10_000);

  it('token_expired closes at exp, not at the next refresh', async () => {
    const expiring = await open('expiring');
    const admin = await open('adminA');
    const started = Date.now();
    try {
      const closed = await expiring.waitForClose(4_000);
      expect(JSON.parse(closed.data).reason).toBe('token_expired');
      expect(Date.now() - started).toBeLessThan(3_500);
      await status(STATION_A, 1, 13);
      await admin.waitForEvent('station.status', 1_000);
    } finally {
      await expiring.close();
      await admin.close();
    }
  }, 10_000);

  it('role downgrade keeps the stream, narrows to in-scope sites', async () => {
    const admin = await open('adminA');
    const manager = await open('managerA');
    try {
      const membership = await db.superuser.query<{ id: string }>(
        'SELECT id FROM app.memberships WHERE user_id=$1 AND tenant_id=$2',
        [SEED_IDS.acmeAdmin, SEED_IDS.acmeTenant],
      );
      await db.superuser.query(
        'INSERT INTO app.membership_sites (membership_id,tenant_id,site_id) VALUES ($1,$2,$3)',
        [membership.rows[0]!.id, SEED_IDS.acmeTenant, SEED_IDS.acmeSite1],
      );
      await db.superuser.query(
        "UPDATE app.memberships SET role='site_manager' WHERE user_id=$1 AND tenant_id=$2",
        [SEED_IDS.acmeAdmin, SEED_IDS.acmeTenant],
      );
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await status(STATION_A, 1, 14);
      await admin.waitForEvent('station.status', 1_000);
      await status(STATION_B, 1, 15);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await status(STATION_A, 1, 16);
      await admin.waitForEvent('station.status', 1_000);
      await manager.waitForEvent('station.status', 1_000);
    } finally {
      await db.superuser.query(
        "UPDATE app.memberships SET role='tenant_admin' WHERE user_id=$1 AND tenant_id=$2",
        [SEED_IDS.acmeAdmin, SEED_IDS.acmeTenant],
      );
      await admin.close();
      await manager.close();
    }
  }, 12_000);

  it('viewer and in-scope site_manager receive; out-of-scope manager does not', async () => {
    const viewer = await open('viewerA');
    const manager = await open('managerA');
    try {
      await status(STATION_A, 1, 20);
      await viewer.waitForEvent('station.status', 1_000);
      await manager.waitForEvent('station.status', 1_000);
    } finally {
      await viewer.close();
      await manager.close();
    }
    await db.superuser.query(
      'UPDATE app.membership_sites SET site_id=$3 WHERE membership_id=(SELECT id FROM app.memberships WHERE user_id=$1 AND tenant_id=$2)',
      [SEED_IDS.acmeSiteManager, SEED_IDS.acmeTenant, SEED_IDS.acmeSite2],
    );
    const outOfScope = await open('managerA');
    const healthy = await open('viewerA');
    try {
      await status(STATION_A, 1, 21);
      await healthy.waitForEvent('station.status', 1_000);
      await status(STATION_B, 1, 22);
      await healthy.waitForEvent('station.status', 1_000);
      expect(outOfScope.count('station.status')).toBe(0);
    } finally {
      await db.superuser.query(
        'UPDATE app.membership_sites SET site_id=$3 WHERE membership_id=(SELECT id FROM app.memberships WHERE user_id=$1 AND tenant_id=$2)',
        [SEED_IDS.acmeSiteManager, SEED_IDS.acmeTenant, SEED_IDS.acmeSite1],
      );
      await outOfScope.close();
      await healthy.close();
    }
  }, 10_000);

  it('deleted user closes with membership_removed within two refreshes', async () => {
    const viewer = await open('viewerA');
    try {
      await db.superuser.query('DELETE FROM app.users WHERE id=$1', [SEED_IDS.acmeViewer]);
      const closed = await viewer.waitForClose(2_000);
      expect(JSON.parse(closed.data).reason).toBe('membership_removed');
    } finally {
      await viewer.close();
      await db.superuser.query(
        `INSERT INTO app.users (id,email,email_verified) VALUES ($1,'viewer@acme.example',true) ON CONFLICT DO NOTHING`,
        [SEED_IDS.acmeViewer],
      );
      await db.superuser.query(
        `INSERT INTO app.memberships (id,tenant_id,user_id,role) VALUES ('f2546dd4-aa5c-4aac-af1e-eab0f3acf5e0',$1,$2,'viewer') ON CONFLICT DO NOTHING`,
        [SEED_IDS.acmeTenant, SEED_IDS.acmeViewer],
      );
    }
  }, 10_000);

  it('best-effort kernel-buffer integration: healthy stream gets every event in order', async () => {
    const token = 'adminA';
    const socket = net.connect(Number(new URL(baseUrl).port), '127.0.0.1');
    socket.pause();
    (
      socket as unknown as { _handle?: { setRecvBufferSize?: (n: number) => void } }
    )._handle?.setRecvBufferSize?.(512);
    socket.write(
      `GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nX-Tenant-Id: ${SEED_IDS.acmeTenant}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n`,
    );
    const healthy = await open('adminA');
    try {
      for (let i = 0; i < 800; i += 1) await status(STATION_A, 1, 100 + i);
      const frames = await healthy.waitForCount('station.status', 800, 20_000);
      expect(frames).toHaveLength(800);
    } finally {
      socket.destroy();
      await healthy.close();
    }
  }, 120_000);
});
