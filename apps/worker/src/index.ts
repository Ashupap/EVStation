import http from 'node:http';
import pg from 'pg';
import { subscribeAmqpEvents } from '@evstation/csms-adapter';
import { loadWorkerConfig } from './config.js';
import { handleEvent, handleFailure } from './ingest.js';
import { runJobs } from './jobs.js';

const config = loadWorkerConfig();
const ingestPool = new pg.Pool({ connectionString: config.ingestDatabaseUrl, max: 10 });
const jobsPool = new pg.Pool({ connectionString: config.jobsDatabaseUrl, max: 2 });

let lastEventAt: string | null = null;
let lastError: string | null = null;
let stopping = false;
let amqpConnected = false;
let exitTimer: NodeJS.Timeout | null = null;
const latencies: number[] = [];
const counters = {
  received: 0,
  acked: 0,
  retried: 0,
  parked: 0,
  errors: 0,
};

async function queueDepth(): Promise<number | null> {
  try {
    const auth = Buffer.from(`${config.rabbitmqUser}:${config.rabbitmqPassword}`).toString(
      'base64',
    );
    const response = await fetch(
      `${config.amqpManagementUrl}/queues/%2F/${encodeURIComponent(config.queue)}`,
      { headers: { authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { messages?: number };
    return typeof body.messages === 'number' ? body.messages : null;
  } catch {
    return null;
  }
}

const health = http.createServer(async (request, response) => {
  if (request.url === '/metrics') {
    const depth = await queueDepth();
    const sorted = [...latencies].sort((a, b) => a - b);
    const quantile = (q: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : NaN;
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    response.end(
      [
        '# HELP evstation_worker_events_total Events handled by disposition.',
        '# TYPE evstation_worker_events_total counter',
        `evstation_worker_events_received_total ${counters.received}`,
        `evstation_worker_events_acked_total ${counters.acked}`,
        `evstation_worker_events_retried_total ${counters.retried}`,
        `evstation_worker_events_parked_total ${counters.parked}`,
        `evstation_worker_events_errors_total ${counters.errors}`,
        '# HELP evstation_worker_consumer_lag Messages ready in the ingest queue.',
        '# TYPE evstation_worker_consumer_lag gauge',
        `evstation_worker_consumer_lag ${depth === null ? 'NaN' : depth}`,
        `evstation_worker_queue_depth_available ${depth === null ? 0 : 1}`,
        `evstation_worker_queue_depth_high ${depth !== null && depth > config.queueDepthAlertThreshold ? 1 : 0}`,
        '# HELP evstation_worker_event_duration_ms Event handler latency.',
        '# TYPE evstation_worker_event_duration_ms gauge',
        `evstation_worker_event_duration_p50_ms ${quantile(0.5)}`,
        `evstation_worker_event_duration_p95_ms ${quantile(0.95)}`,
        '',
      ].join('\n'),
    );
    return;
  }
  if (request.url !== '/healthz') {
    response.writeHead(404).end();
    return;
  }
  const healthy = !stopping && lastError === null && amqpConnected;
  response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      ok: healthy,
      queue: config.queue,
      amqp_connected: amqpConnected,
      last_event_at: lastEventAt,
      last_error: lastError,
    }),
  );
});

async function main(): Promise<void> {
  health.listen(config.healthPort, '127.0.0.1');
  const subscription = await subscribeAmqpEvents(
    {
      amqpUrl: config.amqpUrl,
      queue: config.queue,
      onState: (state, error) => {
        amqpConnected = state === 'connected';
        if (state === 'error' || (state === 'closed' && !stopping)) {
          lastError = error?.message ?? 'AMQP connection closed';
          console.error('worker_amqp_state', { state, error: lastError });
          if (!stopping && exitTimer === null) {
            process.exitCode = 1;
            exitTimer = setTimeout(() => process.exit(1), 1_000);
            exitTimer.unref();
          }
        }
      },
    },
    async (event) => {
      counters.received += 1;
      const started = performance.now();
      try {
        const result = await handleEvent(event, ingestPool, config.maxRetries);
        latencies.push(performance.now() - started);
        if (latencies.length > 10_000) latencies.shift();
        if (result === 'ack') counters.acked += 1;
        else counters.retried += 1;
        lastEventAt = new Date().toISOString();
        lastError = null;
        return result;
      } catch (error) {
        counters.errors += 1;
        latencies.push(performance.now() - started);
        if (latencies.length > 10_000) latencies.shift();
        lastError = error instanceof Error ? error.message : String(error);
        console.error('worker_event_failed', { routingKey: event.routingKey, error: lastError });
        try {
          const result = await handleFailure(event, ingestPool, config.maxRetries);
          if (result === 'ack') {
            counters.parked += 1;
            counters.acked += 1;
          } else {
            counters.retried += 1;
          }
          return result;
        } catch (failureError) {
          lastError = failureError instanceof Error ? failureError.message : String(failureError);
          throw failureError;
        }
      }
    },
  );
  amqpConnected = true;
  console.log('worker_started', { queue: config.queue, healthPort: config.healthPort });

  const timer = setInterval(() => {
    void runJobs(jobsPool, config).catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      console.error('worker_jobs_failed', { error: lastError });
    });
  }, config.jobIntervalMs);
  void runJobs(jobsPool, config).catch((error) => {
    lastError = error instanceof Error ? error.message : String(error);
    console.error('worker_jobs_failed', { error: lastError });
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log('worker_stopping', { signal });
    clearInterval(timer);
    health.close();
    await subscription.close();
    await ingestPool.end();
    await jobsPool.end();
  };
  process.once(
    'SIGINT',
    () => void shutdown('SIGINT').then(() => process.exit(process.exitCode ?? 0)),
  );
  process.once(
    'SIGTERM',
    () => void shutdown('SIGTERM').then(() => process.exit(process.exitCode ?? 0)),
  );
}

main().catch(async (error) => {
  console.error('worker_failed', { error: error instanceof Error ? error.message : String(error) });
  await ingestPool.end().catch(() => undefined);
  await jobsPool.end().catch(() => undefined);
  process.exit(1);
});
