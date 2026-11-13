#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
const port = env.OUR_DB_HOST_PORT ?? '5432';
const databaseUrl = `postgres://evstation:${encodeURIComponent(env.OUR_DB_PASSWORD)}@localhost:${port}/evstation`;
const mgmt = env.RABBITMQ_MGMT_URL ?? 'http://127.0.0.1:15672/api';
const mgmtAuth = `Basic ${Buffer.from('guest:guest').toString('base64')}`;
const healthPort = process.env.PHASE2B_BENCH_HEALTH_PORT ?? '4120';
const targetRate = Number(process.env.PHASE2B_BENCH_RATE ?? '200');
const seconds = Number(process.env.PHASE2B_BENCH_SECONDS ?? '60');
const total = targetRate * seconds;
const run = String(Date.now()).slice(-3);
const stationRef = `ACME-BLR-${run}`;
const children = [];
let workerPid = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queueDepth() {
  const response = await fetch(`${mgmt}/queues/%2F/evstation.ingest`, {
    headers: { authorization: mgmtAuth, connection: 'close' },
  });
  if (!response.ok) return null;
  const body = await response.json();
  return typeof body.messages === 'number' ? body.messages : null;
}

function findWorkerPid() {
  try {
    const out = execFileSync('ss', ['-ltnp', `sport = :${healthPort}`], {
      encoding: 'utf8',
    });
    const match = out.match(/pid=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function setupDatabase() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const scope = await client.query(
      `SELECT t.id AS tenant_id, t.org_code, s.id AS site_id
       FROM app.tenants t JOIN app.sites s ON s.tenant_id=t.id
       WHERE t.slug='acme' ORDER BY s.created_at LIMIT 1`,
    );
    const row = scope.rows[0];
    if (!row) throw new Error('seed tenant/site missing');
    const station = await client.query(
      `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref, registration_status)
       VALUES ($1, $2, $3, $4, 'registered')
       ON CONFLICT (station_ref) DO UPDATE SET updated_at=now() RETURNING id`,
      [row.tenant_id, row.site_id, row.org_code, stationRef],
    );
    const stationId = station.rows[0].id;
    await client.query(
      `INSERT INTO app.connectors (tenant_id, site_id, station_id, connector_number)
       VALUES ($1, $2, $3, 1) ON CONFLICT (station_id, connector_number) DO NOTHING`,
      [row.tenant_id, row.site_id, stationId],
    );
    return { stationId, tenantId: row.tenant_id, siteId: row.site_id };
  } finally {
    await client.end();
  }
}

function startWorker() {
  const log = fs.openSync('/tmp/evstation-phase2b-benchmark-worker.log', 'w');
  const child = spawn('pnpm', ['--filter', '@evstation/worker', 'start'], {
    cwd: repoRoot,
    env: { ...process.env, ...env, WORKER_HEALTH_PORT: healthPort },
    stdio: ['ignore', log, log],
    detached: true,
  });
  children.push(child);
  return child;
}

async function waitWorker() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${healthPort}/healthz`);
      if (response.ok || response.status === 503) {
        workerPid = findWorkerPid();
        return;
      }
    } catch {
      /* starting */
    }
    await sleep(500);
  }
  throw new Error('worker did not start');
}

function timestamp(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function frameBody(action, correlationId, payload, direction = 'inbound') {
  return {
    kind: 'frame',
    tenantId: 1,
    ocppConnectionName: stationRef,
    direction,
    correlationId,
    origin: direction === 'inbound' ? 'cs' : 'csms',
    type: direction === 'inbound' ? 2 : 3,
    action,
    protocol: 'ocpp1.6',
    payload,
    timestamp: timestamp(),
  };
}

async function publish(channel) {
  const tx = 1000;
  await channel.publish(
    'messages',
    'connection.connected',
    Buffer.from(
      JSON.stringify({
        kind: 'connection',
        tenantId: 1,
        ocppConnectionName: stationRef,
        state: 'connected',
        timestamp: timestamp(),
        protocol: 'ocpp1.6',
      }),
    ),
    { contentType: 'application/json' },
  );
  await channel.publish(
    'messages',
    'frame.inbound.BootNotification',
    Buffer.from(
      JSON.stringify(
        frameBody('BootNotification', crypto.randomUUID(), {
          chargePointVendor: 'Bench',
          chargePointModel: 'Bench',
          chargePointSerialNumber: stationRef,
          firmwareVersion: '1',
        }),
      ),
    ),
    { contentType: 'application/json' },
  );
  await channel.publish(
    'messages',
    'frame.inbound.StartTransaction',
    Buffer.from(
      JSON.stringify(
        frameBody('StartTransaction', 'bench-corr', {
          connectorId: 1,
          idTag: 'BENCH',
          meterStart: 0,
          timestamp: timestamp(),
        }),
      ),
    ),
    { contentType: 'application/json' },
  );
  await channel.publish(
    'messages',
    'frame.outbound.StartTransaction',
    Buffer.from(
      JSON.stringify(
        frameBody(
          'StartTransaction',
          'bench-corr',
          { transactionId: tx, idTagInfo: { status: 'Accepted' } },
          'outbound',
        ),
      ),
    ),
    { contentType: 'application/json' },
  );

  const started = Date.now();
  for (let index = 0; index < total; index += 1) {
    const pick = index % 100;
    let routingKey;
    let body;
    if (pick === 0) {
      routingKey = 'frame.inbound.StatusNotification';
      body = frameBody('StatusNotification', crypto.randomUUID(), {
        connectorId: 1,
        errorCode: 'NoError',
        status: 'Charging',
        timestamp: timestamp(),
      });
    } else if (pick === 1 || pick === 2 || pick === 3) {
      routingKey = 'frame.inbound.MeterValues';
      body = frameBody('MeterValues', crypto.randomUUID(), {
        connectorId: 1,
        transactionId: tx,
        meterValue: [
          {
            timestamp: timestamp(),
            sampledValue: [
              {
                value: String(1000 + index),
                measurand: 'Energy.Active.Import.Register',
                unit: 'Wh',
              },
              { value: '30000', measurand: 'Power.Active.Import', unit: 'W' },
            ],
          },
        ],
      });
    } else if (pick === 4) {
      routingKey = 'frame.inbound.StatusNotification';
      body = frameBody('StatusNotification', crypto.randomUUID(), {
        connectorId: 1,
        errorCode: 'NoError',
        status: 'Available',
        timestamp: timestamp(),
      });
    } else {
      routingKey = 'frame.inbound.Heartbeat';
      body = frameBody('Heartbeat', crypto.randomUUID(), {});
    }
    await channel.publish('messages', routingKey, Buffer.from(JSON.stringify(body)), {
      contentType: 'application/json',
    });
    const target = started + ((index + 1) * 1000) / targetRate;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
  }
  await channel.publish(
    'messages',
    'frame.inbound.StopTransaction',
    Buffer.from(
      JSON.stringify(
        frameBody('StopTransaction', crypto.randomUUID(), {
          transactionId: tx,
          idTag: 'BENCH',
          meterStop: 2000,
          timestamp: timestamp(),
          reason: 'Local',
        }),
      ),
    ),
    { contentType: 'application/json' },
  );
  await channel.publish(
    'messages',
    'connection.closed',
    Buffer.from(
      JSON.stringify({
        kind: 'connection',
        tenantId: 1,
        ocppConnectionName: stationRef,
        state: 'closed',
        timestamp: timestamp(),
      }),
    ),
    { contentType: 'application/json' },
  );
  return Date.now() - started;
}

async function metrics() {
  const response = await fetch(`http://127.0.0.1:${healthPort}/metrics`);
  const text = await response.text();
  const read = (name) => Number((text.match(new RegExp(`${name} (\\S+)`)) ?? [])[1]);
  return {
    received: read('evstation_worker_events_received_total'),
    p50: read('evstation_worker_event_duration_p50_ms'),
    p95: read('evstation_worker_event_duration_p95_ms'),
    depthAvailable: read('evstation_worker_queue_depth_available'),
  };
}

function cpuPercent(pid) {
  if (!pid) return null;
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', '%cpu='], { encoding: 'utf8' });
    return Number(value.trim());
  } catch {
    return null;
  }
}

async function main() {
  const fixture = await setupDatabase();
  const worker = startWorker();
  await waitWorker();
  const connection = await amqp.connect(env.CSMS_AMQP_URL ?? `amqp://guest:guest@localhost:5672`);
  const channel = await connection.createChannel();
  const depthSamples = [];
  const sampler = setInterval(() => {
    void queueDepth().then((depth) => {
      if (depth !== null) depthSamples.push(depth);
    });
  }, 1000);
  try {
    const publishMs = await publish(channel);
    const drainStarted = Date.now();
    const publishDeadline = Date.now() + 300_000;
    let depth = await queueDepth();
    while (depth !== null && depth > 0 && Date.now() < publishDeadline) {
      await sleep(500);
      depth = await queueDepth();
    }
    clearInterval(sampler);
    await sleep(1000);
    const workerMetrics = await metrics();
    const drainMs = Date.now() - drainStarted;
    const throughput = total / ((publishMs + drainMs) / 1000);
    console.log(
      JSON.stringify(
        {
          stationRef,
          stationId: fixture.stationId,
          requested_messages: total,
          target_rate_per_second: targetRate,
          publish_seconds: publishMs / 1000,
          drain_seconds: drainMs / 1000,
          final_queue_depth: depth,
          max_queue_depth: depthSamples.length ? Math.max(...depthSamples) : null,
          worker_received: workerMetrics.received,
          p50_ms: workerMetrics.p50,
          p95_ms: workerMetrics.p95,
          queue_depth_available: workerMetrics.depthAvailable,
          worker_cpu_percent: cpuPercent(workerPid),
          approximate_throughput_per_second: Number.isFinite(throughput)
            ? Number(throughput.toFixed(1))
            : null,
        },
        null,
        2,
      ),
    );
  } finally {
    clearInterval(sampler);
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
    if (worker.pid) {
      try {
        process.kill(-worker.pid, 'SIGTERM');
      } catch {
        worker.kill('SIGTERM');
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
