#!/usr/bin/env node
/**
 * Apply dev-only Keycloak realm settings that cannot come from the committed
 * realm import (client secret, dashboard audience mapper, test-user passwords).
 *
 * Reads infra/compose/.env; never prints secret values. Safe to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(repoRoot, 'infra/compose/.env');

function readEnv(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${file}; run pnpm dev:stack first`);
  }
  const vars = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

function required(vars, name) {
  const value = vars[name];
  if (!value) throw new Error(`${name} is required in infra/compose/.env`);
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const vars = readEnv(envFile);
const keycloakPort = vars.KEYCLOAK_HTTP_HOST_PORT || '8180';
const baseUrl = `http://127.0.0.1:${keycloakPort}`;
const adminUser = required(vars, 'KC_BOOTSTRAP_ADMIN_USERNAME');
const adminPassword = required(vars, 'KC_BOOTSTRAP_ADMIN_PASSWORD');
const clientSecret = required(vars, 'KC_DASHBOARD_CLIENT_SECRET');
const realm = 'evstation';
const clientId = 'dashboard';
const e2ePassword = process.env.E2E_USER_PASSWORD || 'evstation-dev-password';

const E2E_USERS = [
  ['00000000-0000-4000-8000-000000000001', 'platform@evstation.dev', 'Platform', 'Admin'],
  ['00000000-0000-4000-8000-000000000002', 'admin@acme.example', 'Acme', 'Admin'],
  ['00000000-0000-4000-8000-000000000003', 'admin@beta.example', 'Beta', 'Admin'],
  ['00000000-0000-4000-8000-000000000004', 'manager@acme.example', 'Acme', 'Manager'],
  ['00000000-0000-4000-8000-000000000005', 'viewer@acme.example', 'Acme', 'Viewer'],
];

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `${options.method ?? 'GET'} ${url} failed: ${response.status} ${body.slice(0, 200)}`,
    );
  }
  return response;
}

async function getAdminToken() {
  const response = await request(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUser,
      password: adminPassword,
    }),
  });
  const body = await response.json();
  if (typeof body.access_token !== 'string') throw new Error('Keycloak admin token missing');
  return body.access_token;
}

function authorization(token) {
  return { authorization: `Bearer ${token}` };
}

async function applyClient(token) {
  const headers = { ...authorization(token), 'content-type': 'application/json' };
  const response = await request(
    `${baseUrl}/admin/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`,
    { headers: authorization(token) },
  );
  const clients = await response.json();
  const client = Array.isArray(clients) ? clients[0] : undefined;
  if (!client?.id) throw new Error(`Keycloak client ${clientId} not found in realm ${realm}`);

  const protocolMappers = [...(client.protocolMappers ?? [])];
  const audienceMapper = 'evstation-api-audience';
  if (!protocolMappers.some((mapper) => mapper.name === audienceMapper)) {
    protocolMappers.push({
      name: audienceMapper,
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      consentRequired: false,
      config: {
        'included.custom.audience': 'evstation-api',
        'access.token.claim': 'true',
        'id.token.claim': 'false',
      },
    });
  }

  const updated = {
    ...client,
    publicClient: false,
    clientAuthenticatorType: 'client-secret',
    secret: clientSecret,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: ['http://localhost:3200/*'],
    webOrigins: ['http://localhost:3200'],
    defaultClientScopes: [
      ...new Set(['basic', ...(client.defaultClientScopes ?? ['profile', 'email', 'roles'])]),
    ],
    attributes: {
      ...client.attributes,
      'pkce.code.challenge.method': 'S256',
      'post.logout.redirect.uris': 'http://localhost:3200/login',
    },
    protocolMappers,
  };
  await request(`${baseUrl}/admin/realms/${realm}/clients/${client.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(updated),
  });

  const scopes = await request(`${baseUrl}/admin/realms/${realm}/client-scopes`, {
    headers: authorization(token),
  });
  const basic = (await scopes.json()).find((scope) => scope.name === 'basic');
  if (!basic?.id) throw new Error('Keycloak basic client scope not found');
  await request(
    `${baseUrl}/admin/realms/${realm}/clients/${client.id}/default-client-scopes/${basic.id}`,
    { method: 'PUT', headers },
  );
}

async function applyUsers(token) {
  for (const [id, email] of E2E_USERS) {
    const lookup = await request(
      `${baseUrl}/admin/realms/${realm}/users?username=${encodeURIComponent(email)}&exact=true`,
      { headers: authorization(token) },
    );
    for (const user of await lookup.json()) {
      if (user.id === id) continue;
      await request(`${baseUrl}/admin/realms/${realm}/users/${encodeURIComponent(user.id)}`, {
        method: 'DELETE',
        headers: authorization(token),
      });
    }
  }

  await request(`${baseUrl}/admin/realms/${realm}/partialImport`, {
    method: 'POST',
    headers: { ...authorization(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      ifResourceExists: 'OVERWRITE',
      users: E2E_USERS.map(([id, email, firstName, lastName]) => ({
        id,
        username: email,
        email,
        emailVerified: true,
        enabled: true,
        firstName,
        lastName,
        credentials: [{ type: 'password', value: e2ePassword, temporary: false }],
      })),
    }),
  });

  for (const [id, email] of E2E_USERS) {
    const response = await request(
      `${baseUrl}/admin/realms/${realm}/users/${encodeURIComponent(id)}`,
      { headers: authorization(token) },
    );
    const user = await response.json();
    if (user.email !== email) throw new Error(`Keycloak user id ${id} does not match ${email}`);
  }
}

async function seed(token) {
  await applyClient(token);
  await applyUsers(token);
}

let lastError;
for (let attempt = 1; attempt <= 45; attempt += 1) {
  try {
    await seed(await getAdminToken());
    console.log(
      'keycloak-seed: applied dashboard client, audience mapper, and verified test users',
    );
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt === 45) break;
    await sleep(2000);
  }
}
console.error(`keycloak-seed: failed: ${lastError?.message ?? 'unknown error'}`);
process.exit(1);
