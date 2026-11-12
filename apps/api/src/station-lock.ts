import type { PoolClient } from 'pg';

export async function tryStationLock(client: PoolClient, stationRef: string): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
    [stationRef],
  );
  return result.rows[0]?.locked === true;
}

export async function releaseStationLock(client: PoolClient, stationRef: string): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [stationRef]);
    client.release();
  } catch {
    client.release(true);
  }
}
