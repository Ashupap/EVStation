#!/usr/bin/env node
// Quick Phase 0 health check of the dev stack (`pnpm health`).
// Independent of compose healthchecks: plain TCP/HTTP probes with hard
// timeouts. Prints one PASS/FAIL line per service; `--json` emits a single
// JSON object instead. Exits non-zero if anything fails. Never prints
// secret values (the RabbitMQ probe uses the documented dev-only guest
// account, never anything from .env).

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(repoRoot, 'infra/compose/.env');

function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // .env missing → fall back to the documented defaults; `pnpm dev:stack`
    // would have failed before this script became useful.
  }
  return out;
}

const env = readEnv();
const citrineHttpHostPort = env.CITRINE_HTTP_HOST_PORT ?? '8088';
const ourDbHostPort = env.OUR_DB_HOST_PORT ?? '5432';
const keycloakHttpHostPort = env.KEYCLOAK_HTTP_HOST_PORT ?? '8180';
const keycloakMgmtHostPort = env.KEYCLOAK_MGMT_HOST_PORT ?? '8181';

const TIMEOUT_MS = 7000;

function tcpProbe(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, host, () => {
      socket.destroy();
      resolve(`TCP ${host}:${port} connected`);
    });
    socket.setTimeout(TIMEOUT_MS, () =>
      socket.destroy(new Error(`connect timeout after ${TIMEOUT_MS}ms (${host}:${port})`)),
    );
    socket.on('error', (err) => reject(new Error(String(err?.message ?? err))));
  });
}

async function httpProbe(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res;
}

const results = {};

async function record(name, probe) {
  try {
    results[name] = { status: 'pass', detail: String(await probe()) };
  } catch (err) {
    results[name] = { status: 'fail', detail: String(err?.message ?? err) };
  }
}

await Promise.all([
  record('our-db', () => tcpProbe(ourDbHostPort)),
  record('ocpp-db', () => tcpProbe('15432')),
  record('rabbitmq', async () => {
    const tcp = await tcpProbe('5672');
    const res = await httpProbe('http://127.0.0.1:15672/api/overview', {
      headers: { Authorization: `Basic ${Buffer.from('guest:guest').toString('base64')}` },
    });
    const version = (await res.json())?.rabbitmq_version ?? 'unknown';
    return `${tcp}; management API 200 (rabbitmq_version=${version})`;
  }),
  record('citrineos-http', async () => {
    await httpProbe(`http://127.0.0.1:${citrineHttpHostPort}/docs`);
    return `/docs -> 200 (${citrineHttpHostPort})`;
  }),
  record('citrineos-ocpp-ws', () => tcpProbe('8081')),
  record('hasura', async () => {
    const res = await httpProbe('http://127.0.0.1:8090/healthz');
    return `healthz 200 (${(await res.text()).trim() || 'ok'})`;
  }),
  record('keycloak', async () => {
    const disco = await (
      await httpProbe(
        `http://127.0.0.1:${keycloakHttpHostPort}/realms/evstation/.well-known/openid-configuration`,
      )
    ).json();
    const health = await (
      await httpProbe(`http://127.0.0.1:${keycloakMgmtHostPort}/health`)
    ).json();
    return `issuer ${disco.issuer}; management /health ${health.status}`;
  }),
]);

const names = Object.keys(results).sort();
const failed = names.filter((n) => results[n].status === 'fail');

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      { overall: failed.length === 0 ? 'pass' : 'fail', failing: failed, checks: results },
      null,
      2,
    ),
  );
} else {
  console.log(
    'health: 7 checks (env: infra/compose/.env). The port pre-check itself runs via `pnpm dev:stack`.',
  );
  for (const name of names) {
    const r = results[name];
    console.log(`${r.status === 'pass' ? 'ok  ' : 'FAIL'} ${name} — ${r.detail}`);
  }
  console.log(
    failed.length === 0 ? 'health: all good (exit 0)' : `health: ${failed.length} failing (exit 1)`,
  );
}
process.exitCode = failed.length === 0 ? 0 : 1;
