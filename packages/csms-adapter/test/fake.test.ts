import { describe, expect, it } from 'vitest';
import { createFakeCsmsAdapter, CsmsError } from '../src/index.js';

const input = {
  stationId: '30000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
  siteId: '20000000-0000-4000-8000-000000000001',
  stationRef: 'ACME-BLR-001',
  orgCode: 'ACME',
  siteCode: 'BLR',
};

describe('fake CSMS adapter', () => {
  it('registers idempotently and conflicts with another station owner', async () => {
    const adapter = createFakeCsmsAdapter();
    const first = await adapter.registerStation(input);
    const second = await adapter.registerStation(input);
    expect(second).toEqual(first);
    await expect(
      adapter.registerStation({ ...input, stationId: '30000000-0000-4000-8000-000000000002' }),
    ).rejects.toMatchObject({ code: 'CSMS_CONFLICT' });
  });

  it('returns credentials for provision/rotate and stubs commands/events', async () => {
    const adapter = createFakeCsmsAdapter();
    expect(await adapter.provisionPassword('x')).toMatch(/^fake-/u);
    expect(await adapter.rotatePassword('x')).toMatch(/^rotated-/u);
    await expect(adapter.sendCommand('x', 'reset', {})).rejects.toBeInstanceOf(CsmsError);
    const subscription = await adapter.subscribeEvents(async () => undefined);
    await expect(subscription.close()).resolves.toBeUndefined();
  });
});
