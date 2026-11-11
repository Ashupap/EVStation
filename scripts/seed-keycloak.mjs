#!/usr/bin/env node
/**
 * Apply dev-only Keycloak realm settings that cannot come from the committed
 * realm import (currently the confidential dashboard client secret).
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

async function applyClient(token) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const response = await request(
    `${baseUrl}/admin/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const clients = await response.json();
  const client = Array.isArray(clients) ? clients[0] : undefined;
  if (!client?.id) throw new Error(`Keycloak client ${clientId} not found in realm ${realm}`);

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
    attributes: { ...client.attributes, 'pkce.code.challenge.method': 'S256' },
  };
  await request(`${baseUrl}/admin/realms/${realm}/clients/${client.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(updated),
  });
}

let lastError;
for (let attempt = 1; attempt <= 45; attempt += 1) {
  try {
    await applyClient(await getAdminToken());
    console.log('keycloak-seed: applied dashboard confidential-client settings');
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt === 45) break;
    await sleep(2000);
  }
}
console.error(`keycloak-seed: failed: ${lastError?.message ?? 'unknown error'}`);
process.exit(1);
