import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SEED_IDS,
  resetDb,
  startDb,
  stopDb,
  type TestDb,
} from '../../../packages/db/test/helpers.js';
import { createFakeCsmsAdapter } from '@evstation/csms-adapter';
import { buildApp } from '../src/app.js';
import type { TokenClaims, TokenVerifier } from '../src/auth.js';
import type { ApiConfig } from '../src/config.js';
import { createDb, type ApiDb } from '../src/db.js';

const STATION_ID = '30000000-0000-4000-8000-000000000991';
const CONNECTOR_ID = '40000000-0000-4000-8000-000000000991';
const CLAIMS: Record<string, TokenClaims> = {
  adminA: {
    sub: '00000000-0000-4000-8000-000000000002',
    email: 'admin@acme.example',
    email_verified: true,
  },
};
const verifier: TokenVerifier = {
  async verify(token) {
    const claims = CLAIMS[token];
    if (!claims) throw new Error('unknown token');
    return claims;
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

beforeAll(async () => {
  db = await startDb();
  await resetDb(db);
  apiDb = createDb(db.appUrl, 10);
  config.databaseUrlApp = db.appUrl;
  await db.superuser.query(
    `INSERT INTO app.stations (id, tenant_id, site_id, org_code, station_ref, registration_status)
     VALUES ($1, $2, $3, 'ACME', 'ACME-BLR-991', 'registered')`,
    [STATION_ID, SEED_IDS.acmeTenant, SEED_IDS.acmeSite1],
  );
  await db.superuser.query(
    `INSERT INTO app.connectors (id, tenant_id, site_id, station_id, connector_number)
     VALUES ($1, $2, $3, $4, 1)`,
    [CONNECTOR_ID, SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, STATION_ID],
  );
  await db.superuser.query(
    `INSERT INTO app.station_status_events
       (tenant_id, site_id, station_id, connector_id, status, csms_event_ref, csms_timestamp)
     VALUES ($1, $2, $3, $4, 'available', 'sse-status', '2026-11-12T10:00:00Z')`,
    [SEED_IDS.acmeTenant, SEED_IDS.acmeSite1, STATION_ID, CONNECTOR_ID],
  );
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
  if (!address || typeof address === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await app?.close();
  await apiDb?.close();
  await stopDb(db);
});

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<string | null> {
  return Promise.race([
    reader.read().then(({ value, done }) => (done ? null : new TextDecoder().decode(value))),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

describe('SSE resync contract', () => {
  it('sends resync on Last-Event-ID without replaying data', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/events`, {
      headers: {
        authorization: 'Bearer adminA',
        'x-tenant-id': SEED_IDS.acmeTenant,
        'last-event-id': 'previous-event',
      },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    try {
      const first = await readChunk(reader, 3_000);
      const second = await readChunk(reader, 3_000);
      expect(`${first ?? ''}${second ?? ''}`).toContain('event: resync');
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  }, 10_000);
});

describe('SSE tenant isolation', () => {
  it('drops a spoofed foreign-tenant NOTIFY and delivers the real tenant event', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/events`, {
      headers: {
        authorization: 'Bearer adminA',
        'x-tenant-id': SEED_IDS.acmeTenant,
      },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    try {
      await readChunk(reader, 1_000);
      const spoof = {
        v: 1,
        id: crypto.randomUUID(),
        kind: 'station.status',
        tenant_id: SEED_IDS.betaTenant,
        site_id: SEED_IDS.betaSite1,
        station_id: STATION_ID,
        session_id: null,
        occurred_at: '2026-11-12T10:00:00Z',
      };
      const pending = reader
        .read()
        .then(({ value, done }) => (done ? null : new TextDecoder().decode(value)));
      await db.superuser.query("SELECT pg_notify('evstation_events', $1)", [JSON.stringify(spoof)]);
      expect(
        await Promise.race([
          pending,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 700)),
        ]),
      ).toBeNull();

      const real = {
        ...spoof,
        tenant_id: SEED_IDS.acmeTenant,
        site_id: SEED_IDS.acmeSite1,
      };
      await db.superuser.query("SELECT pg_notify('evstation_events', $1)", [JSON.stringify(real)]);
      const chunk = await pending;
      expect(chunk).toContain('event: station.status');
      expect(chunk).toContain(SEED_IDS.acmeTenant);
      expect(chunk).not.toContain('idTag');
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  }, 15_000);
});
