#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(repoRoot, 'infra/compose/.env');
const vars = {};
for (const line of fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : []) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) vars[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

const password = process.env.OUR_AMQP_WORKER_PASSWORD ?? vars.OUR_AMQP_WORKER_PASSWORD;
const monitorPassword = process.env.OUR_AMQP_MONITOR_PASSWORD ?? vars.OUR_AMQP_MONITOR_PASSWORD;
if (!password) throw new Error('OUR_AMQP_WORKER_PASSWORD missing in infra/compose/.env');
if (!monitorPassword) throw new Error('OUR_AMQP_MONITOR_PASSWORD missing in infra/compose/.env');
const base = process.env.RABBITMQ_MGMT_URL ?? 'http://127.0.0.1:15672/api';
const auth = Buffer.from(
  `${process.env.RABBITMQ_ADMIN_USER ?? 'guest'}:${process.env.RABBITMQ_ADMIN_PASS ?? 'guest'}`,
).toString('base64');

async function call(method, endpoint, body) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`RabbitMQ ${method} ${endpoint} failed: HTTP ${response.status}`);
  }
  return response;
}

const vhost = encodeURIComponent('/');
await call('PUT', `/users/evstation_worker`, { password, tags: '' });
await call('PUT', `/permissions/${vhost}/evstation_worker`, {
  configure: '^$',
  write: '^$',
  read: '^evstation\\.ingest$',
});
await call('PUT', `/users/evstation_monitor`, { password: monitorPassword, tags: 'monitoring' });
await call('PUT', `/permissions/${vhost}/evstation_monitor`, {
  configure: '^$',
  write: '^$',
  read: '^evstation\\.ingest$',
});
await call('PUT', `/exchanges/${vhost}/messages`, {
  type: 'topic',
  durable: true,
  auto_delete: false,
  internal: false,
  arguments: {},
});
await call('PUT', `/exchanges/${vhost}/evstation.ingest.dlx`, {
  type: 'topic',
  durable: true,
  auto_delete: false,
  internal: false,
  arguments: {},
});
await call('PUT', `/queues/${vhost}/evstation.ingest`, {
  durable: true,
  auto_delete: false,
  arguments: {
    'x-dead-letter-exchange': 'evstation.ingest.dlx',
    'x-max-length-bytes': 5368709120,
    'x-overflow': 'reject-publish',
  },
});
await call('PUT', `/queues/${vhost}/evstation.ingest.retry`, {
  durable: true,
  auto_delete: false,
  arguments: {
    'x-message-ttl': 30000,
    'x-dead-letter-exchange': '',
    'x-dead-letter-routing-key': 'evstation.ingest',
  },
});
const frameKeys = [
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
for (const key of frameKeys) {
  await call('POST', `/bindings/${vhost}/e/messages/q/evstation.ingest`, {
    routing_key: key,
    arguments: {},
  });
}
await call('POST', `/bindings/${vhost}/e/evstation.ingest.dlx/q/evstation.ingest.retry`, {
  routing_key: '#',
  arguments: {},
});
console.log('provision-amqp: evstation.ingest + retry queue and worker permissions ready');
