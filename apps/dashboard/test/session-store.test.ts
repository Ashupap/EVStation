import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryLoginStore } from '../src/lib/login-store.js';
import { InMemorySessionStore } from '../src/lib/session-store.js';

afterEach(() => {
  vi.useRealTimers();
});

function record() {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessExpiresAt: Date.now() + 60_000,
    absoluteExpiresAt: Date.now() + 120_000,
  };
}

describe('in-memory session store', () => {
  it('creates an opaque id and keeps tokens server-side', () => {
    const store = new InMemorySessionStore();
    const id = store.create(record());
    expect(id).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(id).not.toContain('access-token');
    expect(store.get(id)?.accessToken).toBe('access-token');
  });

  it('updates and deletes a session', () => {
    const store = new InMemorySessionStore();
    const id = store.create(record());
    expect(store.update(id, { tenantId: '10000000-0000-4000-8000-000000000001' })?.tenantId).toBe(
      '10000000-0000-4000-8000-000000000001',
    );
    store.delete(id);
    expect(store.get(id)).toBeUndefined();
  });

  it('enforces the absolute session lifetime', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
    const store = new InMemorySessionStore();
    const id = store.create({
      accessToken: 'access-token',
      accessExpiresAt: Date.now() + 10_000,
      absoluteExpiresAt: Date.now() + 1_000,
    });
    vi.advanceTimersByTime(1_001);
    expect(store.get(id)).toBeUndefined();
  });

  it('does not return references that mutate stored tokens', () => {
    const store = new InMemorySessionStore();
    const id = store.create(record());
    const first = store.get(id);
    if (first) first.accessToken = 'changed';
    expect(store.get(id)?.accessToken).toBe('access-token');
  });
});

describe('in-memory login store', () => {
  it('consumes a login transaction exactly once', () => {
    const store = new InMemoryLoginStore();
    const id = store.create({
      state: 'state',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      returnTo: '/app',
      expiresAt: Date.now() + 60_000,
    });
    expect(store.consume(id)?.state).toBe('state');
    expect(store.consume(id)).toBeUndefined();
  });

  it('rejects expired login transactions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
    const store = new InMemoryLoginStore();
    const id = store.create({
      state: 'state',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      returnTo: '/app',
      expiresAt: Date.now() + 1_000,
    });
    vi.advanceTimersByTime(1_001);
    expect(store.consume(id)).toBeUndefined();
  });
});
