import http from 'node:http';

const port = Number(process.env.MOCK_API_PORT ?? 4100);
const host = '127.0.0.1';
const tenantA = '10000000-0000-4000-8000-000000000001';
const tenantB = '10000000-0000-4000-8000-000000000002';

const memberships = {
  admin: [
    {
      tenant_id: tenantA,
      tenant_name: 'Tenant Alpha',
      tenant_slug: 'tenant-alpha',
      role: 'tenant_admin',
      site_ids: [],
    },
    {
      tenant_id: tenantB,
      tenant_name: 'Tenant Beta',
      tenant_slug: 'tenant-beta',
      role: 'tenant_admin',
      site_ids: [],
    },
  ],
  viewer: [
    {
      tenant_id: tenantA,
      tenant_name: 'Tenant Alpha',
      tenant_slug: 'tenant-alpha',
      role: 'viewer',
      site_ids: [],
    },
  ],
  manager: [
    {
      tenant_id: tenantA,
      tenant_name: 'Tenant Alpha',
      tenant_slug: 'tenant-alpha',
      role: 'site_manager',
      site_ids: ['20000000-0000-4000-8000-000000000001'],
    },
  ],
  unverified: [
    {
      tenant_id: tenantA,
      tenant_name: 'Tenant Alpha',
      tenant_slug: 'tenant-alpha',
      role: 'viewer',
      site_ids: [],
    },
  ],
  multitenant: [
    {
      tenant_id: tenantA,
      tenant_name: 'Tenant Alpha',
      tenant_slug: 'tenant-alpha',
      role: 'tenant_admin',
      site_ids: [],
    },
    {
      tenant_id: tenantB,
      tenant_name: 'Tenant Beta',
      tenant_slug: 'tenant-beta',
      role: 'viewer',
      site_ids: [],
    },
  ],
};

let lastRequest = null;

function personaFor(request) {
  const authorization = request.headers.authorization ?? '';
  const match = /^Bearer test-access-token-(.+)$/u.exec(authorization);
  const persona = match?.[1];
  return persona && memberships[persona] ? persona : undefined;
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  if (url.pathname === '/_health') {
    json(response, 200, { status: 'ok' });
    return;
  }
  if (url.pathname === '/_debug/last') {
    json(response, 200, lastRequest);
    return;
  }
  if (url.pathname === '/_debug/reset') {
    lastRequest = null;
    json(response, 200, { status: 'ok' });
    return;
  }

  const body = await readBody(request);
  const persona = personaFor(request);
  if (!persona) {
    json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'missing token' } });
    return;
  }
  lastRequest = {
    method: request.method,
    path: url.pathname,
    headers: request.headers,
    body,
  };

  if (url.pathname === '/me' && request.method === 'GET') {
    if (persona === 'unverified') {
      json(response, 403, {
        error: { code: 'EMAIL_UNVERIFIED', message: 'email_not_verified' },
      });
      return;
    }
    const email = `${persona === 'multitenant' ? 'multi' : persona}@example.com`;
    json(response, 200, {
      id: `90000000-0000-4000-8000-00000000000${persona === 'admin' ? '1' : '2'}`,
      email,
      display_name:
        persona === 'admin'
          ? 'Ada Admin'
          : persona === 'viewer'
            ? 'Vic Viewer'
            : persona === 'manager'
              ? 'Sam Manager'
              : 'Test User',
      email_verified: true,
      is_platform_admin: persona === 'admin',
      memberships: memberships[persona],
    });
    return;
  }

  if (url.pathname === '/sites' && request.method === 'GET') {
    json(response, 200, {
      sites: [
        {
          id: '20000000-0000-4000-8000-000000000001',
          tenant_id: request.headers['x-tenant-id'],
          name: 'Central Charging Hub',
          address: 'MG Road, Bengaluru',
          status: 'active',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    return;
  }

  if (url.pathname === '/users' && request.method === 'GET') {
    json(response, 200, {
      users: [
        {
          id: '90000000-0000-4000-8000-000000000001',
          email: 'admin@example.com',
          display_name: 'Ada Admin',
          membership_id: '30000000-0000-4000-8000-000000000001',
          role: 'tenant_admin',
          site_ids: [],
        },
      ],
      next_cursor: null,
    });
    return;
  }

  if (/^\/tenants\/[^/]+\/invitations$/u.test(url.pathname) && request.method === 'GET') {
    json(response, 200, {
      invitations: [
        {
          id: '40000000-0000-4000-8000-000000000001',
          tenant_id: tenantA,
          email: 'pending@example.com',
          role: 'viewer',
          site_ids: [],
          expires_at: '2026-12-01T00:00:00.000Z',
          accepted_at: null,
          revoked_at: null,
          created_at: '2026-11-01T00:00:00.000Z',
        },
      ],
    });
    return;
  }

  if (url.pathname === '/tenants' && request.method === 'GET') {
    json(response, 200, {
      tenants: [
        {
          id: tenantA,
          name: 'Tenant Alpha',
          slug: 'tenant-alpha',
          status: 'active',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: tenantB,
          name: 'Tenant Beta',
          slug: 'tenant-beta',
          status: 'active',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    return;
  }

  if (url.pathname === '/invitations/accept' && request.method === 'POST') {
    const parsed = JSON.parse(body || '{}');
    if (!String(parsed.token ?? '').startsWith('good-')) {
      json(response, 400, { error: { code: 'INVITATION_FAILED', message: 'invalid token' } });
      return;
    }
    json(response, 200, {
      tenant_id: tenantA,
      membership_id: '30000000-0000-4000-8000-000000000002',
      role: 'viewer',
    });
    return;
  }

  json(response, 404, { error: { code: 'NOT_FOUND', message: 'mock route not found' } });
});

server.listen(port, host, () => {
  process.stdout.write(`mock-api listening on http://${host}:${port}\n`);
});
