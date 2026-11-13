import amqp, { type Channel, type ConsumeMessage } from 'amqplib';
import type { CsmsEventDisposition, CsmsEventHandler } from './types.js';

export interface AmqpEventConfig {
  amqpUrl: string;
  queue: string;
  onState?: (state: 'connected' | 'closed' | 'error', error?: Error) => void;
}

export function createSerialDispatcher<T>(handler: (value: T) => Promise<void>) {
  let chain: Promise<void> = Promise.resolve();
  const dispatcher = ((value: T): Promise<void> => {
    const next = chain.then(() => handler(value));
    chain = next.catch(() => undefined);
    return next;
  }) as ((value: T) => Promise<void>) & { chain: Promise<void> };
  Object.defineProperty(dispatcher, 'chain', { get: () => chain });
  return dispatcher;
}

export async function subscribeAmqpEvents(
  config: AmqpEventConfig,
  handler: CsmsEventHandler,
): Promise<{ close(): Promise<void> }> {
  const connection = await amqp.connect(config.amqpUrl);
  const channel: Channel = await connection.createChannel();
  await channel.prefetch(1);
  let closed = false;
  let closing = false;
  const onMessage = async (message: ConsumeMessage | null): Promise<void> => {
    if (!message) return;
    const raw = message.content.toString('utf8');
    let body: Record<string, unknown> | null = null;
    let parseError: 'INVALID_JSON' | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      } else {
        parseError = 'INVALID_JSON';
      }
    } catch {
      parseError = 'INVALID_JSON';
    }
    const death = message.properties.headers?.['x-death'];
    const deathCount = Array.isArray(death)
      ? death.reduce((total, entry) => {
          const count = (entry as { count?: number }).count;
          return total + (typeof count === 'number' ? count : 0);
        }, 0)
      : 0;
    let disposition: CsmsEventDisposition = 'ack';
    try {
      const result = await handler({
        routingKey: message.fields.routingKey,
        raw,
        body,
        parseError,
        redelivered: message.fields.redelivered,
        deathCount,
      });
      if (result === 'retry') disposition = 'retry';
    } catch (error) {
      console.error('csms_event_handler_error', {
        routingKey: message.fields.routingKey,
        message: error instanceof Error ? error.message : String(error),
      });
      disposition = 'retry';
    }
    if (closed) return;
    if (disposition === 'retry') channel.nack(message, false, false);
    else channel.ack(message);
  };
  const serial = createSerialDispatcher(onMessage);
  const { consumerTag } = await channel.consume(config.queue, (message) => {
    void serial(message);
  });
  connection.on('error', (error) => config.onState?.('error', error));
  connection.on('close', () => {
    if (!closing) config.onState?.('closed');
  });
  channel.on('error', (error) => config.onState?.('error', error));
  config.onState?.('connected');
  return {
    close: async () => {
      if (closing) return;
      closing = true;
      await channel.cancel(consumerTag).catch(() => undefined);
      await serial.chain;
      closed = true;
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    },
  };
}
