import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { eventsHandler } from '../src/app/api/events/route.js';

let server: http.Server;
let base: string;
let upstreamRequests = 0;
let upstreamCloses = 0;

beforeAll(async () => {
  (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
  process.env.OIDC_ISSUER = 'http://keycloak.test/realms/evstation';
  process.env.OIDC_CLIENT_ID = 'dashboard';
  process.env.OIDC_CLIENT_SECRET = 'test';
  process.env.OIDC_REDIRECT_URI = 'http://localhost:3200/auth/callback';
  server = http.createServer((request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': connected\n\n');
    response.on('close', () => {
      upstreamCloses += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
  process.env.API_BASE_URL = base;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('dashboard events BFF abort', () => {
  it('aborts the upstream for 100 connect/abort cycles and leaves no connections open', async () => {
    for (let i = 0; i < 100; i += 1) {
      const controller = new AbortController();
      const request = new Request('http://dashboard.test/api/events', {
        headers: { 'sec-fetch-site': 'same-origin' },
        signal: controller.signal,
      }) as unknown as NextRequest;
      const response = await eventsHandler(request, async () => ({
        sessionId: `session-${i}`,
        session: {
          accessToken: 'test-token',
          accessExpiresAt: Date.now() + 60_000,
          absoluteExpiresAt: Date.now() + 60_000,
          tenantId: '10000000-0000-4000-8000-000000000001',
          lastSeenAt: Date.now(),
        },
      }));
      expect(response.status).toBe(200);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const deadline = Date.now() + 2_000;
    while (upstreamCloses < 100 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(upstreamRequests).toBe(100);
    expect(upstreamCloses).toBe(100);
    const connections = await new Promise<number>((resolve) =>
      server.getConnections((_error, count) => resolve(count)),
    );
    expect(connections).toBe(0);
  }, 30_000);
});
