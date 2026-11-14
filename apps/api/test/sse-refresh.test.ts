import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SseHub, classifyRefreshError } from '../src/sse.js';

class Sink extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer, _e: BufferEncoding, cb: () => void) {
    this.chunks.push(chunk.toString());
    cb();
  }
}
function connection(raw: Writable) {
  return {
    id: 'c1',
    scope: {
      actorId: 'u1',
      email: 'u@example.com',
      tenantId: 't1',
      role: 'viewer',
      siteIds: [],
      tokenExpiresAt: null,
    },
    response: { raw },
    raw,
    closed: false,
    refreshFailures: 0,
  };
}
function hub(error: unknown) {
  return new SseHub(
    {
      transaction: async () => {
        throw error;
      },
    } as never,
    {} as never,
  ) as never as {
    refresh: (c: unknown) => Promise<void>;
  };
}

describe('SSE refresh classifier', () => {
  it('classifies access denied, transient and unknown errors', () => {
    expect(classifyRefreshError({ code: 'P0001' })).toBe('access_denied');
    expect(classifyRefreshError({ code: 'ECONNRESET' })).toBe('transient');
    expect(classifyRefreshError(new Error('other'))).toBe('unknown');
  });

  it('closes on access denied and caps transient failures', async () => {
    const deniedRaw = new Sink();
    const denied = connection(deniedRaw);
    const deniedHub = hub({ code: 'P0001' }) as unknown as {
      refresh: (c: unknown) => Promise<void>;
    };
    await deniedHub.refresh(denied);
    expect(denied.closed).toBe(true);
    expect(deniedRaw.chunks.join('')).toContain('membership_removed');

    const transientRaw = new Sink();
    const transient = connection(transientRaw);
    const transientHub = hub({ code: 'ECONNRESET' }) as unknown as {
      refresh: (c: unknown) => Promise<void>;
    };
    await transientHub.refresh(transient);
    await transientHub.refresh(transient);
    expect(transient.closed).toBe(false);
    await transientHub.refresh(transient);
    expect(transient.closed).toBe(true);
    expect(transientRaw.chunks.join('')).toContain('scope_refresh_failed');
  });
});
