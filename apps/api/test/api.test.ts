import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startDb, stopDb, type TestDb } from '../../../packages/db/test/helpers.js';
import { ROUTES } from '../src/routes.js';
import { BODY_LIMIT_BYTES, buildApp } from '../src/app.js';
import type { TokenClaims, TokenVerifier } from '../src/auth.js';
import type { ApiConfig } from '../src/config.js';
import { assertRuntimeRole, createDb, inspectRuntimeRole, type ApiDb } from '../src/db.js';
import { MemoryMailer, type Mailer } from '../src/mailer.js';
import { runOutboxBatch } from '../src/outbox.js';

const IDS = {
  platform: '00000000-0000-4000-8000-000000000001',
  adminA: '00000000-0000-4000-8000-000000000002',
  adminB: '00000000-0000-4000-8000-000000000003',
  siteManagerA: '00000000-0000-4000-8000-000000000004',
  viewerA: '00000000-0000-4000-8000-000000000005',
  outsider: '00000000-0000-4000-8000-000000000099',
  invitee: '00000000-0000-4000-8000-0000000000e1',
  tenantA: '10000000-0000-4000-8000-000000000001',
  tenantB: '10000000-0000-4000-8000-000000000002',
  siteA1: '20000000-0000-4000-8000-000000000001',
  siteB1: '20000000-0000-4000-8000-000000000003',
};

const CLAIMS: Record<string, TokenClaims> = {
  platform: {
    sub: IDS.platform,
    email: 'platform@evstation.dev',
    email_verified: true,
  },
  adminA: { sub: IDS.adminA, email: 'admin@acme.example', email_verified: true },
  adminB: { sub: IDS.adminB, email: 'admin@beta.example', email_verified: true },
  managerA: {
    sub: IDS.siteManagerA,
    email: 'manager@acme.example',
    email_verified: true,
  },
  viewerA: { sub: IDS.viewerA, email: 'viewer@acme.example', email_verified: true },
  outsider: { sub: IDS.outsider, email: 'outsider@example.com', email_verified: true },
  invitee: { sub: IDS.invitee, email: 'invitee@example.com', email_verified: true },
  inviteeUnverified: {
    sub: IDS.invitee,
    email: 'invitee@example.com',
    email_verified: false,
  },
};

const verifier: TokenVerifier = {
  async verify(token: string) {
    const claims = CLAIMS[token];
    if (!claims) throw new Error('unknown test token');
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
const mailer = new MemoryMailer();
const registeredRoutes: string[] = [];

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met before timeout');
}

beforeAll(async () => {
  db = await startDb();
  apiDb = createDb(db.appUrl, 4);
  config.databaseUrlApp = db.appUrl;
  app = await buildApp({
    db: apiDb,
    config,
    verifier,
    mailer,
    rateLimit: { max: 10_000, timeWindow: 60_000 },
    logger: false,
    onRoute: (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (method !== 'HEAD') registeredRoutes.push(`${method} ${route.url}`);
      }
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await apiDb?.close();
  await stopDb(db);
});

beforeEach(async () => {
  await resetDb(db);
  mailer.outbox.length = 0;
});

describe('skeleton and runtime role', () => {
  it('serves liveness/readiness but gates docs outside development', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
  });

  it('serves generated OpenAPI in development', async () => {
    const dev = await buildApp({
      db: apiDb,
      config: { ...config, nodeEnv: 'development' },
      verifier,
      mailer,
      rateLimit: { max: 10_000, timeWindow: 60_000 },
      logger: false,
    });
    await dev.ready();
    try {
      const spec = await dev.inject({ method: 'GET', url: '/openapi.json' });
      expect(spec.statusCode).toBe(200);
      expect(spec.json().paths['/sites']).toBeTruthy();
      expect((await dev.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(200);
    } finally {
      await dev.close();
    }
  });

  it('applies explicit HTTP and pg limits', async () => {
    expect(BODY_LIMIT_BYTES).toBe(64 * 1024);
    expect(apiDb.pool.options.connectionTimeoutMillis).toBe(5_000);
    expect(apiDb.pool.options.statement_timeout).toBe(10_000);
    expect(apiDb.pool.options.query_timeout).toBe(10_000);
    expect(apiDb.pool.options.lock_timeout).toBe(5_000);
    expect(apiDb.pool.options.idle_in_transaction_session_timeout).toBe(15_000);
  });

  it('logs pool errors without leaking the connection string', async () => {
    const events: Array<{ name: string; code?: string; message: string }> = [];
    const local = createDb(db.appUrl, 1, (event) => events.push(event));
    try {
      local.pool.emit(
        'error',
        new Error('connect failed for postgres://user:secret@db.example/evstation'),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.message).not.toContain('postgres://');
      expect(events[0]?.message).not.toContain('secret');
    } finally {
      await local.close();
    }
  });

  it('routes pool errors through the redacting API logger', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const local = createDb(db.appUrl, 1);
    const logged = await buildApp({
      db: local,
      config: { ...config, logLevel: 'info' },
      verifier,
      mailer,
      rateLimit: { max: 10_000, timeWindow: 60_000 },
      logStream: sink,
    });
    await logged.ready();
    try {
      local.pool.emit(
        'error',
        new Error('connect failed for postgres://user:secret@db.example/evstation'),
      );
      await new Promise((resolve) => setImmediate(resolve));
      const output = lines.join('\n');
      expect(output).toContain('database pool error');
      expect(output).not.toContain('postgres://');
      expect(output).not.toContain('secret');
    } finally {
      await logged.close();
      await local.close();
    }
  });

  it('connects as the RLS runtime role, never superuser/BYPASSRLS', async () => {
    const role = await inspectRuntimeRole(apiDb.pool);
    expect(role.role).toBe('evstation_app');
    expect(role.superuser).toBe(false);
    expect(role.bypassRls).toBe(false);
    await expect(assertRuntimeRole(apiDb.pool)).resolves.toBeUndefined();
  });

  it('refuses a superuser runtime connection at boot', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: db.migratorUrl });
    try {
      await expect(assertRuntimeRole(pool)).rejects.toThrow(/must not be superuser/);
    } finally {
      await pool.end();
    }
  });
});

describe('authentication', () => {
  it('rejects missing and unknown tokens with 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/me', headers: auth('nope') })).statusCode,
    ).toBe(401);
  });

  it('authenticates before parsing a malformed unauthenticated body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sites',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('rejects an authenticated body over the explicit limit with 413', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sites',
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantA },
      payload: { name: 'x'.repeat(BODY_LIMIT_BYTES) },
    });
    expect(response.statusCode).toBe(413);
  });

  it('rate-limits requests with the API error shape', async () => {
    const limited = await buildApp({
      db: apiDb,
      config,
      verifier,
      mailer,
      rateLimit: { max: 2, timeWindow: 60_000 },
      logger: false,
    });
    await limited.ready();
    try {
      expect((await limited.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await limited.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const response = await limited.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    } finally {
      await limited.close();
    }
  });

  it('keys the actor limiter on the verified subject, not the shared IP', async () => {
    const limited = await buildApp({
      db: apiDb,
      config,
      verifier,
      mailer,
      rateLimit: { max: 2, ipMax: 10, timeWindow: 60_000 },
      logger: false,
    });
    await limited.ready();
    const remoteAddress = '203.0.113.10';
    try {
      for (const token of ['viewerA', 'adminA']) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await limited.inject({
            method: 'GET',
            url: '/me',
            headers: auth(token),
            remoteAddress,
          });
          expect(response.statusCode, `${token} attempt ${attempt + 1}`).toBe(200);
        }
      }
      expect(
        (
          await limited.inject({
            method: 'GET',
            url: '/me',
            headers: auth('viewerA'),
            remoteAddress,
          })
        ).statusCode,
      ).toBe(429);
      expect(
        (
          await limited.inject({
            method: 'GET',
            url: '/me',
            headers: auth('adminA'),
            remoteAddress,
          })
        ).statusCode,
      ).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('uses forwarded client IPs only from an explicitly trusted proxy', async () => {
    const limited = await buildApp({
      db: apiDb,
      config: { ...config, trustProxy: ['127.0.0.1'] },
      verifier,
      mailer,
      rateLimit: { max: 100, ipMax: 1, timeWindow: 60_000 },
      logger: false,
    });
    await limited.ready();
    try {
      const forwarded = (ip: string) => ({ 'x-forwarded-for': ip });
      expect(
        (
          await limited.inject({
            method: 'GET',
            url: '/health',
            headers: forwarded('198.51.100.1'),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await limited.inject({
            method: 'GET',
            url: '/health',
            headers: forwarded('198.51.100.1'),
          })
        ).statusCode,
      ).toBe(429);
      expect(
        (
          await limited.inject({
            method: 'GET',
            url: '/health',
            headers: forwarded('198.51.100.2'),
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('ignores spoofed X-Forwarded-For from an untrusted peer', async () => {
    const limited = await buildApp({
      db: apiDb,
      config: { ...config, trustProxy: ['10.0.0.1'] },
      verifier,
      mailer,
      rateLimit: { max: 100, ipMax: 1, timeWindow: 60_000 },
      logger: false,
    });
    await limited.ready();
    try {
      const remoteAddress = '203.0.113.50';
      const headers = { 'x-forwarded-for': '198.51.100.1' };
      expect(
        (await limited.inject({ method: 'GET', url: '/health', headers, remoteAddress }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await limited.inject({
            method: 'GET',
            url: '/health',
            headers: { 'x-forwarded-for': '198.51.100.2' },
            remoteAddress,
          })
        ).statusCode,
      ).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('limits an unauthenticated IP flood before token verification', async () => {
    let verifications = 0;
    const countingVerifier: TokenVerifier = {
      async verify() {
        verifications += 1;
        throw new Error('bad token');
      },
    };
    const limited = await buildApp({
      db: apiDb,
      config,
      verifier: countingVerifier,
      mailer,
      rateLimit: { max: 100, ipMax: 2, timeWindow: 60_000 },
      logger: false,
    });
    await limited.ready();
    const remoteAddress = '203.0.113.20';
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          (
            await limited.inject({
              method: 'GET',
              url: '/me',
              headers: auth('bad'),
              remoteAddress,
            })
          ).statusCode,
        ).toBe(401);
      }
      expect(verifications).toBe(2);
      const flood = await limited.inject({
        method: 'GET',
        url: '/me',
        headers: auth('bad'),
        remoteAddress,
      });
      expect(flood.statusCode).toBe(429);
      expect(flood.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(verifications).toBe(2);
    } finally {
      await limited.close();
    }
  });
});

describe('principal and me', () => {
  it('resolves the actor and memberships from the token', async () => {
    const response = await app.inject({ method: 'GET', url: '/me', headers: auth('adminA') });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: IDS.adminA,
      email: 'admin@acme.example',
      is_platform_admin: false,
      memberships: [
        {
          tenant_id: IDS.tenantA,
          tenant_name: 'Acme Charging',
          role: 'tenant_admin',
        },
      ],
    });
  });

  it('updates only the caller display name', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth('viewerA'),
      payload: { display_name: 'Acme Viewer Updated' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: IDS.viewerA, display_name: 'Acme Viewer Updated' });
    const row = await db.superuser.query('SELECT email FROM app.users WHERE id = $1', [
      IDS.viewerA,
    ]);
    expect(row.rows[0].email).toBe('viewer@acme.example');

    const strict = await app.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth('viewerA'),
      payload: { display_name: 'Nope', email: 'nope@example.com' },
    });
    expect(strict.statusCode).toBe(400);
    expect(strict.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('tenant context resolution', () => {
  it('rejects a foreign tenant header without leaking existence', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/sites',
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantB },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'TENANT_FORBIDDEN' } });
  });

  it('auto-selects the only membership when the header is absent', async () => {
    const response = await app.inject({ method: 'GET', url: '/sites', headers: auth('adminA') });
    expect(response.statusCode).toBe(200);
    expect(response.json().sites).toHaveLength(2);
  });

  it('requires a tenant for a platform admin', async () => {
    const response = await app.inject({ method: 'GET', url: '/sites', headers: auth('platform') });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'TENANT_REQUIRED' } });
  });

  it('rejects a suspended tenant', async () => {
    await db.superuser.query("UPDATE app.tenants SET status = 'suspended' WHERE id = $1", [
      IDS.tenantA,
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/sites',
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantA },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'TENANT_SUSPENDED' } });
  });

  it('rejects a forged tenant_id field in the body', async () => {
    const forged = await app.inject({
      method: 'POST',
      url: '/sites',
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantA },
      payload: { name: 'Forged probe', tenant_id: IDS.tenantB },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const valid = await app.inject({
      method: 'POST',
      url: '/sites',
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantA },
      payload: { name: 'Tenant from header' },
    });
    expect(valid.statusCode).toBe(201);
    expect(valid.json().tenant_id).toBe(IDS.tenantA);
  });
});

describe('tenant and permission matrix', () => {
  it('allows platform admins to create tenants and tenant admins cannot', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: auth('adminA'),
      payload: { name: 'Nope', slug: 'nope' },
    });
    expect(denied.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: auth('platform'),
      payload: { name: 'Gamma Mobility', slug: 'gamma' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Gamma Mobility', slug: 'gamma' });
    const audit = await db.superuser.query(
      `SELECT tenant_id, actor_id FROM app.audit_log
       WHERE action = 'tenant.created' AND outcome = 'allowed'`,
    );
    expect(audit.rows[0]).toMatchObject({ tenant_id: created.json().id, actor_id: IDS.platform });
  });

  it('lets a platform admin act inside a tenant and marks the audit row', async () => {
    const sites = await app.inject({
      method: 'GET',
      url: '/sites',
      headers: { ...auth('platform'), 'x-tenant-id': IDS.tenantA },
    });
    expect(sites.statusCode).toBe(200);
    expect(sites.json().sites).toHaveLength(2);

    const created = await app.inject({
      method: 'POST',
      url: '/sites',
      headers: { ...auth('platform'), 'x-tenant-id': IDS.tenantA },
      payload: { name: 'Platform site' },
    });
    expect(created.statusCode).toBe(201);
    const audit = await db.superuser.query(
      `SELECT tenant_id, actor_id, details FROM app.audit_log
       WHERE action = 'site.created' AND resource_id = $1`,
      [created.json().id],
    );
    expect(audit.rows[0]).toMatchObject({
      tenant_id: IDS.tenantA,
      actor_id: IDS.platform,
      details: { acting_as_platform_admin: true },
    });
  });

  it('enforces viewer/site-manager/admin matrix on sites and users', async () => {
    const viewerSites = await app.inject({
      method: 'GET',
      url: '/sites',
      headers: { ...auth('viewerA'), 'x-tenant-id': IDS.tenantA },
    });
    expect(viewerSites.statusCode).toBe(200);

    const viewerCreate = await app.inject({
      method: 'POST',
      url: '/sites',
      headers: { ...auth('viewerA'), 'x-tenant-id': IDS.tenantA },
      payload: { name: 'Viewer site' },
    });
    expect(viewerCreate.statusCode).toBe(403);

    const managerCreate = await app.inject({
      method: 'POST',
      url: '/sites',
      headers: { ...auth('managerA'), 'x-tenant-id': IDS.tenantA },
      payload: { name: 'Manager site' },
    });
    expect(managerCreate.statusCode).toBe(403);

    const managerUpdateOwn = await app.inject({
      method: 'PATCH',
      url: `/sites/${IDS.siteA1}`,
      headers: { ...auth('managerA'), 'x-tenant-id': IDS.tenantA },
      payload: { name: 'Manager renamed site' },
    });
    expect(managerUpdateOwn.statusCode).toBe(200);

    const viewerUsers = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { ...auth('viewerA'), 'x-tenant-id': IDS.tenantA },
    });
    expect(viewerUsers.statusCode).toBe(403);

    const adminUsers = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantA },
    });
    expect(adminUsers.statusCode).toBe(200);
    expect(adminUsers.json().users.map((user: { id: string }) => user.id)).toEqual(
      expect.arrayContaining([IDS.adminA, IDS.siteManagerA, IDS.viewerA]),
    );
  });
});

const MATRIX_ACTORS = {
  platform_admin: 'platform',
  tenant_admin: 'adminA',
  site_manager: 'managerA',
  viewer: 'viewerA',
  no_membership: 'outsider',
} as const;

const MATRIX_ALLOW: Record<string, Array<keyof typeof MATRIX_ACTORS>> = {
  'GET /me': ['platform_admin', 'tenant_admin', 'site_manager', 'viewer', 'no_membership'],
  'PATCH /me': ['platform_admin', 'tenant_admin', 'site_manager', 'viewer', 'no_membership'],
  'GET /tenants': ['platform_admin'],
  'POST /tenants': ['platform_admin'],
  'PATCH /tenants/:id': ['platform_admin'],
  'GET /sites': ['platform_admin', 'tenant_admin', 'site_manager', 'viewer'],
  'POST /sites': ['platform_admin', 'tenant_admin'],
  'PATCH /sites/:id': ['platform_admin', 'tenant_admin', 'site_manager'],
  'GET /users': ['platform_admin', 'tenant_admin'],
  'PATCH /users/:id/role': ['platform_admin', 'tenant_admin'],
  'GET /tenants/:tenantId/invitations': ['platform_admin', 'tenant_admin'],
  'POST /tenants/:tenantId/invitations': ['platform_admin', 'tenant_admin'],
  'DELETE /tenants/:tenantId/invitations/:invitationId': ['platform_admin', 'tenant_admin'],
  'POST /invitations/accept': [
    'platform_admin',
    'tenant_admin',
    'site_manager',
    'viewer',
    'no_membership',
  ],
};

function matrixUrl(key: string): string {
  if (key.includes('/tenants/:id')) return `/tenants/${IDS.tenantA}`;
  if (key.includes('/invitations/:invitationId')) {
    return `/tenants/${IDS.tenantA}/invitations/00000000-0000-4000-8000-0000000000ff`;
  }
  return key
    .replace(':tenantId', IDS.tenantA)
    .replace(':id', IDS.siteA1)
    .replace(':invitationId', '00000000-0000-4000-8000-0000000000ff')
    .replace(/^[A-Z]+ /u, '');
}

function matrixBody(
  key: string,
  actor: keyof typeof MATRIX_ACTORS,
): Record<string, unknown> | undefined {
  const slug = `matrix-${actor.replaceAll('_', '-')}`;
  switch (key) {
    case 'POST /tenants':
      return { name: `Matrix ${actor}`, slug };
    case 'PATCH /tenants/:id':
      return { status: 'active' };
    case 'PATCH /me':
      return { display_name: `Matrix ${actor}` };
    case 'POST /sites':
      return { name: `Matrix ${actor}` };
    case 'PATCH /sites/:id':
      return { name: `Matrix ${actor}` };
    case 'PATCH /users/:id/role':
      return { role: 'viewer' };
    case 'POST /tenants/:tenantId/invitations':
      return { email: `${slug}@example.com`, role: 'viewer' };
    case 'POST /invitations/accept':
      return { token: 'a'.repeat(43) };
    default:
      return undefined;
  }
}

describe('HTTP role x route matrix', () => {
  it('matches an independent allow table for every actor and route', async () => {
    expect(Object.keys(MATRIX_ALLOW).sort()).toEqual(
      ROUTES.map((route) => `${route.method} ${route.url}`).sort(),
    );

    for (const route of ROUTES) {
      const key = `${route.method} ${route.url}`;
      const allowed = MATRIX_ALLOW[key];
      if (!allowed) throw new Error(`missing matrix row for ${key}`);
      for (const [actor, token] of Object.entries(MATRIX_ACTORS) as Array<
        [keyof typeof MATRIX_ACTORS, string]
      >) {
        const body = matrixBody(key, actor);
        const response = await app.inject({
          method: route.method,
          url: matrixUrl(key),
          headers: { ...auth(token), 'x-tenant-id': IDS.tenantA },
          ...(body === undefined ? {} : { payload: body }),
        });
        const label = `${key} as ${actor}`;
        if (allowed.includes(actor)) {
          expect(response.statusCode, label).not.toBe(401);
          expect(response.statusCode, label).not.toBe(403);
          expect(response.statusCode, label).toBeLessThan(500);
        } else {
          expect(response.statusCode, label).toBe(403);
        }
      }
    }
  });
});

function requestedUrl(route: (typeof ROUTES)[number], tenantId = IDS.tenantA): string {
  let url = route.url;
  if (typeof route.tenantSource === 'object') {
    url = url.replace(`:${route.tenantSource.param}`, tenantId);
  }
  for (const [name, value] of Object.entries(route.isolation?.params ?? {})) {
    url = url.replace(`:${name}`, value);
  }
  return url;
}

describe('cross-tenant isolation suite (registry-driven)', () => {
  it('registers exactly ROUTES plus the health allow-list', () => {
    const expected = [
      ...ROUTES.map((route) => `${route.method} ${route.url}`),
      'GET /health',
      'GET /health/ready',
    ].sort();
    expect(registeredRoutes.sort()).toEqual(expected);
  });

  it('returns 401 for every registered API route without a token', async () => {
    for (const route of ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: requestedUrl(route),
        ...(route.isolation?.body ? { payload: route.isolation.body } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it('returns only caller-tenant rows from every tenant list endpoint', async () => {
    const acmeSites = await app.inject({
      method: 'GET',
      url: '/sites',
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantA },
    });
    expect(acmeSites.json().sites.map((site: { tenant_id: string }) => site.tenant_id)).toEqual([
      IDS.tenantA,
      IDS.tenantA,
    ]);

    const betaSites = await app.inject({
      method: 'GET',
      url: '/sites',
      headers: { ...auth('adminB'), 'x-tenant-id': IDS.tenantB },
    });
    expect(betaSites.json().sites.map((site: { tenant_id: string }) => site.tenant_id)).toEqual([
      IDS.tenantB,
    ]);

    const acmeUsers = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantA },
    });
    expect(acmeUsers.json().users.map((user: { id: string }) => user.id)).not.toContain(IDS.adminB);

    await app.inject({
      method: 'POST',
      url: `/tenants/${IDS.tenantA}/invitations`,
      headers: auth('adminA'),
      payload: { email: 'acme-invite@example.com', role: 'viewer' },
    });
    await app.inject({
      method: 'POST',
      url: `/tenants/${IDS.tenantB}/invitations`,
      headers: auth('adminB'),
      payload: { email: 'beta-invite@example.com', role: 'viewer' },
    });
    const acmeInvitations = await app.inject({
      method: 'GET',
      url: `/tenants/${IDS.tenantA}/invitations`,
      headers: auth('adminA'),
    });
    expect(
      acmeInvitations.json().invitations.map((invitation: { email: string }) => invitation.email),
    ).toEqual(['acme-invite@example.com']);

    const tenants = await app.inject({
      method: 'GET',
      url: '/tenants',
      headers: auth('platform'),
    });
    expect(
      tenants
        .json()
        .tenants.map((tenant: { id: string }) => tenant.id)
        .sort(),
    ).toEqual([IDS.tenantA, IDS.tenantB].sort());
  });

  it('denies every tenant-scoped route when another tenant is requested', async () => {
    const tenantRoutes = ROUTES.filter((route) => route.tenantSource !== 'none');
    expect(tenantRoutes.length).toBeGreaterThanOrEqual(8);

    for (const route of tenantRoutes) {
      let url = route.url;
      const headers: Record<string, string> = auth('adminA');
      if (route.tenantSource === 'header') {
        headers['x-tenant-id'] = IDS.tenantB;
      } else if (typeof route.tenantSource === 'object') {
        url = url.replace(`:${route.tenantSource.param}`, IDS.tenantB);
      }
      for (const [name, value] of Object.entries(route.isolation?.params ?? {})) {
        url = url.replace(`:${name}`, value);
      }
      const response = await app.inject({
        method: route.method,
        url,
        headers,
        ...(route.isolation?.body ? { payload: route.isolation.body } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
  });

  it('returns 404 for foreign resources addressed inside the allowed tenant', async () => {
    const site = await app.inject({
      method: 'PATCH',
      url: `/sites/${IDS.siteB1}`,
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantA },
      payload: { name: 'cross tenant' },
    });
    expect(site.statusCode).toBe(404);

    const role = await app.inject({
      method: 'PATCH',
      url: `/users/${IDS.adminB}/role`,
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantA },
      payload: { role: 'viewer' },
    });
    expect(role.statusCode).toBe(404);
  });
});

describe('pagination', () => {
  it('pages sites, users and tenants with a limit and opaque cursor', async () => {
    const firstSites = await app.inject({
      method: 'GET',
      url: '/sites?limit=1',
      headers: auth('adminA'),
    });
    expect(firstSites.statusCode).toBe(200);
    expect(firstSites.json().sites).toHaveLength(1);
    expect(firstSites.json().next_cursor).toEqual(expect.any(String));

    const secondSites = await app.inject({
      method: 'GET',
      url: `/sites?limit=1&cursor=${encodeURIComponent(firstSites.json().next_cursor)}`,
      headers: auth('adminA'),
    });
    expect(secondSites.statusCode).toBe(200);
    expect(secondSites.json().sites).toHaveLength(1);
    expect(secondSites.json().sites[0].id).not.toBe(firstSites.json().sites[0].id);
    expect(secondSites.json().next_cursor).toBeNull();

    const firstUsers = await app.inject({
      method: 'GET',
      url: '/users?limit=1',
      headers: auth('adminA'),
    });
    expect(firstUsers.json().users).toHaveLength(1);
    expect(firstUsers.json().next_cursor).toEqual(expect.any(String));

    const firstTenants = await app.inject({
      method: 'GET',
      url: '/tenants?limit=1',
      headers: auth('platform'),
    });
    expect(firstTenants.json().tenants).toHaveLength(1);
    expect(firstTenants.json().next_cursor).toEqual(expect.any(String));

    const invalid = await app.inject({
      method: 'GET',
      url: '/sites?cursor=not-a-cursor',
      headers: auth('adminA'),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
  });
});

describe('invitations', () => {
  it('creates, accepts, and audits an invitation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${IDS.tenantA}/invitations`,
      headers: auth('adminA'),
      payload: { email: 'invitee@example.com', role: 'viewer' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { accept_url: string; id: string };
    const url = new URL(body.accept_url);
    expect(url.search).toBe('');
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    expect(token).toBeTruthy();
    await waitFor(() => mailer.outbox.length === 1);
    expect(mailer.outbox[0]).toMatchObject({
      invitationId: body.id,
      tenantId: IDS.tenantA,
      to: 'invitee@example.com',
    });
    expect(mailer.outbox[0]?.acceptUrl).toBe(body.accept_url);
    await waitFor(async () => {
      const result = await db.superuser.query<{
        dispatched_at: Date | null;
        accept_url: string | null;
      }>('SELECT dispatched_at, accept_url FROM app.email_outbox WHERE invitation_id = $1', [
        body.id,
      ]);
      return result.rows[0]?.dispatched_at !== null;
    });
    const outbox = await db.superuser.query<{
      recipient: string;
      dispatched_at: Date | null;
      accept_url: string | null;
      attempts: number;
    }>(
      'SELECT recipient, dispatched_at, accept_url, attempts FROM app.email_outbox WHERE invitation_id = $1',
      [body.id],
    );
    expect(outbox.rows[0]).toMatchObject({
      recipient: 'invitee@example.com',
      accept_url: null,
      attempts: 1,
    });
    expect(outbox.rows[0]?.dispatched_at).not.toBeNull();

    const unverified = await app.inject({
      method: 'POST',
      url: '/invitations/accept',
      headers: auth('inviteeUnverified'),
      payload: { token },
    });
    expect(unverified.statusCode).toBe(403);

    const accepted = await app.inject({
      method: 'POST',
      url: '/invitations/accept',
      headers: auth('invitee'),
      payload: { token },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ tenant_id: IDS.tenantA, role: 'viewer' });

    const audit = await db.superuser.query(
      "SELECT tenant_id, actor_id, action FROM app.audit_log WHERE action = 'invitation.accepted'",
    );
    expect(audit.rows[0]).toMatchObject({
      tenant_id: IDS.tenantA,
      actor_id: IDS.invitee,
      action: 'invitation.accepted',
    });
  });

  it('deduplicates repeated site ids when creating an invitation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${IDS.tenantA}/invitations`,
      headers: auth('adminA'),
      payload: {
        email: 'scoped@example.com',
        role: 'site_manager',
        site_ids: [IDS.siteA1, IDS.siteA1],
      },
    });
    expect(created.statusCode).toBe(201);
    const stored = await db.superuser.query<{ site_ids: string[] }>(
      'SELECT site_ids FROM app.invitations WHERE id = $1',
      [created.json().id],
    );
    expect(stored.rows[0]?.site_ids).toEqual([IDS.siteA1]);
  });

  it('revokes an invitation and prevents a second acceptance', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${IDS.tenantA}/invitations`,
      headers: auth('adminA'),
      payload: { email: 'invitee@example.com', role: 'viewer' },
    });
    const body = created.json() as { accept_url: string; id: string };
    const token = new URLSearchParams(new URL(body.accept_url).hash.slice(1)).get('token');

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/tenants/${IDS.tenantA}/invitations/${body.id}`,
      headers: auth('adminA'),
    });
    expect(revoked.statusCode).toBe(204);

    const accepted = await app.inject({
      method: 'POST',
      url: '/invitations/accept',
      headers: auth('invitee'),
      payload: { token },
    });
    expect(accepted.statusCode).toBe(400);
    expect(accepted.json()).toMatchObject({ error: { code: 'INVITATION_INVALID' } });
  });
});

describe('invitation outbox dispatch', () => {
  it('returns the invitation response before background delivery finishes', async () => {
    let release!: () => void;
    let started = false;
    const blocking: Mailer = {
      async sendInvitation() {
        started = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    const background = await buildApp({
      db: apiDb,
      config,
      verifier,
      mailer: blocking,
      rateLimit: { max: 10_000, timeWindow: 60_000 },
      logger: false,
    });
    await background.ready();
    try {
      const created = await background.inject({
        method: 'POST',
        url: `/tenants/${IDS.tenantA}/invitations`,
        headers: auth('adminA'),
        payload: { email: 'background@example.com', role: 'viewer' },
      });
      expect(created.statusCode).toBe(201);
      await waitFor(() => started);
      const pending = await db.superuser.query<{ dispatched_at: Date | null }>(
        'SELECT dispatched_at FROM app.email_outbox WHERE invitation_id = $1',
        [created.json().id],
      );
      expect(pending.rows[0]?.dispatched_at).toBeNull();
      release();
      await waitFor(async () => {
        const result = await db.superuser.query<{ dispatched_at: Date | null }>(
          'SELECT dispatched_at FROM app.email_outbox WHERE invitation_id = $1',
          [created.json().id],
        );
        return result.rows[0]?.dispatched_at !== null;
      });
    } finally {
      await background.close();
    }
  });

  it('retries a failed delivery through the worker and scrubs the token', async () => {
    const flaky = new (class implements Mailer {
      calls = 0;
      sent: string[] = [];
      async sendInvitation(message: { acceptUrl: string }) {
        this.calls += 1;
        if (this.calls === 1) throw new Error('temporary failure');
        this.sent.push(message.acceptUrl);
      }
    })();
    const failing = await buildApp({
      db: apiDb,
      config,
      verifier,
      mailer: flaky,
      rateLimit: { max: 10_000, timeWindow: 60_000 },
      logger: false,
    });
    await failing.ready();
    try {
      const created = await failing.inject({
        method: 'POST',
        url: `/tenants/${IDS.tenantA}/invitations`,
        headers: auth('adminA'),
        payload: { email: 'retry@example.com', role: 'viewer' },
      });
      expect(created.statusCode).toBe(201);
      await waitFor(async () => {
        const result = await db.superuser.query<{ last_error: string | null }>(
          'SELECT last_error FROM app.email_outbox WHERE invitation_id = $1',
          [created.json().id],
        );
        return result.rows[0]?.last_error !== null;
      });
      const pending = await db.superuser.query<{
        accept_url: string | null;
        dispatched_at: Date | null;
        attempts: number;
      }>(
        'SELECT accept_url, dispatched_at, attempts FROM app.email_outbox WHERE invitation_id = $1',
        [created.json().id],
      );
      expect(pending.rows[0]).toMatchObject({ dispatched_at: null, attempts: 1 });
      expect(pending.rows[0]?.accept_url).not.toBeNull();
      await db.superuser.query(
        'UPDATE app.email_outbox SET next_attempt_at = now() WHERE invitation_id = $1',
        [created.json().id],
      );

      const result = await runOutboxBatch({
        db: apiDb,
        mailer: flaky,
        logger: { error: () => undefined },
      });
      expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 });
      expect(flaky.sent).toHaveLength(1);

      const delivered = await db.superuser.query<{
        accept_url: string | null;
        dispatched_at: Date | null;
        last_error: string | null;
        attempts: number;
      }>(
        `SELECT accept_url, dispatched_at, last_error, attempts
         FROM app.email_outbox WHERE invitation_id = $1`,
        [created.json().id],
      );
      expect(delivered.rows[0]?.dispatched_at).not.toBeNull();
      expect(delivered.rows[0]?.accept_url).toBeNull();
      expect(delivered.rows[0]?.last_error).toBeNull();
      expect(delivered.rows[0]?.attempts).toBe(2);
    } finally {
      await failing.close();
    }
  });

  it('scrubs the token when retries are exhausted and prunes retained rows', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${IDS.tenantA}/invitations`,
      headers: auth('adminA'),
      payload: { email: 'exhausted@example.com', role: 'viewer' },
    });
    expect(created.statusCode).toBe(201);
    await waitFor(async () => {
      const result = await db.superuser.query<{ dispatched_at: Date | null }>(
        'SELECT dispatched_at FROM app.email_outbox WHERE invitation_id = $1',
        [created.json().id],
      );
      return result.rows[0]?.dispatched_at !== null;
    });

    await db.superuser.query(
      `UPDATE app.email_outbox
       SET dispatched_at = NULL, accept_url = 'http://localhost/accept#token=secret',
           attempts = 4, next_attempt_at = now(), last_error = NULL
       WHERE invitation_id = $1`,
      [created.json().id],
    );
    const exhausted = await runOutboxBatch({
      db: apiDb,
      mailer: {
        async sendInvitation() {
          throw new Error('still failing');
        },
      },
      maxAttempts: 5,
      logger: { error: () => undefined },
    });
    expect(exhausted).toEqual({ claimed: 1, delivered: 0, failed: 1 });

    const row = await db.superuser.query<{ accept_url: string | null; last_error: string | null }>(
      'SELECT accept_url, last_error FROM app.email_outbox WHERE invitation_id = $1',
      [created.json().id],
    );
    expect(row.rows[0]).toEqual({ accept_url: null, last_error: 'delivery failed' });

    await db.superuser.query(
      `UPDATE app.email_outbox
       SET dispatched_at = now() - interval '31 days' WHERE invitation_id = $1`,
      [created.json().id],
    );
    const pruned = await db.app.query<{ pruned: number }>(
      'SELECT app.prune_email_outbox(30) AS pruned',
    );
    expect(Number(pruned.rows[0]?.pruned)).toBeGreaterThanOrEqual(0);
    const gone = await db.superuser.query(
      'SELECT 1 FROM app.email_outbox WHERE invitation_id = $1',
      [created.json().id],
    );
    expect(gone.rowCount).toBe(0);
  });
});

describe('invitation delivery', () => {
  it('sends nothing when invitation creation rolls back', async () => {
    const rollbackMailer = new MemoryMailer();
    const failingDb: ApiDb = {
      ...apiDb,
      async transaction<T>(work: (client: import('pg').PoolClient) => Promise<T>) {
        const client = await apiDb.pool.connect();
        try {
          await client.query('BEGIN');
          await work(client);
          throw new Error('forced rollback');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    };
    const failing = await buildApp({
      db: failingDb,
      config,
      verifier,
      mailer: rollbackMailer,
      rateLimit: { max: 10_000, timeWindow: 60_000 },
      logger: false,
    });
    await failing.ready();
    try {
      const response = await failing.inject({
        method: 'POST',
        url: `/tenants/${IDS.tenantA}/invitations`,
        headers: auth('adminA'),
        payload: { email: 'rollback@example.com', role: 'viewer' },
      });
      expect(response.statusCode).toBe(500);
      expect(rollbackMailer.outbox).toHaveLength(0);
      const rows = await db.superuser.query('SELECT 1 FROM app.invitations WHERE email = $1', [
        'rollback@example.com',
      ]);
      expect(rows.rowCount).toBe(0);
      const outbox = await db.superuser.query(
        'SELECT 1 FROM app.email_outbox WHERE recipient = $1',
        ['rollback@example.com'],
      );
      expect(outbox.rowCount).toBe(0);
    } finally {
      await failing.close();
    }
  });

  it('never returns a token in production but queues a fragment URL', async () => {
    const productionMailer = new MemoryMailer();
    const production = await buildApp({
      db: apiDb,
      config: {
        ...config,
        nodeEnv: 'production',
        oidcIssuer: 'https://keycloak.test/realms/evstation',
        oidcJwksUri: 'https://keycloak.test/realms/evstation/certs',
      },
      verifier,
      mailer: productionMailer,
      rateLimit: { max: 10_000, timeWindow: 60_000 },
      logger: false,
    });
    await production.ready();
    try {
      const created = await production.inject({
        method: 'POST',
        url: `/tenants/${IDS.tenantA}/invitations`,
        headers: auth('adminA'),
        payload: { email: 'prod-invite@example.com', role: 'viewer' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).not.toHaveProperty('accept_url');
      await waitFor(() => productionMailer.outbox.length === 1);
      const message = productionMailer.outbox[0];
      expect(message?.to).toBe('prod-invite@example.com');
      expect(message?.acceptUrl).toContain('#token=');
      expect(new URL(message!.acceptUrl).search).toBe('');
    } finally {
      await production.close();
    }
  });
});

describe('role changes with site scope', () => {
  it('promotes and demotes a site_manager with membership_sites in one transaction', async () => {
    const promoted = await app.inject({
      method: 'PATCH',
      url: `/users/${IDS.viewerA}/role`,
      headers: auth('adminA'),
      payload: { role: 'site_manager', site_ids: [IDS.siteA1, IDS.siteA1] },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ user_id: IDS.viewerA, role: 'site_manager' });
    const promotedScope = await db.superuser.query(
      `SELECT ms.site_id FROM app.membership_sites ms
       JOIN app.memberships m ON m.id = ms.membership_id
       WHERE m.user_id = $1 AND m.tenant_id = $2`,
      [IDS.viewerA, IDS.tenantA],
    );
    expect(promotedScope.rows.map((row) => row.site_id)).toEqual([IDS.siteA1]);

    const demoted = await app.inject({
      method: 'PATCH',
      url: `/users/${IDS.viewerA}/role`,
      headers: auth('adminA'),
      payload: { role: 'viewer' },
    });
    expect(demoted.statusCode).toBe(200);
    const demotedScope = await db.superuser.query(
      `SELECT ms.site_id FROM app.membership_sites ms
       JOIN app.memberships m ON m.id = ms.membership_id
       WHERE m.user_id = $1 AND m.tenant_id = $2`,
      [IDS.viewerA, IDS.tenantA],
    );
    expect(demotedScope.rows).toEqual([]);
  });

  it('rejects missing and foreign site scopes', async () => {
    const missing = await app.inject({
      method: 'PATCH',
      url: `/users/${IDS.viewerA}/role`,
      headers: auth('adminA'),
      payload: { role: 'site_manager' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: 'SITE_REQUIRED' } });

    const foreign = await app.inject({
      method: 'PATCH',
      url: `/users/${IDS.viewerA}/role`,
      headers: auth('adminA'),
      payload: { role: 'site_manager', site_ids: [IDS.siteB1] },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({ error: { code: 'INVALID_SITE_SCOPE' } });
  });
});

describe('denied attempts are audited', () => {
  it('records a forged tenant attempt with tenant_id NULL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/sites',
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantB },
    });
    expect(response.statusCode).toBe(403);
    const audit = await db.superuser.query(
      "SELECT tenant_id, actor_id, outcome, details FROM app.audit_log WHERE outcome = 'denied'",
    );
    expect(audit.rows[0]).toMatchObject({
      tenant_id: null,
      actor_id: IDS.adminA,
      outcome: 'denied',
      details: { attempted_tenant: IDS.tenantB },
    });
  });

  it('records database RLS/privilege denials, not just AppError 403s', async () => {
    await db.superuser.query('REVOKE UPDATE (name) ON app.sites FROM evstation_app');
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${IDS.siteA1}`,
        headers: auth('adminA'),
        payload: { name: 'Denied by grant' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

      const audit = await db.superuser.query(
        "SELECT tenant_id, actor_id, action, outcome FROM app.audit_log WHERE outcome = 'denied'",
      );
      expect(audit.rows[0]).toMatchObject({
        tenant_id: null,
        actor_id: IDS.adminA,
        action: 'site.updated',
        outcome: 'denied',
      });
    } finally {
      await db.superuser.query('GRANT UPDATE (name) ON app.sites TO evstation_app');
    }
  });
});
