#!/usr/bin/env node
/**
 * Phase 2c live-latency evidence.
 *
 * Drives a real OCPP 1.6J session through the full live path and measures
 * how long an event takes to reach an `/events` client:
 *
 *   simulator -> CitrineOS -> AMQP -> worker -> Postgres -> NOTIFY
 *             -> API LISTEN -> RLS re-read -> fan-out -> SSE client
 *
 * The script starts the API and the worker itself, registers a station
 * through `POST /stations`, opens an `/events` stream as that station's
 * tenant, and runs the simulator against the real CitrineOS stack.
 *
 * Latency is measured per event: the wall-clock time at which the
 * simulator sent the OCPP frame (captured from its stdout as it is
 * written) to the wall-clock time at which the SSE client parsed the
 * matching event. Frames are paired in order, because the simulator
 * truncates its OCPP payload timestamps to whole seconds and several
 * frames therefore share one timestamp.
 *
 *   node tools/phase2c-latency.mjs
 *
 * Environment:
 *   PHASE2C_LATENCY_EVENTS   status events to expect (default 5)
 *   PHASE2C_LATENCY_LOG      evidence log path
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
const requireValue = (name) => {
  const current = value(name);
  if (!current) throw new Error(`${name} missing in infra/compose/.env`);
  return current;
};

const KC_PORT = value('KEYCLOAK_HTTP_HOST_PORT', '8180');
const KC = `http://127.0.0.1:${KC_PORT}`;
const API_PORT = value('PHASE2C_LATENCY_API_PORT', '4020');
const API = `http://127.0.0.1:${API_PORT}`;
const WORKER_HEALTH_PORT = value('PHASE2C_LATENCY_WORKER_HEALTH_PORT', '4130');
const TENANT_A = '10000000-0000-4000-8000-000000000001';
const SITE_A = '20000000-0000-4000-8000-000000000001';
const E2E_PASSWORD = value('E2E_USER_PASSWORD', 'evstation-dev-password');
const RUN = String(Date.now()).slice(-6);
// station_ref must be ORG-SITE-NNN and bind to the seeded tenant and site codes.
const STATION_A = `ACME-BLR-${RUN.slice(-3)}`;
const STATUS_EVENTS = Number(value('PHASE2C_LATENCY_EVENTS', '5'));
const LOG_PATH = value(
  'PHASE2C_LATENCY_LOG',
  path.join(repoRoot, 'docs/evidence/phase2c-live-latency.log'),
);

const children = [];
let stopping = false;
const problems = [];

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
    METRICS_TOKEN: value('METRICS_TOKEN', 'test-metrics-token'),
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

/** Reads an SSE stream and records the arrival time of every event frame. */
class EventCollector {
  constructor() {
    this.frames = [];
    this.controller = new AbortController();
  }

  async open(url, token, tenantId) {
    this.response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
        accept: 'text/event-stream',
      },
      signal: this.controller.signal,
    });
    if (this.response.status !== 200) {
      throw new Error(`/events returned ${this.response.status}`);
    }
    void this.pump();
  }

  async pump() {
    const reader = this.response.body.getReader();
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
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          let parsed;
          try {
            parsed = JSON.parse(data.join('\n'));
          } catch {
            continue;
          }
          this.frames.push({ name, data: parsed, receivedAt: Date.now() });
        }
      }
    } catch {
      /* aborted */
    }
  }

  close() {
    this.controller.abort();
  }
}

/**
 * Runs the simulator and records the wall-clock time at which each OCPP
 * frame was sent. The simulator prints the frame it is about to send, so
 * the timestamp of the printed line is the send time.
 */
function runSimulator(args) {
  return new Promise((resolve, reject) => {
    // The simulator prints the frame it is about to send. Unbuffered stdout
    // makes each line land here at send time rather than at process exit.
    const child = spawn(args.python, args.argv, {
      cwd: repoRoot,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    const frames = [];
    let stdout = '';
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const match = line.match(/^--> (\[[^\n]*\])$/);
        if (match) {
          try {
            const frame = JSON.parse(match[1]);
            frames.push({ action: frame[2], payload: frame[3], sentAt: Date.now() });
          } catch {
            /* not a frame */
          }
        }
        index = buffer.indexOf('\n');
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, frames });
    });
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Pairs the frames the simulator sent with the events the SSE client
 * received. Both sides are ordered per station, so the n-th status frame
 * sent matches the n-th status event received. The pair is only accepted
 * when both sides report the same status, so a mis-pairing is caught
 * rather than silently measured.
 */
function correlate(sentFrames, receivedFrames) {
  const samples = [];
  let index = 0;
  for (const received of receivedFrames) {
    const sent = sentFrames[index];
    if (!sent) break;
    index += 1;
    const sentStatus = String(sent.payload?.status ?? '').toLowerCase();
    const receivedStatus = String(received.data?.status ?? '').toLowerCase();
    samples.push({
      kind: received.name,
      action: sent.action,
      status: sent.payload?.status ?? null,
      matched: sentStatus === '' || sentStatus === receivedStatus,
      latencyMs: received.receivedAt - sent.sentAt,
    });
  }
  return samples;
}

async function main() {
  const log = [];
  const record = (line) => {
    log.push(line);
    console.log(line);
  };

  const adminToken = await keycloakAdminToken();
  await ensureSmokeClient(adminToken);
  const token = await userToken('admin@acme.example');
  ok('keycloak', 'tenant A admin token issued');

  const apiLog = `/tmp/evstation-phase2c-latency-api-${RUN}.log`;
  const workerLog = `/tmp/evstation-phase2c-latency-worker-${RUN}.log`;
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

    const registration = await request(`${API}/stations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': TENANT_A,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        site_id: SITE_A,
        station_ref: STATION_A,
        latitude: 12.9716,
        longitude: 77.5946,
        connectors: [{ connector_number: 1 }],
      }),
    });
    if (registration.response.status !== 201 || !registration.body?.credentials?.password) {
      throw new Error(
        `POST /stations failed: HTTP ${registration.response.status} ${JSON.stringify(registration.body).slice(0, 300)}`,
      );
    }
    const stationId = registration.body.station.id;
    ok('api-register', `${STATION_A} station#${stationId}`);

    const collector = new EventCollector();
    await collector.open(`${API}/events`, token, TENANT_A);
    ok('sse-open', 'tenant A /events stream open');

    const py = value('SIM_PYTHON', path.join(repoRoot, '.venv/bin/python'));
    const simulator = await runSimulator({
      python: py,
      argv: [
        path.join(repoRoot, 'tools/simulator/charger_simulator.py'),
        '--url',
        'ws://localhost:8082',
        '--id',
        STATION_A,
        '--password',
        registration.body.credentials.password,
        '--exit-after-session',
      ],
    });
    if (simulator.code !== 0) {
      throw new Error(`simulator failed exit=${simulator.code}: ${simulator.stderr}`);
    }
    ok('simulator', '8082 Basic auth session completed');

    const sent = simulator.frames.filter((frame) => frame.action === 'StatusNotification');
    record(`simulator_status_frames_sent ${sent.length}`);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const statuses = collector.frames.filter((frame) => frame.name === 'station.status');
      if (statuses.length >= sent.length && sent.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    collector.close();
    const received = collector.frames.filter((frame) => frame.name === 'station.status');
    const samples = correlate(sent, received);
    const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);

    const byKind = {};
    for (const frame of collector.frames) byKind[frame.name] = (byKind[frame.name] ?? 0) + 1;

    record('');
    record('phase2c live latency — simulator -> worker -> NOTIFY -> /events client');
    record(`run ${new Date().toISOString()}`);
    record(`station ${STATION_A} (${stationId})`);
    record(`tenant ${TENANT_A}`);
    record(`node ${process.version}`);
    record(`platform ${process.platform} ${process.arch}`);
    record(`cpus ${os.cpus().length} x ${os.cpus()[0]?.model ?? 'unknown'}`);
    record(`total_memory_bytes ${os.totalmem()}`);
    record(`sse_frames_received ${collector.frames.length}`);
    record(`sse_frames_by_kind ${JSON.stringify(byKind)}`);
    record(`status_frames_sent ${sent.length}`);
    record(`status_frames_received ${received.length}`);
    record(`latency_samples ${samples.length}`);
    if (latencies.length) {
      record(`latency_ms_min ${latencies[0]}`);
      record(`latency_ms_p50 ${percentile(latencies, 0.5)}`);
      record(`latency_ms_p95 ${percentile(latencies, 0.95)}`);
      record(`latency_ms_max ${latencies[latencies.length - 1]}`);
    }
    record('');
    record('per-sample latency (ms from the OCPP frame being sent to the SSE client):');
    for (const sample of samples) {
      record(`  ${sample.kind} ${sample.status ?? '-'} ${sample.latencyMs}`);
    }

    if (samples.length === 0) {
      fail('latency-samples', 'no SSE event could be paired with a simulator frame');
    } else {
      ok('latency-samples', `${samples.length} paired events`);
    }
    const mismatched = samples.filter((sample) => !sample.matched);
    if (mismatched.length) {
      fail(
        'latency-pairing',
        `${mismatched.length} pairs had a different status on each side, so they cannot be the same event`,
      );
    } else if (samples.length) {
      ok('latency-pairing', 'every pair reported the same status on both sides');
    }
    if (received.length < STATUS_EVENTS) {
      fail(
        'sse-status',
        `expected at least ${STATUS_EVENTS} station.status frames, got ${received.length}`,
      );
    } else {
      ok('sse-status', `${received.length} station.status frames delivered`);
    }
    const negative = samples.filter((sample) => sample.latencyMs < 0);
    if (negative.length) {
      fail(
        'latency-nonnegative',
        `${negative.length} samples were measured before their frame was sent`,
      );
    }

    fs.writeFileSync(LOG_PATH, `${log.join('\n')}\n`);
    console.log(`evidence written to ${LOG_PATH}`);
  } finally {
    await stopChildren();
  }

  if (problems.length) {
    console.error(`phase2c-latency: FAIL (${problems.length})`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('phase2c-latency: PASS');
}

main().catch((error) => {
  console.error('phase2c-latency: FAIL');
  console.error(error);
  process.exitCode = 1;
});
