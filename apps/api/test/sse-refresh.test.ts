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

    const unknownRaw = new Sink();
    const unknown = connection(unknownRaw);
    const unknownHub = hub(new Error('other')) as unknown as {
      refresh: (c: unknown) => Promise<void>;
    };
    await unknownHub.refresh(unknown);
    expect(unknown.closed).toBe(false);
    await unknownHub.refresh(unknown);
    await unknownHub.refresh(unknown);
    expect(unknown.closed).toBe(true);
  });
});

describe('M2 actor preference and fallback', () => {
  it('prefers tenant_admin and falls back when that actor cannot see the row', async () => {
    const { Writable } = await import('node:stream');
    const chunks: string[] = [];
    const raw = new Writable({
      write(c, _e, cb) {
        chunks.push(c.toString());
        cb();
      },
    });
    const mk = (id: string, role: string) => ({
      id,
      scope: {
        actorId: id,
        email: `${id}@x`,
        tenantId: 't1',
        role,
        siteIds: [],
        tokenExpiresAt: null,
      },
      response: { raw },
      raw,
      closed: false,
      refreshFailures: 0,
    });
    const admin = mk('admin', 'tenant_admin');
    const viewer = mk('viewer', 'viewer');
    const instance = new SseHub(
      { transaction: async () => null } as never,
      {} as never,
    ) as unknown as {
      connections: Map<string, unknown>;
      reread: (
        actor: string,
      ) => Promise<{ tenant_id: string; site_id: string; data: Record<string, unknown> } | null>;
      processNotification: (payload: Record<string, unknown>) => Promise<void>;
    };
    instance.connections.set(admin.id, admin);
    instance.connections.set(viewer.id, viewer);
    const calls: string[] = [];
    instance.reread = async (actor: string) => {
      calls.push(actor);
      return actor === 'admin'
        ? null
        : { tenant_id: 't1', site_id: 's1', data: { station_id: 'st1', updated_at: 'now' } };
    };
    await instance.processNotification({
      kind: 'station.status',
      tenant_id: 't1',
      site_id: 's1',
      station_id: 'st1',
      occurred_at: '2026-11-12T00:00:00Z',
    });
    expect(calls).toEqual(['admin', 'viewer']);
    expect(chunks.join('')).toContain('event: station.status');
  });
});
