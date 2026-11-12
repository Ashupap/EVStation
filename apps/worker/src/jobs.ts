import type { Pool } from 'pg';
import type { WorkerConfig } from './config.js';

async function call(pool: Pool, fn: string, args: unknown[]): Promise<number> {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
  const result = await pool.query<{ result: number | string }>(
    `SELECT app.${fn}(${placeholders}) AS result`,
    args,
  );
  return Number(result.rows[0]?.result ?? 0);
}

export async function runJobs(pool: Pool, config: WorkerConfig): Promise<void> {
  const expired = await call(pool, 'expire_pending_starts', [1000]);
  const offline = await call(pool, 'sweep_offline_stations', [config.offlineTimeoutSeconds]);
  const stale = await call(pool, 'close_stale_sessions', [config.staleSessionSeconds]);
  const idTags = await call(pool, 'pseudonymize_session_id_tags', [
    new Date(Date.now() - config.idTagRetentionDays * 86_400_000).toISOString(),
  ]);
  const now = new Date();
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  for (const parent of ['session_meter_values', 'station_status_events', 'ingestion_events']) {
    for (const month of [currentMonth, nextMonth]) {
      await pool.query('SELECT app.ensure_event_partition($1, $2::date)', [
        parent,
        month.toISOString().slice(0, 10),
      ]);
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
    dropped += await call(pool, 'drop_expired_event_partitions', [
      parent,
      beforeMonth.toISOString().slice(0, 10),
    ]);
  }
  console.log('worker_jobs', { expired, offline, stale, idTags, dropped });
}
