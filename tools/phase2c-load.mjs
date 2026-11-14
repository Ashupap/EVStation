#!/usr/bin/env node
/**
 * Phase 2c N-stream load evidence.
 *
 * Opens many concurrent `/events` streams for one tenant, drives a steady
 * ingest rate through the real worker, and reports what the API did under
 * that load: connections held, CPU and memory, re-read cost per event,
 * dropped events, backpressure closes and notification queue usage.
 *
 * Ingest is driven by publishing real OCPP frames onto the `messages`
 * exchange, so the whole path runs: AMQP -> worker -> Postgres -> NOTIFY
 * -> API LISTEN -> RLS re-read -> fan-out -> stream.
 *
 * The shipped stream limits are respected: 10 streams per user, 250 per
 * tenant, 2000 per process. The script therefore provisions enough users to
 * hold the requested number of streams and spreads the ingest over several
 * stations, because re-reads for one station are serialized behind each
 * other and cap that station at about one event per re-read latency.
 *
 *   node tools/phase2c-load.mjs
 *
 * Environment:
 *   PHASE2C_LOAD_STREAMS      concurrent streams (default 200)
 *   PHASE2C_LOAD_RATE         ingest events per second (default 50)
 *   PHASE2C_LOAD_SECONDS      ingest duration (default 30)
 *   PHASE2C_LOAD_STATIONS     stations to spread events over (default 10)
 *   PHASE2C_LOAD_LOG          evidence log path
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import amqp from 'amqplib';
import pg from 'pg';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(repoRoot, 'infra/compose/.env');
const env = {};
for (const line of fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : []) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}
const value = (name, fallback) => process.env[name] ?? env[name] ?? fallback;
const requireValue = (name) => {
  const current = value(name);
  if (!current) throw new Error(`${name} missing in infra/compose/.env`);
  return current;
};

const KC_PORT = value('KEYCLOAK_HTTP_HOST_PORT', '8180');
const KC = `http://127.0.0.1:${KC_PORT}`;
const API_PORT = value('PHASE2C_LOAD_API_PORT', '4010');
const API = `http://127.0.0.1:${API_PORT}`;
const WORKER_HEALTH_PORT = value('PHASE2C_LOAD_WORKER_HEALTH_PORT', '4120');
const TENANT_A = '10000000-0000-4000-8000-000000000001';
const SITE_A = '20000000-0000-4000-8000-000000000001';
const E2E_PASSWORD = value('E2E_USER_PASSWORD', 'evstation-dev-password');
const RUN = String(Date.now()).slice(-6);
const STREAMS = Number(value('PHASE2C_LOAD_STREAMS', '200'));
const RATE = Number(value('PHASE2C_LOAD_RATE', '50'));
const SECONDS = Number(value('PHASE2C_LOAD_SECONDS', '30'));
const STATIONS = Number(value('PHASE2C_LOAD_STATIONS', '10'));
// Must match the API's own default; both are set from this value.
const STREAMS_PER_USER = Number(value('SSE_MAX_PER_USER', '10'));
const LOG_PATH = value(
  'PHASE2C_LOAD_LOG',
  path.join(repoRoot, 'docs/evidence/phase2c-load-200.log'),
);
const METRICS_TOKEN = value('METRICS_TOKEN', 'test-metrics-token');

const children = [];
let stopping = false;
const problems = [];
const cleanup = { stations: [], users: [] };
const readers = [];

function ok(name, detail) {
  console.log(`ok   ${name} — ${detail}`);
}
function fail(name, detail) {
  console.log(`FAIL ${name} — ${detail}`);
  problems.push(`${name}: ${detail}`);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
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
    username: requireValue('KC_BOOTSTRAP_ADMIN_USERNAME'),
    password: requireValue('KC_BOOTSTRAP_ADMIN_PASSWORD'),
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
  const appPassword = requireValue('OUR_DB_APP_PASSWORD');
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
    METRICS_TOKEN: METRICS_TOKEN,
    SSE_MAX_PER_USER: String(STREAMS_PER_USER),
    CSMS_BASE_URL: value('CSMS_BASE_URL', 'http://localhost:8088'),
    CSMS_HASURA_URL: value('CSMS_HASURA_URL', 'http://127.0.0.1:8090/v1/graphql'),
    CSMS_AUTH_MODE: 'localDev',
    CSMS_TOKEN_URL: `http://localhost:${KC_PORT}/realms/evstation/protocol/openid-connect/token`,
    CSMS_TENANT_ID: value('CSMS_TENANT_ID', '1'),
    CSMS_PROVISIONER_CLIENT_ID: value('CSMS_PROVISIONER_CLIENT_ID', 'csms-provisioner'),
    CSMS_PROVISIONER_CLIENT_SECRET: requireValue('KC_CSMS_PROVISIONER_CLIENT_SECRET'),
    CSMS_READER_CLIENT_ID: value('CSMS_READER_CLIENT_ID', 'csms-reader'),
    CSMS_READER_CLIENT_SECRET: requireValue('KC_CSMS_READER_CLIENT_SECRET'),
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

function databaseUrl() {
  const host = value('OUR_DB_HOST', 'localhost');
  const port = value('OUR_DB_HOST_PORT', '5432');
  return `postgres://evstation:${encodeURIComponent(requireValue('OUR_DB_PASSWORD'))}@${host}:${port}/evstation`;
}

/** Reads one SSE stream and counts the frames it receives. */
class StreamReader {
  constructor() {
    this.frames = 0;
    this.byKind = {};
    this.controller = new AbortController();
    this.error = null;
  }

  async open(url, token, tenantId) {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
        accept: 'text/event-stream',
      },
      signal: this.controller.signal,
    });
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    void this.pump(response.body);
  }

  async pump(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const index = buffer.indexOf('\n\n');
          if (index < 0) break;
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (block.startsWith(':') || block.trim() === '') continue;
          let name = 'message';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
          }
          this.frames += 1;
          this.byKind[name] = (this.byKind[name] ?? 0) + 1;
        }
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.error = error;
    }
  }

  close() {
    this.controller.abort();
  }
}

/** Reads a process's CPU time and resident memory from /proc. */
function processStats(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const clockTicks = 100;
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /VmRSS:\s+(\d+) kB/u.exec(status);
    return {
      cpuSeconds: (Number(fields[11]) + Number(fields[12])) / clockTicks,
      rssKb: rss ? Number(rss[1]) : null,
    };
  } catch {
    return { cpuSeconds: null, rssKb: null };
  }
}

function findApiPid(port) {
  try {
    const out = execFileSync('ss', ['-ltnp', `sport = :${port}`], { encoding: 'utf8' });
    const match = out.match(/pid=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Builds a frame in the shape CitrineOS publishes, so the worker ingests it
 * exactly as it would a real charger frame.
 */
function ocppFrame(stationRef, action, payload, timestamp) {
  const correlationId = crypto.randomUUID();
  const frame = [2, correlationId, action, payload];
  return {
    kind: 'frame',
    tenantId: 1,
    ocppConnectionName: stationRef,
    direction: 'inbound',
    correlationId,
    origin: 'cs',
    type: 2,
    action,
    protocol: 'ocpp1.6',
    raw: JSON.stringify(frame),
    payload,
    frame,
    timestamp,
    parsed: true,
  };
}

/**
 * Creates the load users. Keycloak and our own tables must agree on the
 * user id, because the token subject is the primary key of app.users.
 * The ids are run-scoped so repeated runs never collide.
 */
async function provisionUsers(adminToken, count) {
  const users = [];
  // One extra user is provisioned for the ceiling probe, which opens a
  // stream of its own and must not push another user over the per-user
  // stream limit.
  for (let index = 0; index < count + 1; index += 1) {
    const id = `9b000000-0000-4000-8000-${RUN}${String(index).padStart(6, '0')}`;
    users.push({
      id,
      email: `load-${RUN}-${index}@acme.example`,
      displayName: `Load User ${index}`,
    });
  }

  const response = await request(`${KC}/admin/realms/evstation/partialImport`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ifResourceExists: 'SKIP',
      users: users.map((user) => ({
        id: user.id,
        username: user.email,
        email: user.email,
        emailVerified: true,
        enabled: true,
        firstName: 'Load',
        lastName: 'User',
        credentials: [{ type: 'password', value: E2E_PASSWORD, temporary: false }],
      })),
    }),
  });
  if (!response.response.ok) {
    throw new Error(`Keycloak partialImport failed: HTTP ${response.response.status}`);
  }

  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    for (const user of users) {
      await client.query(
        `INSERT INTO app.users (id, email, email_verified, display_name)
         VALUES ($1, $2, true, $3)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        [user.id, user.email, user.displayName],
      );
      await client.query(
        `INSERT INTO app.memberships (tenant_id, user_id, role)
         VALUES ($1, $2, 'tenant_admin')
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
        [TENANT_A, user.id],
      );
    }
  } finally {
    await client.end();
  }
  cleanup.users = users;
  return users;
}

/** Creates the stations the load publishes events for. */
async function provisionStations(count) {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  const stations = [];
  try {
    const existing = await client.query('SELECT station_ref FROM app.stations');
    const taken = new Set(existing.rows.map((row) => row.station_ref));
    for (let index = 0; index < count; index += 1) {
      // station_ref is ORG-SITE-NNN and globally unique, so pick a free NNN.
      let suffix = 100;
      while (taken.has(`ACME-BLR-${String(suffix).padStart(3, '0')}`)) suffix += 1;
      const stationRef = `ACME-BLR-${String(suffix).padStart(3, '0')}`;
      taken.add(stationRef);
      const inserted = await client.query(
        `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref, registration_status)
         VALUES ($1, $2, 'ACME', $3, 'registered') RETURNING id`,
        [TENANT_A, SITE_A, stationRef],
      );
      const stationId = inserted.rows[0].id;
      await client.query(
        `INSERT INTO app.connectors (tenant_id, site_id, station_id, connector_number)
         VALUES ($1, $2, $3, 1)`,
        [TENANT_A, SITE_A, stationId],
      );
      stations.push({ id: stationId, stationRef });
    }
  } finally {
    await client.end();
  }
  cleanup.stations = stations;
  return stations;
}

async function removeProvisioning(adminToken) {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    for (const station of cleanup.stations) {
      await client.query('DELETE FROM app.stations WHERE id = $1', [station.id]);
    }
    for (const user of cleanup.users) {
      await client.query('DELETE FROM app.memberships WHERE user_id = $1', [user.id]);
      await client.query('DELETE FROM app.users WHERE id = $1', [user.id]);
    }
  } catch {
    /* cleanup is best effort */
  } finally {
    await client.end();
  }
  if (adminToken) {
    // The admin token lives for a minute, which the load run outlives, so
    // a fresh one is fetched for the cleanup; the expired one would make
    // every delete fail with 401 and leave the users behind.
    let token = adminToken;
    try {
      token = await keycloakAdminToken();
    } catch {
      /* fall back to the token we already have */
    }
    for (const user of cleanup.users) {
      // Look the user up by username: Keycloak may have assigned an id of
      // its own, so deleting by the requested id can silently miss.
      const lookup = await request(
        `${KC}/admin/realms/evstation/users?username=${encodeURIComponent(user.email)}&exact=true`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      for (const found of Array.isArray(lookup.body) ? lookup.body : []) {
        await request(`${KC}/admin/realms/evstation/users/${found.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        });
      }
    }
  }
}

/**
 * Measures the highest publish rate one station sustains without the
 * re-read queue dropping events.
 *
 * One station and one stream are used so the measurement reflects the
 * per-station re-read cost and not the cost of fanning out to many
 * streams. Each step publishes at a rate, waits for the pipeline to
 * settle, and compares the events notified against the events published.
 *
 * The stream is opened up front, before the load starts, so the API's
 * per-actor rate limit is not hit part-way through the measurement.
 */
async function probePerStationCeiling(api, metricsToken, token, tenantId, stations) {
  const station = stations[0];
  const reader = new StreamReader();
  await reader.open(`${api}/events`, token, tenantId);

  const steps = [];
  let ceiling = null;
  const rates = [50, 100, 150, 200, 300, 400];

  try {
    for (const rate of rates) {
      const before = await readMetrics(api, metricsToken);
      const connection = await amqp.connect(
        env.CSMS_AMQP_URL ?? `amqp://guest:guest@localhost:5672`,
      );
      const channel = await connection.createChannel();
      await channel.assertExchange('messages', 'topic', { durable: true });

      const total = rate * 5;
      const intervalMs = 1000 / rate;
      const startedAt = Date.now();
      for (let index = 0; index < total; index += 1) {
        const timestamp = new Date(startedAt + index * intervalMs).toISOString();
        const payload = { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp };
        const body = ocppFrame(station.stationRef, 'StatusNotification', payload, timestamp);
        channel.publish(
          'messages',
          'frame.inbound.StatusNotification',
          Buffer.from(JSON.stringify(body)),
        );
        const due = startedAt + (index + 1) * intervalMs;
        const wait = due - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      await channel.close();
      await connection.close();

      // Wait for the queue to settle before reading the counters.
      const after = await waitForMetrics(
        api,
        metricsToken,
        (metrics) => metrics.events_notified - before.events_notified >= total,
      );

      const notified = after.events_notified - before.events_notified;
      const droppedQueueFull = after.events_dropped_queue_full - before.events_dropped_queue_full;
      steps.push({ rate, published: total, notified, droppedQueueFull });

      if (droppedQueueFull > 0 || notified < total) {
        // This rate exceeded the ceiling; the previous clean rate is it.
        const clean = [...steps].reverse().find((step) => step.droppedQueueFull === 0);
        ceiling = clean?.rate ?? null;
        break;
      }
      ceiling = rate;
    }
  } finally {
    reader.close();
  }

  return {
    stationRef: station.stationRef,
    steps,
    ceiling,
    note:
      'the highest rate at which every published event was notified without the re-read ' +
      'queue dropping any; re-reads for one station are serialized',
  };
}

/**
 * Reads the API metrics.
 *
 * `/metrics` is a public path, so it counts against the actor rate limit
 * (100 requests per minute, keyed on the client address when the request
 * carries no claim). Polling it quickly therefore returns 429, whose body
 * has no counters at all, so a rate-limited response is retried after a
 * pause rather than mistaken for a counter reset.
 */
async function readMetrics(api, metricsToken) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { response, body } = await request(`${api}/metrics`, {
      headers: { authorization: `Bearer ${metricsToken}` },
    });
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    if (response.ok && body && typeof body.events_notified === 'number') return body;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('could not read the API metrics');
}

/** Polls the metrics until the predicate holds or the deadline passes. */
async function waitForMetrics(api, metricsToken, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let metrics = await readMetrics(api, metricsToken);
  while (Date.now() < deadline) {
    if (predicate(metrics)) return metrics;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    metrics = await readMetrics(api, metricsToken);
  }
  return metrics;
}

/**
 * Removes any load users left behind by an earlier run.
 *
 * A run that dies before its cleanup finishes leaves its users in Keycloak
 * and in our tables. They are found by the `load-` email prefix, which is
 * unique to this script, so a stale run cannot poison the next one.
 */
async function removeStaleLoadUsers(adminToken) {
  const headers = { authorization: `Bearer ${adminToken}` };
  const stale = await request(`${KC}/admin/realms/evstation/users?max=500`, { headers });
  const clients = new pg.Client({ connectionString: databaseUrl() });
  await clients.connect();
  try {
    for (const user of Array.isArray(stale.body) ? stale.body : []) {
      if (!user.username?.startsWith('load-')) continue;
      await request(`${KC}/admin/realms/evstation/users/${user.id}`, {
        method: 'DELETE',
        headers,
      });
      await clients.query('DELETE FROM app.memberships WHERE user_id = $1', [user.id]);
      await clients.query('DELETE FROM app.users WHERE id = $1', [user.id]);
    }
  } catch {
    /* best effort */
  } finally {
    await clients.end();
  }
}

async function main() {
  const log = [];
  const record = (line) => {
    log.push(line);
    console.log(line);
  };

  const adminToken = await keycloakAdminToken();
  await ensureSmokeClient(adminToken);
  await removeStaleLoadUsers(adminToken);
  ok('keycloak', 'admin token issued, smoke client ensured, stale load users removed');

  const apiLog = `/tmp/evstation-phase2c-load-api-${RUN}.log`;
  const workerLog = `/tmp/evstation-phase2c-load-worker-${RUN}.log`;
  start('pnpm', ['--filter', '@evstation/api', 'start'], 'api', apiLog, apiEnv());
  start('pnpm', ['--filter', '@evstation/worker', 'start'], 'worker', workerLog, {
    ...process.env,
    ...env,
    WORKER_HEALTH_PORT: WORKER_HEALTH_PORT,
    CSMS_INGEST_QUEUE: value('CSMS_INGEST_QUEUE', 'evstation.ingest'),
  });

  try {
    await waitFor(`${API}/health/ready`);
    ok('api-ready', `${API}/health/ready`);
    await waitFor(`http://127.0.0.1:${WORKER_HEALTH_PORT}/healthz`);
    ok('worker-ready', 'healthz 200');

    const userCount = Math.ceil(STREAMS / STREAMS_PER_USER);
    const users = await provisionUsers(adminToken, userCount);
    ok(
      'provision-users',
      `${users.length - 1} load users (up to ${STREAMS_PER_USER} streams each) plus 1 probe user`,
    );
    const probeUser = users[users.length - 1];

    const stations = await provisionStations(STATIONS);
    ok('provision-stations', `${stations.length} stations`);

    const apiPid = findApiPid(API_PORT);
    const before = apiPid ? processStats(apiPid) : { cpuSeconds: null, rssKb: null };

    const metricsBefore = await readMetrics(API, METRICS_TOKEN);
    ok('metrics-before', `sse_connections=${metricsBefore.sse_connections ?? 'n/a'}`);

    // Open the streams, spread across the users so the per-user cap is
    // respected and the tenant and process caps are the ones under test.
    const errors = [];
    const loadUsers = users.slice(0, userCount);
    for (let index = 0; index < STREAMS; index += 1) {
      const user = loadUsers[index % loadUsers.length];
      const token = await userToken(user.email);
      const reader = new StreamReader();
      readers.push(reader);
      try {
        await reader.open(`${API}/events`, token, TENANT_A);
      } catch (error) {
        errors.push(error.message);
      }
    }
    const opened = readers.length - errors.length;
    if (errors.length) {
      fail('sse-open', `${opened} of ${STREAMS} streams opened; first error: ${errors[0]}`);
    } else {
      ok('sse-open', `${opened} concurrent streams open`);
    }

    const connection = await amqp.connect(env.CSMS_AMQP_URL ?? `amqp://guest:guest@localhost:5672`);
    const channel = await connection.createChannel();
    await channel.assertExchange('messages', 'topic', { durable: true });

    const total = RATE * SECONDS;
    const intervalMs = 1000 / RATE;
    const startedAt = Date.now();
    let published = 0;

    for (let index = 0; index < total; index += 1) {
      const station = stations[index % stations.length];
      const timestamp = new Date(startedAt + index * intervalMs).toISOString();
      const payload = { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp };
      const body = ocppFrame(station.stationRef, 'StatusNotification', payload, timestamp);
      channel.publish(
        'messages',
        'frame.inbound.StatusNotification',
        Buffer.from(JSON.stringify(body)),
      );
      published += 1;
      const due = startedAt + (index + 1) * intervalMs;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const ingestFinishedAt = Date.now();
    await channel.close();
    await connection.close();
    ok('ingest', `${published} frames published at ${RATE}/s over ${SECONDS}s`);

    // Per-station re-read ceiling.
    //
    // Re-reads for one station are serialized, so a single station tops out
    // at roughly one event per re-read. The ceiling is measured on its own,
    // against one station and one stream, so the fan-out cost of many
    // streams does not distort it. The probe raises the publish rate until
    // the re-read queue starts dropping events.
    // Give the pipeline time to drain.
    const drainDeadline = Date.now() + 120_000;
    let metricsAfter = null;
    let drained = false;
    while (Date.now() < drainDeadline) {
      metricsAfter = await readMetrics(API, METRICS_TOKEN);
      const delivered = readers.reduce((total, reader) => total + reader.frames, 0);
      if (delivered >= published * opened) {
        drained = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!drained) {
      const delivered = readers.reduce((total, reader) => total + reader.frames, 0);
      record(`drain_incomplete delivered=${delivered} expected=${published * opened}`);
    }

    const after = apiPid ? processStats(apiPid) : { cpuSeconds: null, rssKb: null };
    const perStream = readers.map((reader) => reader.frames);
    const totalFrames = perStream.reduce((total, count) => total + count, 0);
    const minFrames = perStream.length ? Math.min(...perStream) : 0;
    const maxFrames = perStream.length ? Math.max(...perStream) : 0;
    const meanFrames = perStream.length ? totalFrames / perStream.length : 0;

    const byKind = {};
    for (const reader of readers) {
      for (const [kind, count] of Object.entries(reader.byKind)) {
        byKind[kind] = (byKind[kind] ?? 0) + count;
      }
    }

    const metrics = metricsAfter ?? {};
    const delta = (name) => (metrics[name] ?? 0) - (metricsBefore[name] ?? 0);
    const notified = delta('events_notified');
    const droppedNotVisible = delta('events_dropped_not_visible');
    const droppedQueueFull = delta('events_dropped_queue_full');
    const backpressureCloses = delta('backpressure_closes');
    const resyncs = delta('resyncs');

    record('');
    record('phase2c SSE load — N concurrent streams with steady ingest');
    record(`run ${new Date().toISOString()}`);
    record(`node ${process.version}`);
    record(`platform ${process.platform} ${process.arch}`);
    record(`cpus ${os.cpus().length} x ${os.cpus()[0]?.model ?? 'unknown'}`);
    record(`total_memory_bytes ${os.totalmem()}`);
    record(`api_pid ${apiPid ?? 'unknown'}`);
    record(`target_streams ${STREAMS}`);
    record(`streams_opened ${opened}`);
    record(`streams_per_user_limit ${STREAMS_PER_USER}`);
    record(`load_users ${users.length}`);
    record(`stations ${STATIONS}`);
    record(`ingest_rate_target ${RATE}/s`);
    record(`ingest_duration_s ${SECONDS}`);
    record(`frames_published ${published}`);
    record(`ingest_wall_ms ${ingestFinishedAt - startedAt}`);
    record('');
    record('delivery');
    record(`sse_frames_received_total ${totalFrames}`);
    record(`sse_frames_per_stream_min ${minFrames}`);
    record(`sse_frames_per_stream_mean ${meanFrames.toFixed(2)}`);
    record(`sse_frames_per_stream_max ${maxFrames}`);
    record(`sse_frames_by_kind ${JSON.stringify(byKind)}`);
    record('');
    record('api');
    record(`api_cpu_seconds ${before.cpuSeconds} -> ${after.cpuSeconds}`);
    record(
      `api_cpu_seconds_delta ${
        before.cpuSeconds !== null && after.cpuSeconds !== null
          ? (after.cpuSeconds - before.cpuSeconds).toFixed(2)
          : 'unknown'
      }`,
    );
    record(`api_rss_kb ${before.rssKb} -> ${after.rssKb}`);
    record(
      `api_rss_kb_delta ${
        before.rssKb !== null && after.rssKb !== null ? after.rssKb - before.rssKb : 'unknown'
      }`,
    );
    record('');
    record('metrics (delta over the run)');
    record(`events_notified ${notified}`);
    record(`events_dropped_not_visible ${droppedNotVisible}`);
    record(`events_dropped_queue_full ${droppedQueueFull}`);
    record(`backpressure_closes ${backpressureCloses}`);
    record(`resyncs ${resyncs}`);
    record(`reread_p50_ms ${metrics.reread_p50_ms}`);
    record(`reread_p95_ms ${metrics.reread_p95_ms}`);
    record(`notification_queue_usage ${metrics.notification_queue_usage}`);
    record(`sse_connections_final ${metrics.sse_connections}`);
    record('');
    record('derived');
    record(
      `events_notified_per_published ${published ? (notified / published).toFixed(3) : 'unknown'}`,
    );
    record(`fan_out_per_event ${notified ? (totalFrames / notified).toFixed(1) : 'unknown'}`);
    record('re_reads_per_event 1 (one RLS re-read per NOTIFY; the payload carries ids only)');
    record(
      `stations_used_for_this_run ${STATIONS} (per-station re-reads are serialized; total throughput scales with distinct stations)`,
    );
    record('per_station_ceiling see the measured per-station re-read ceiling section below');

    // The ceiling probe deliberately overruns one station, so it runs after
    // the main counters have been read; otherwise its drops would be
    // counted against the load run above.
    const ceiling = await probePerStationCeiling(
      API,
      METRICS_TOKEN,
      await userToken(probeUser.email),
      TENANT_A,
      stations,
    );
    record('');
    record('per-station re-read ceiling (one station, one stream)');
    record(`ceiling_station ${ceiling.stationRef}`);
    for (const step of ceiling.steps) {
      record(
        `  rate ${step.rate}/s published ${step.published} notified ${step.notified} dropped_queue_full ${step.droppedQueueFull}`,
      );
    }
    record(`ceiling_events_per_second ${ceiling.ceiling ?? 'not reached'}`);
    record(`ceiling_note ${ceiling.note}`);

    for (const reader of readers) reader.close();

    if (opened !== STREAMS) {
      fail('sse-open', `expected ${STREAMS} streams, opened ${opened}`);
    }
    if (minFrames === 0) {
      fail('delivery', 'at least one stream received no frames');
    } else {
      ok(
        'delivery',
        `every stream received frames (min ${minFrames}, mean ${meanFrames.toFixed(0)})`,
      );
    }
    if (droppedQueueFull > 0) {
      fail('queue-full', `${droppedQueueFull} events dropped because the re-read queue was full`);
    } else {
      ok('queue-full', 'no events dropped for a full re-read queue');
    }
    if (backpressureCloses > 0) {
      fail('backpressure', `${backpressureCloses} streams closed for backpressure`);
    } else {
      ok('backpressure', 'no stream closed for backpressure');
    }
    if (droppedNotVisible > 0) {
      fail('dropped-not-visible', `${droppedNotVisible} events dropped as not visible`);
    } else {
      ok('dropped-not-visible', 'no event dropped as not visible');
    }
    if (metrics.sse_connections !== undefined && metrics.sse_connections !== opened) {
      fail(
        'connections-metric',
        `metrics report ${metrics.sse_connections} connections, ${opened} were opened`,
      );
    } else {
      ok('connections-metric', `metrics report ${metrics.sse_connections} connections`);
    }

    fs.writeFileSync(LOG_PATH, `${log.join('\n')}\n`);
    console.log(`evidence written to ${LOG_PATH}`);
  } finally {
    for (const reader of readers) reader.close();
    await removeProvisioning(adminToken);
    await stopChildren();
  }

  if (problems.length) {
    console.error(`phase2c-load: FAIL (${problems.length})`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('phase2c-load: PASS');
}

main().catch((error) => {
  console.error('phase2c-load: FAIL');
  console.error(error);
  process.exitCode = 1;
});
