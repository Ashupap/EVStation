#!/usr/bin/env node
/**
 * Phase 2b end-to-end proof.
 *
 * - registers tenant-A and tenant-B stations through POST /stations (admin JWT)
 * - connects the tenant-A charger to 8082 with the returned Basic credentials
 * - asserts through the tenant-scoped API/RLS: session, meter samples, five
 *   StatusNotifications, connector status, runtime last_seen/connection and
 *   the ingestion ledger volume rules
 * - captures the real AMQP messages, replays them and asserts no new rows
 * - replays a stale connection.connected after closed and asserts ordering
 * - replays tenant-A messages with tenant-B station_ref and asserts A is
 *   untouched while B receives its own rows
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(repoRoot, 'infra/compose/.env');
const env = {};
for (const line of fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : []) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}
const value = (name, fallback) => process.env[name] ?? env[name] ?? fallback;
const problem = [];
function ok(name, detail) {
  console.log(`ok   ${name} — ${detail}`);
}
function fail(name, detail) {
  console.log(`FAIL ${name} — ${detail}`);
  problem.push(`${name}: ${detail}`);
}
function requireValue(name, current) {
  if (!current) throw new Error(`${name} missing in infra/compose/.env`);
  return current;
}

const KC_PORT = value('KEYCLOAK_HTTP_HOST_PORT', '8180');
const KC = `http://127.0.0.1:${KC_PORT}`;
const API_PORT = value('PHASE2B_API_PORT', '4000');
const API = `http://127.0.0.1:${API_PORT}`;
const HASURA = 'http://127.0.0.1:8090/v1/graphql';
const AMQP_MGMT = value('RABBITMQ_MGMT_URL', 'http://127.0.0.1:15672/api');
const AMQP_AUTH = `Basic ${Buffer.from('guest:guest').toString('base64')}`;
const TENANT_A = '10000000-0000-4000-8000-000000000001';
const TENANT_B = '10000000-0000-4000-8000-000000000002';
const SITE_A = '20000000-0000-4000-8000-000000000001';
const SITE_B = '20000000-0000-4000-8000-000000000003';
const E2E_PASSWORD = value('E2E_USER_PASSWORD', 'evstation-dev-password');
const RUN = String(Date.now()).slice(-6);
const STATION_A = `ACME-BLR-${RUN.slice(-3)}`;
const STATION_B = `BETA-BOM-${RUN.slice(-3)}`;
const CAPTURE_KEYS = [
  'frame.inbound.BootNotification',
  'frame.inbound.StatusNotification',
  'frame.inbound.Heartbeat',
  'frame.inbound.StartTransaction',
  'frame.inbound.MeterValues',
  'frame.inbound.StopTransaction',
  'frame.outbound.StartTransaction',
  'connection.connected',
  'connection.closed',
];
const children = [];
let stopping = false;

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      ...(url.includes(':15672')
        ? { headers: { ...(options.headers ?? {}), connection: 'close' } }
        : {}),
    });
  } catch (error) {
    console.error('fetch_failed', { url, cause: error?.cause ?? error });
    throw error;
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 401) return;
    } catch {
      /* expected while starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function keycloakAdminToken() {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: requireValue('KC_BOOTSTRAP_ADMIN_USERNAME', value('KC_BOOTSTRAP_ADMIN_USERNAME')),
    password: requireValue('KC_BOOTSTRAP_ADMIN_PASSWORD', value('KC_BOOTSTRAP_ADMIN_PASSWORD')),
  });
  const { response, body: token } = await request(
    `${KC}/realms/master/protocol/openid-connect/token`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
  );
  if (!response.ok || !token?.access_token) throw new Error('Keycloak admin token failed');
  return token.access_token;
}

async function ensureSmokeClient(adminToken) {
  const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  let clients = await request(`${KC}/admin/realms/evstation/clients?clientId=evstation-smoke`, {
    headers,
  });
  let client = Array.isArray(clients.body) ? clients.body[0] : undefined;
  if (!client) {
    await request(`${KC}/admin/realms/evstation/clients`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        clientId: 'evstation-smoke',
        enabled: true,
        publicClient: true,
        directAccessGrantsEnabled: true,
        standardFlowEnabled: false,
        serviceAccountsEnabled: false,
        protocol: 'openid-connect',
      }),
    });
    clients = await request(`${KC}/admin/realms/evstation/clients?clientId=evstation-smoke`, {
      headers,
    });
    client = clients.body[0];
  }
  if (!client?.id) throw new Error('evstation-smoke client unavailable');
  const mappers = await request(
    `${KC}/admin/realms/evstation/clients/${client.id}/protocol-mappers/models`,
    { headers },
  );
  if (!mappers.body?.some((mapper) => mapper.name === 'evstation-api-audience')) {
    await request(`${KC}/admin/realms/evstation/clients/${client.id}/protocol-mappers/models`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'evstation-api-audience',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: { 'included.custom.audience': 'evstation-api', 'access.token.claim': 'true' },
      }),
    });
  }
}

async function userToken(email) {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'evstation-smoke',
    username: email,
    password: E2E_PASSWORD,
  });
  const { response, body: token } = await request(
    `${KC}/realms/evstation/protocol/openid-connect/token`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
  );
  if (!response.ok || !token?.access_token) {
    throw new Error(
      `Keycloak user token failed for ${email}: ${JSON.stringify(token).slice(0, 200)}`,
    );
  }
  return token.access_token;
}

function apiEnv() {
  const appPassword = value('OUR_DB_APP_PASSWORD');
  requireValue('OUR_DB_APP_PASSWORD', appPassword);
  const dbHost = value('OUR_DB_HOST', 'localhost');
  const dbPort = value('OUR_DB_HOST_PORT', '5432');
  return {
    ...process.env,
    NODE_ENV: 'development',
    PORT: API_PORT,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    DATABASE_URL_APP:
      value('DATABASE_URL_APP') ??
      `postgres://evstation_app:${encodeURIComponent(appPassword)}@${dbHost}:${dbPort}/evstation`,
    OIDC_ISSUER: `http://localhost:${KC_PORT}/realms/evstation`,
    OIDC_AUDIENCE: 'evstation-api',
    CSMS_BASE_URL: value('CSMS_BASE_URL', 'http://localhost:8088'),
    CSMS_HASURA_URL: value('CSMS_HASURA_URL', HASURA),
    CSMS_AUTH_MODE: 'localDev',
    CSMS_TOKEN_URL: `http://localhost:${KC_PORT}/realms/evstation/protocol/openid-connect/token`,
    CSMS_TENANT_ID: value('CSMS_TENANT_ID', '1'),
    METRICS_TOKEN: value('METRICS_TOKEN', 'test-metrics-token'),
    CSMS_PROVISIONER_CLIENT_ID: value('CSMS_PROVISIONER_CLIENT_ID', 'csms-provisioner'),
    CSMS_PROVISIONER_CLIENT_SECRET: requireValue(
      'KC_CSMS_PROVISIONER_CLIENT_SECRET',
      value('KC_CSMS_PROVISIONER_CLIENT_SECRET'),
    ),
    CSMS_READER_CLIENT_ID: value('CSMS_READER_CLIENT_ID', 'csms-reader'),
    CSMS_READER_CLIENT_SECRET: requireValue(
      'KC_CSMS_READER_CLIENT_SECRET',
      value('KC_CSMS_READER_CLIENT_SECRET'),
    ),
  };
}

function start(command, args, name, logFile, processEnv) {
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: processEnv,
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  children.push({ child, name, logFile });
  child.on('exit', (code) => {
    if (code !== 0 && !stopping && !child.killed) fail(name, `exited ${code} (${logFile})`);
  });
  return child;
}

async function stopChildren() {
  stopping = true;
  for (const { child } of children) {
    if (!child.killed && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function apiCall(token, tenant, method, urlPath, body) {
  return request(`${API}${urlPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(tenant ? { 'x-tenant-id': tenant } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function registerStation(token, tenant, siteId, stationRef) {
  const { response, body } = await apiCall(token, tenant, 'POST', '/stations', {
    site_id: siteId,
    station_ref: stationRef,
    latitude: 12.9716,
    longitude: 77.5946,
    connectors: [{ connector_number: 1 }],
  });
  if (response.status !== 201 || !body?.station?.id || !body?.credentials?.password) {
    throw new Error(
      `POST /stations ${stationRef} failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 400)}`,
    );
  }
  ok('api-register', `${stationRef} station#${body.station.id} (credentials returned)`);
  return body;
}

async function captureQueue() {
  const name = `evstation.e2e.capture.${RUN}`;
  const enc = encodeURIComponent('/');
  await request(`${AMQP_MGMT}/queues/${enc}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { authorization: AMQP_AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ durable: false, auto_delete: true }),
  });
  for (const key of CAPTURE_KEYS) {
    await request(`${AMQP_MGMT}/bindings/${enc}/e/messages/q/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { authorization: AMQP_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ routing_key: key, arguments: {} }),
    });
  }
  return name;
}

async function drainCapture(name) {
  const enc = encodeURIComponent('/');
  const { body } = await request(`${AMQP_MGMT}/queues/${enc}/${encodeURIComponent(name)}/get`, {
    method: 'POST',
    headers: { authorization: AMQP_AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ count: 100, ackmode: 'ack_requeue_false', encoding: 'auto' }),
  });
  await request(`${AMQP_MGMT}/queues/${enc}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { authorization: AMQP_AUTH },
  });
  return (Array.isArray(body) ? body : []).map((message) => ({
    routingKey: message.routing_key,
    payload: message.payload,
  }));
}

async function publish(message) {
  const enc = encodeURIComponent('/');
  const response = await fetch(`${AMQP_MGMT}/exchanges/${enc}/messages/publish`, {
    method: 'POST',
    headers: { authorization: AMQP_AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      routing_key: message.routingKey,
      payload: message.payload,
      payload_encoding: 'string',
      properties: { content_type: 'application/json' },
    }),
  });
  if (!response.ok) throw new Error(`AMQP publish failed: HTTP ${response.status}`);
}

async function queueMessages(name) {
  const enc = encodeURIComponent('/');
  const response = await fetch(`${AMQP_MGMT}/queues/${enc}/${encodeURIComponent(name)}`, {
    headers: { authorization: AMQP_AUTH, connection: 'close' },
  });
  if (!response.ok) return 0;
  const body = await response.json();
  return typeof body.messages === 'number' ? body.messages : 0;
}

async function waitForQueuesToSettle(deadlineMs = 45_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const [main, retry] = await Promise.all([
      queueMessages('evstation.ingest'),
      queueMessages('evstation.ingest.retry'),
    ]);
    if (main === 0 && retry === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail('retry-settle', 'queues did not settle before timeout');
}

async function waitUntil(fn, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(label, `timed out after ${timeoutMs}ms`);
  return false;
}

async function snapshot(token, tenant, stationId) {
  const sessions = await apiCall(
    token,
    tenant,
    'GET',
    `/sessions?station_id=${stationId}&limit=100`,
  );
  const session = sessions.body?.sessions?.find((row) => row.station_id === stationId);
  const detail = session
    ? await apiCall(token, tenant, 'GET', `/sessions/${session.id}`)
    : { body: { session: null, meter_values: [] } };
  const status = await apiCall(
    token,
    tenant,
    'GET',
    `/stations/${stationId}/status-events?limit=100`,
  );
  const ledger = await apiCall(
    token,
    tenant,
    'GET',
    `/stations/${stationId}/ingestion-events?limit=100`,
  );
  const station = await apiCall(token, tenant, 'GET', `/stations/${stationId}`);
  const connectors = await apiCall(token, tenant, 'GET', `/stations/${stationId}/connectors`);
  return {
    sessions: sessions.body?.sessions ?? [],
    session: detail.body?.session ?? null,
    meters: detail.body?.meter_values ?? [],
    status: status.body?.status_events ?? [],
    ledger: ledger.body?.ingestion_events ?? [],
    station: station.body,
    connectors: connectors.body?.connectors ?? [],
  };
}

function ledgerCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  return counts;
}

function assertVolumeRules(rows, label, expectedConnection = 2) {
  const counts = ledgerCounts(rows);
  const forbidden = ['heartbeat', 'status', 'meter'];
  if (forbidden.some((kind) => counts[kind])) {
    fail(`${label}-ledger`, `accepted heartbeat/status/meter leaked: ${JSON.stringify(counts)}`);
  } else {
    ok(`${label}-ledger`, `no heartbeat/status/meter rows; kinds=${JSON.stringify(counts)}`);
  }
  const expected = {
    boot: 1,
    connection: expectedConnection,
    start: 1,
    start_response: 1,
    stop: 1,
  };
  for (const [kind, count] of Object.entries(expected)) {
    if (counts[kind] !== count)
      fail(`${label}-${kind}`, `expected ${count}, got ${counts[kind] ?? 0}`);
  }
}

function hasSessionRows(snapshotValue, ref) {
  return snapshotValue.sessions.some((row) => row.csms_transaction_ref === ref);
}

async function main() {
  const adminToken = await keycloakAdminToken();
  await ensureSmokeClient(adminToken);
  const tokenA = await userToken('admin@acme.example');
  const tokenB = await userToken('admin@beta.example');
  ok('keycloak', 'admin tokens issued for tenants A and B');

  const apiLog = `/tmp/evstation-phase2b-api-${RUN}.log`;
  const workerLog = `/tmp/evstation-phase2b-worker-${RUN}.log`;
  start('pnpm', ['--filter', '@evstation/api', 'start'], 'api', apiLog, apiEnv());
  start('pnpm', ['--filter', '@evstation/worker', 'start'], 'worker', workerLog, {
    ...process.env,
    ...env,
    WORKER_HEALTH_PORT: value('PHASE2B_WORKER_HEALTH_PORT', '4110'),
    CSMS_INGEST_QUEUE: value('CSMS_INGEST_QUEUE', 'evstation.ingest'),
  });
  try {
    await waitFor(`${API}/health/ready`);
    ok('api-ready', `${API}/health/ready`);
    await waitFor(`http://127.0.0.1:${value('PHASE2B_WORKER_HEALTH_PORT', '4110')}/healthz`);
    ok('worker-ready', 'healthz 200');

    const a = await registerStation(tokenA, TENANT_A, SITE_A, STATION_A);
    const b = await registerStation(tokenB, TENANT_B, SITE_B, STATION_B);

    const queue = await captureQueue();
    const py = value('SIM_PYTHON', path.join(repoRoot, '.venv/bin/python'));
    const simulator = spawnSync(
      py,
      [
        path.join(repoRoot, 'tools/simulator/charger_simulator.py'),
        '--url',
        'ws://localhost:8082',
        '--id',
        STATION_A,
        '--password',
        a.credentials.password,
        '--exit-after-session',
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 180_000 },
    );
    process.stdout.write(simulator.stdout ?? '');
    process.stderr.write(simulator.stderr ?? '');
    if (simulator.status !== 0) throw new Error(`simulator failed exit=${simulator.status}`);
    ok('simulator', `8082 Basic auth session ${a.station.id}`);
    await new Promise((resolve) => setTimeout(resolve, 750));
    const captured = await drainCapture(queue);
    ok('capture', `${captured.length} AMQP messages captured`);

    const sessionRef = (simulator.stdout ?? '').match(/"transactionId":\s*(\d+)/)?.[1];
    if (!sessionRef) throw new Error('transactionId missing from simulator output');
    await waitUntil(async () => {
      const snap = await snapshot(tokenA, TENANT_A, a.station.id);
      return (
        snap.session?.status === 'completed' && snap.station?.connection_state === 'disconnected'
      );
    }, 'tenant-A-session');
    const before = await snapshot(tokenA, TENANT_A, a.station.id);
    if (!hasSessionRows(before, sessionRef)) throw new Error('A session missing');
    if (before.meters.length !== 3) fail('A-meter', `expected 3, got ${before.meters.length}`);
    else ok('A-meter', '3 samples');
    if (before.status.length !== 5) fail('A-status', `expected 5, got ${before.status.length}`);
    else ok('A-status', '5 StatusNotifications');
    const connector = before.connectors.find((row) => row.connector_number === 1);
    if (connector?.status !== 'available') fail('A-connector', `status=${connector?.status}`);
    else ok('A-connector', 'available');
    if (before.station?.connection_state !== 'disconnected' || !before.station?.last_seen_at) {
      fail(
        'A-runtime',
        `state=${before.station?.connection_state} last_seen=${before.station?.last_seen_at}`,
      );
    } else {
      ok('A-runtime', 'disconnected with last_seen_at');
    }
    assertVolumeRules(before.ledger, 'A');

    const aCounts = {
      sessions: before.sessions.length,
      meters: before.meters.length,
      status: before.status.length,
      ledger: before.ledger.length,
    };
    for (const message of captured) await publish(message);
    await waitForQueuesToSettle();
    const after = await snapshot(tokenA, TENANT_A, a.station.id);
    if (
      after.sessions.length !== aCounts.sessions ||
      after.meters.length !== aCounts.meters ||
      after.status.length !== aCounts.status ||
      after.ledger.length !== aCounts.ledger
    ) {
      fail(
        'replay-idempotent',
        `before=${JSON.stringify(aCounts)} after=${JSON.stringify({
          sessions: after.sessions.length,
          meters: after.meters.length,
          status: after.status.length,
          ledger: after.ledger.length,
        })}`,
      );
    } else {
      ok('replay-idempotent', 'sessions/meters/status/ledger unchanged');
    }

    const staleConnected = captured.find(
      (message) => message.routingKey === 'connection.connected',
    );
    if (staleConnected) {
      await publish(staleConnected);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const stale = await snapshot(tokenA, TENANT_A, a.station.id);
      if (stale.station?.connection_state !== 'disconnected') {
        fail('out-of-order', `stale connected overrode closed: ${stale.station?.connection_state}`);
      } else {
        ok('out-of-order', 'stale connected did not override closed');
      }
    }

    const bBefore = await snapshot(tokenB, TENANT_B, b.station.id);
    for (const message of captured) {
      let parsed;
      try {
        parsed = JSON.parse(message.payload);
      } catch {
        continue;
      }
      if (parsed.ocppConnectionName === STATION_A) {
        parsed.ocppConnectionName = STATION_B;
        await publish({ routingKey: message.routingKey, payload: JSON.stringify(parsed) });
      }
    }
    await waitForQueuesToSettle();
    await waitUntil(async () => {
      const snap = await snapshot(tokenB, TENANT_B, b.station.id);
      return snap.session?.status === 'completed';
    }, 'tenant-B-session');
    const bAfter = await snapshot(tokenB, TENANT_B, b.station.id);
    if (bAfter.session?.status !== 'completed') fail('B-session', 'not completed');
    else ok('B-session', 'completed');
    if (bAfter.status.length !== 5) fail('B-status', `expected 5, got ${bAfter.status.length}`);
    else ok('B-status', '5 StatusNotifications');
    const capturedConnections = captured.filter((message) =>
      message.routingKey.startsWith('connection.'),
    ).length;
    assertVolumeRules(bAfter.ledger, 'B', capturedConnections);
    const aAfterCross = await snapshot(tokenA, TENANT_A, a.station.id);
    if (
      aAfterCross.sessions.length !== aCounts.sessions ||
      aAfterCross.meters.length !== aCounts.meters ||
      aAfterCross.status.length !== aCounts.status ||
      aAfterCross.ledger.length !== aCounts.ledger
    ) {
      fail('cross-tenant', 'tenant-B replay changed tenant-A rows');
    } else {
      ok('cross-tenant', 'tenant-B events did not touch tenant-A rows');
    }
    void bBefore;
  } finally {
    await stopChildren();
  }
  if (problem.length) {
    console.log(`phase2b-e2e: FAIL (${problem.length} problem${problem.length === 1 ? '' : 's'})`);
    process.exit(1);
  }
  console.log('phase2b-e2e: PASS');
}

main().catch(async (error) => {
  console.error(`phase2b-e2e: crashed ${error?.stack ?? error}`);
  await stopChildren();
  process.exit(1);
});
