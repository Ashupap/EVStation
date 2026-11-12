import http from 'node:http';
import pg from 'pg';
import { subscribeAmqpEvents } from '@evstation/csms-adapter';
import { loadWorkerConfig } from './config.js';
import { handleEvent } from './ingest.js';
import { runJobs } from './jobs.js';

const config = loadWorkerConfig();
const ingestPool = new pg.Pool({ connectionString: config.ingestDatabaseUrl, max: 10 });
const jobsPool = new pg.Pool({ connectionString: config.jobsDatabaseUrl, max: 2 });

let lastEventAt: string | null = null;
let lastError: string | null = null;
let stopping = false;

const health = http.createServer((request, response) => {
  if (request.url !== '/healthz') {
    response.writeHead(404).end();
    return;
  }
  const healthy = !stopping && lastError === null;
  response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      ok: healthy,
      queue: config.queue,
      last_event_at: lastEventAt,
      last_error: lastError,
    }),
  );
});

async function main(): Promise<void> {
  health.listen(config.healthPort, '127.0.0.1');
  const subscription = await subscribeAmqpEvents(
    { amqpUrl: config.amqpUrl, queue: config.queue },
    async (event) => {
      try {
        const result = await handleEvent(event, ingestPool, config.maxRetries);
        lastEventAt = new Date().toISOString();
        lastError = null;
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.error('worker_event_failed', {
          routingKey: event.routingKey,
          error: lastError,
        });
        throw error;
      }
    },
  );
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
  process.once('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
}

main().catch(async (error) => {
  console.error('worker_failed', { error: error instanceof Error ? error.message : String(error) });
  await ingestPool.end().catch(() => undefined);
  await jobsPool.end().catch(() => undefined);
  process.exit(1);
});
