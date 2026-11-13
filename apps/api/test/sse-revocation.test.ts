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

const CLAIMS: Record<string, TokenClaims> = {
  adminA: { sub: SEED_IDS.acmeAdmin, email: 'admin@acme.example', email_verified: true },
  viewerA: { sub: SEED_IDS.acmeViewer, email: 'viewer@acme.example', email_verified: true },
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
  process.env.SSE_REFRESH_MS = '500';
  process.env.SSE_KEEPALIVE_MS = '1000';
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
});
afterAll(async () => {
  await app?.close();
  await apiDb?.close();
  await stopDb(db);
});

async function open(token: string) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/events`, {
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': SEED_IDS.acmeTenant },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(': connected')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return { controller, reader, decoder };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  needle: string,
  ms: number,
) {
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (!result) continue;
    if (result.done) break;
    text += decoder.decode(result.value);
    if (text.includes(needle)) return text;
  }
  return text;
}

describe('SSE membership revocation repro', () => {
  it('closes with membership_removed within two refresh intervals', async () => {
    const admin = await open('adminA');
    const port = Number(new URL(baseUrl).port);
    const socket = net.connect(port, '127.0.0.1');
    const transcript: Array<{ ms: number; text: string }> = [];
    const started = Date.now();
    socket.on('data', (chunk) =>
      transcript.push({ ms: Date.now() - started, text: chunk.toString() }),
    );
    socket.write(
      `GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer viewerA\r\nX-Tenant-Id: ${SEED_IDS.acmeTenant}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n`,
    );
    try {
      const connectedDeadline = Date.now() + 2_000;
      while (
        !transcript.some((entry) => entry.text.includes(': connected')) &&
        Date.now() < connectedDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await db.superuser.query('DELETE FROM app.memberships WHERE user_id=$1 AND tenant_id=$2', [
        SEED_IDS.acmeViewer,
        SEED_IDS.acmeTenant,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const text = transcript.map((entry) => entry.text).join('');
      console.log('TRANSCRIPT', JSON.stringify(transcript));
      expect(text).toContain(': connected');
      expect(text).toContain('event: closed');
      expect(text).toContain('membership_removed');
      const healthy = await readUntil(admin.reader, admin.decoder, 'event: closed', 600);
      expect(healthy).not.toContain('event: closed');
    } finally {
      socket.destroy();
      admin.controller.abort();
      await admin.reader.cancel().catch(() => undefined);
    }
  }, 10_000);
});
