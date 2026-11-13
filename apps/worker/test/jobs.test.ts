import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { runJobs, withJobLock } from '../src/jobs.js';
import type { WorkerConfig } from '../src/config.js';

function fakePool() {
  const locks = new Set<number>();
  return {
    connect: async () => {
      const client = {
        query: async (sql: string, args: unknown[] = []) => {
          if (sql.includes('pg_try_advisory_lock')) {
            const key = Number(args[0]);
            if (locks.has(key)) return { rows: [{ locked: false }] };
            locks.add(key);
            return { rows: [{ locked: true }] };
          }
          if (sql.includes('pg_advisory_unlock')) locks.delete(Number(args[0]));
          return { rows: [] };
        },
        release: () => undefined,
      } as unknown as PoolClient;
      return client;
    },
  } as unknown as Pool;
}

describe('job advisory locks', () => {
  it('creates the partition horizon through current+3 months', async () => {
    const months: string[] = [];
    const pool = {
      connect: async () =>
        ({
          query: async (sql: string, args: unknown[] = []) => {
            if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
            if (sql.includes('ensure_event_partition')) months.push(String(args[1]));
            if (sql.startsWith('SELECT app.')) return { rows: [{ result: 0 }] };
            return { rows: [] };
          },
          release: () => undefined,
        }) as unknown as PoolClient,
    } as unknown as Pool;
    await runJobs(pool, {
      offlineTimeoutSeconds: 60,
      staleSessionSeconds: 60,
      idTagRetentionDays: 30,
      meterRetentionDays: 365,
      statusRetentionDays: 90,
      ledgerRetentionDays: 30,
      rejectionRetentionDays: 30,
      jobIntervalMs: 60_000,
    } as WorkerConfig);
    expect(months).toHaveLength(12);
    expect(new Set(months).size).toBe(4);
    for (const month of new Set(months)) expect(month.endsWith('-01')).toBe(true);
  });

  it('allows only one runner to execute a job at a time', async () => {
    const pool = fakePool();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withJobLock(pool, 9201, async () => {
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await withJobLock(pool, 9201, async () => undefined);
    expect(second).toBe(false);
    release();
    expect(await first).toBe(true);
  });
});
