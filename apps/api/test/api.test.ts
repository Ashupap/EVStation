import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startDb, stopDb, type TestDb } from '../../../packages/db/test/helpers.js';
import { ROUTES } from '../src/routes.js';
import { buildApp } from '../src/app.js';
import type { TokenClaims, TokenVerifier } from '../src/auth.js';
import type { ApiConfig } from '../src/config.js';
import { assertRuntimeRole, createDb, inspectRuntimeRole, type ApiDb } from '../src/db.js';

const IDS = {
  platform: '00000000-0000-4000-8000-000000000001',
  adminA: '00000000-0000-4000-8000-000000000002',
  adminB: '00000000-0000-4000-8000-000000000003',
  siteManagerA: '00000000-0000-4000-8000-000000000004',
  viewerA: '00000000-0000-4000-8000-000000000005',
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

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  db = await startDb();
  apiDb = createDb(db.appUrl, 4);
  config.databaseUrlApp = db.appUrl;
  app = await buildApp({ db: apiDb, config, verifier, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await apiDb?.close();
  await stopDb(db);
});

beforeEach(async () => {
  await resetDb(db);
});

describe('skeleton and runtime role', () => {
  it('serves liveness/readiness and generated OpenAPI', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    const spec = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().paths['/sites']).toBeTruthy();
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
      payload: { display_name: 'Acme Viewer Updated', email: 'nope@example.com' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: IDS.viewerA, display_name: 'Acme Viewer Updated' });
    const row = await db.superuser.query('SELECT email FROM app.users WHERE id = $1', [
      IDS.viewerA,
    ]);
    expect(row.rows[0].email).toBe('viewer@acme.example');
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

  it('ignores a forged tenant_id in the body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sites',
      headers: { ...auth('adminA'), 'x-tenant-id': IDS.tenantA },
      payload: { name: 'Forged probe', tenant_id: IDS.tenantB },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().tenant_id).toBe(IDS.tenantA);
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

describe('cross-tenant isolation suite (registry-driven)', () => {
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
    const token = new URL(body.accept_url).searchParams.get('token');
    expect(token).toBeTruthy();

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

  it('revokes an invitation and prevents a second acceptance', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${IDS.tenantA}/invitations`,
      headers: auth('adminA'),
      payload: { email: 'invitee@example.com', role: 'viewer' },
    });
    const body = created.json() as { accept_url: string; id: string };
    const token = new URL(body.accept_url).searchParams.get('token');

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
});
