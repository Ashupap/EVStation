import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SseHub } from '../src/sse.js';

class StuckWritable extends Writable {
  constructor() {
    super({ highWaterMark: 1 });
  }
  _write(): void {
    // Intentionally never calls the callback: simulates a stuck client socket.
  }
}

class CollectingWritable extends Writable {
  chunks: string[] = [];
  constructor() {
    super({ highWaterMark: 1024 });
  }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}

function hub() {
  return new SseHub({} as never, {} as never);
}

function connection(raw: Writable) {
  return {
    id: crypto.randomUUID(),
    scope: {
      actorId: 'actor',
      email: 'a@example.com',
      tenantId: 'tenant',
      role: 'tenant_admin',
      siteIds: [],
      tokenExpiresAt: null,
    },
    response: { raw },
    raw,
    closed: false,
    refreshFailures: 0,
  };
}

describe('SSE deterministic backpressure policy', () => {
  it('closes a stuck writer and leaves a healthy writer intact', () => {
    const instance = hub() as unknown as {
      connections: Map<string, unknown>;
      sendRaw: (connection: unknown, frame: string) => void;
      snapshot: () => { backpressure_closes: number };
    };
    const stuckRaw = new StuckWritable();
    const stuck = connection(stuckRaw);
    instance.connections.set(stuck.id, stuck);
    instance.sendRaw(stuck, 'event: station.status\ndata: {"x":1}\n\n');
    expect(stuckRaw.destroyed).toBe(true);
    expect(instance.snapshot().backpressure_closes).toBe(1);

    const healthyRaw = new CollectingWritable();
    const healthy = connection(healthyRaw);
    instance.connections.set(healthy.id, healthy);
    instance.sendRaw(healthy, 'event: station.status\ndata: {"x":2}\n\n');
    expect(healthyRaw.chunks.join('')).toContain('"x":2');
    expect(healthyRaw.destroyed).toBe(false);
  });
});
