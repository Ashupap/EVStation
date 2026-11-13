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
    const marker = `retry-${Date.now()}`;
    let received: string | null = null;
    try {
      await channel.assertQueue(probe, { durable: false, autoDelete: true });
      await channel.bindQueue(probe, 'messages', key);
      await channel.purgeQueue(probe);
      await channel.prefetch(1);
      await channel.consume(
        'evstation.ingest',
        (message) => {
          if (!message) return;
          const body = message.content.toString();
          if (body.includes(marker)) {
            received = body;
            channel.ack(message);
          } else {
            channel.nack(message, false, true);
          }
        },
        { noAck: false },
      );
      await channel.publish('evstation.ingest.dlx', key, Buffer.from(`{"marker":"${marker}"}`), {
        contentType: 'application/json',
        expiration: '30000',
      });
      const deadline = Date.now() + 34_000;
      while (received === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const probeMessage = await channel.get(probe, { noAck: true });
      expect(received).toContain(marker);
      expect(probeMessage).toBe(false);
    } finally {
      await channel.deleteQueue(probe).catch(() => undefined);
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    }
  }, 45_000);
});
