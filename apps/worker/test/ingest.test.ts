import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { CsmsEvent } from '@evstation/csms-adapter';
import { handleEvent, handleFailure } from '../src/ingest.js';

const HASH_EVENT: CsmsEvent = {
  routingKey: 'frame.inbound.MeterValues',
  raw: '{"kind":"frame"}',
  body: {
    kind: 'frame',
    tenantId: 1,
    ocppConnectionName: 'ACME-BLR-001',
    direction: 'inbound',
    correlationId: 'corr-1',
    action: 'MeterValues',
    protocol: 'ocpp1.6',
    payload: { transactionId: 7, meterValue: [] },
    timestamp: '2026-11-12T10:00:00Z',
  },
  redelivered: false,
  deathCount: 0,
};

function pool(result: string) {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: [{ result: String(sql).includes('record_parked_event') ? 'parked' : result }],
    })),
  } as unknown as Pool;
}

describe('worker event dispositions', () => {
  it('retries a missing session until the broker death count reaches the limit', async () => {
    const first = pool('retry');
    expect(await handleEvent(HASH_EVENT, first, 5)).toBe('retry');

    const parked = pool('retry');
    expect(await handleEvent({ ...HASH_EVENT, deathCount: 5 }, parked, 5)).toBe('ack');
    const calls = (parked.query as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([sql]) => String(sql).includes('record_parked_event'))).toBe(true);
  });

  it('parks a thrown handler failure after the death limit and acks', async () => {
    const parked = pool('retry');
    expect(await handleFailure({ ...HASH_EVENT, deathCount: 5 }, parked, 5)).toBe('ack');
    const calls = (parked.query as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(
        ([sql, args]) =>
          String(sql).includes('record_parked_event') && (args as unknown[])[4] === 'POISON',
      ),
    ).toBe(true);
    expect(await handleFailure({ ...HASH_EVENT, deathCount: 1 }, pool('retry'), 5)).toBe('retry');
  });

  it('rejects malformed frames immediately without retrying', async () => {
    const rejected = pool('rejected');
    const event: CsmsEvent = { ...HASH_EVENT, body: null, parseError: 'INVALID_JSON' };
    expect(await handleEvent(event, rejected, 5)).toBe('ack');
    const calls = (rejected.query as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([sql]) => String(sql).includes('reject_ingest_event'))).toBe(true);
  });
});
