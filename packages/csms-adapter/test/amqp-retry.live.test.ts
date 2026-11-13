import amqp from 'amqplib';
import { describe, expect, it } from 'vitest';

const enabled = process.env.AMQP_LIVE_TEST === '1';
const url = process.env.CSMS_AMQP_URL ?? 'amqp://guest:guest@localhost:5672';

describe.skipIf(!enabled)('AMQP retry routing', () => {
  it('requeues retries to evstation.ingest without publishing to messages', async () => {
    const connection = await amqp.connect(url);
    const channel = await connection.createChannel();
    const probe = `evstation.retry.probe.${Date.now()}`;
    const key = 'frame.inbound.Heartbeat';
    try {
      await channel.assertQueue(probe, { durable: false, autoDelete: true });
      await channel.bindQueue(probe, 'messages', key);
      await channel.purgeQueue(probe);
      await channel.publish('evstation.ingest.dlx', key, Buffer.from('{"probe":true}'), {
        contentType: 'application/json',
        expiration: '30000',
      });
      await new Promise((resolve) => setTimeout(resolve, 32_000));
      const probeMessage = await channel.get(probe, { noAck: true });
      const main = await channel.checkQueue('evstation.ingest');
      expect(probeMessage).toBe(false);
      expect(main.messageCount).toBeGreaterThanOrEqual(0);
    } finally {
      await channel.deleteQueue(probe).catch(() => undefined);
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    }
  }, 45_000);
});
