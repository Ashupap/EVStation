import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { releaseStationLock } from '../src/station-lock.js';

describe('station advisory lock release', () => {
  it('releases the pooled connection after a successful unlock', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    await releaseStationLock(client as unknown as PoolClient, 'ACME-BLR-001');
    expect(client.release).toHaveBeenCalledWith();
  });

  it('destroys the pooled connection when unlock fails', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('connection lost')),
      release: vi.fn(),
    };
    await releaseStationLock(client as unknown as PoolClient, 'ACME-BLR-001');
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
