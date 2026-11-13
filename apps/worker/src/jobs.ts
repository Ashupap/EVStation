import type { Pool, PoolClient } from 'pg';
import type { WorkerConfig } from './config.js';

type Queryable = Pick<Pool, 'query'>;
const JOB_KEYS = {
  expire: 9201,
  offline: 9202,
  stale: 9203,
  idTags: 9204,
  partitions: 9205,
  prune: 9206,
} as const;

let inProcessRunning = false;

async function call(pool: Queryable, fn: string, args: unknown[]): Promise<number> {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
  const result = await pool.query<{ result: number | string }>(
    `SELECT app.${fn}(${placeholders}) AS result`,
    args,
  );
  return Number(result.rows[0]?.result ?? 0);
}

export async function withJobLock(
  pool: Pool,
  key: number,
  task: (client: PoolClient) => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key],
    );
    if (lock.rows[0]?.locked !== true) return false;
    await task(client);
    return true;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => undefined);
    client.release();
  }
}

export async function runJobs(pool: Pool, config: WorkerConfig): Promise<void> {
  if (inProcessRunning) return;
  inProcessRunning = true;
  try {
    const expired = await withJobLock(pool, JOB_KEYS.expire, async (client) => {
      const count = await call(client, 'expire_pending_starts', [1000]);
      console.log('worker_job', { job: 'expire_pending_starts', count });
    });
    const offline = await withJobLock(pool, JOB_KEYS.offline, async (client) => {
      const count = await call(client, 'sweep_offline_stations', [config.offlineTimeoutSeconds]);
      console.log('worker_job', { job: 'sweep_offline_stations', count });
    });
    const stale = await withJobLock(pool, JOB_KEYS.stale, async (client) => {
      const count = await call(client, 'close_stale_sessions', [config.staleSessionSeconds]);
      console.log('worker_job', { job: 'close_stale_sessions', count });
    });
    const idTags = await withJobLock(pool, JOB_KEYS.idTags, async (client) => {
      const count = await call(client, 'pseudonymize_session_id_tags', [
        new Date(Date.now() - config.idTagRetentionDays * 86_400_000).toISOString(),
      ]);
      console.log('worker_job', { job: 'pseudonymize_session_id_tags', count });
    });
    const partitions = await withJobLock(pool, JOB_KEYS.partitions, async (client) => {
      const now = new Date();
      let created = 0;
      for (let offset = 0; offset <= 3; offset += 1) {
        const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
        for (const parent of [
          'session_meter_values',
          'station_status_events',
          'ingestion_events',
        ]) {
          await client.query('SELECT app.ensure_event_partition($1, $2::date)', [
            parent,
            month.toISOString().slice(0, 10),
          ]);
          created += 1;
        }
      }
      let dropped = 0;
      for (const [parent, days] of [
        ['session_meter_values', config.meterRetentionDays],
        ['station_status_events', config.statusRetentionDays],
        ['ingestion_events', config.ledgerRetentionDays],
      ] as const) {
        const before = new Date(Date.now() - days * 86_400_000);
        const beforeMonth = new Date(Date.UTC(before.getUTCFullYear(), before.getUTCMonth(), 1));
        dropped += await call(client, 'drop_expired_event_partitions', [
          parent,
          beforeMonth.toISOString().slice(0, 10),
        ]);
      }
      console.log('worker_job', { job: 'partitions', created, dropped });
    });
    const pruned = await withJobLock(pool, JOB_KEYS.prune, async (client) => {
      const count = await call(client, 'prune_ingestion_rejections', [
        config.rejectionRetentionDays,
      ]);
      console.log('worker_job', { job: 'prune_ingestion_rejections', count });
    });
    console.log('worker_jobs', {
      expired,
      offline,
      stale,
      idTags,
      partitions,
      pruned,
    });
  } finally {
    inProcessRunning = false;
  }
}
