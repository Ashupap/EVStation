import { ResponseBodyError } from 'openid-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/oidc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/oidc.js')>();
  return { ...actual, refreshTokens: vi.fn() };
});

const { authenticateMe, refreshSession } = await import('../src/lib/auth.js');
const { refreshTokens } = await import('../src/lib/oidc.js');
const { getSessionStore } = await import('../src/lib/session-store.js');

const principal = {
  id: '90000000-0000-4000-8000-000000000001',
  email: 'viewer@example.com',
  display_name: 'Viewer',
  email_verified: true,
  is_platform_admin: false,
  memberships: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('API /me response contract', () => {
  it('accepts a valid principal', async () => {
    await expect(authenticateMe(jsonResponse(200, principal))).resolves.toEqual({
      kind: 'ok',
      principal,
    });
  });

  it('classifies an expired or missing session as unauthenticated', async () => {
    await expect(
      authenticateMe(jsonResponse(401, { error: { code: 'UNAUTHORIZED' } })),
    ).resolves.toEqual({ kind: 'unauthenticated' });
  });

  it('classifies a real API unverified-email rejection', async () => {
    await expect(
      authenticateMe(jsonResponse(403, { error: { code: 'EMAIL_UNVERIFIED' } })),
    ).resolves.toEqual({ kind: 'unverified' });
  });

  it('keeps other authorization failures distinct from unverified accounts', async () => {
    await expect(
      authenticateMe(jsonResponse(403, { error: { code: 'TENANT_FORBIDDEN' } })),
    ).resolves.toEqual({ kind: 'forbidden', code: 'TENANT_FORBIDDEN' });
    await expect(
      authenticateMe(jsonResponse(403, { error: { code: 'TENANT_SUSPENDED' } })),
    ).resolves.toEqual({ kind: 'forbidden', code: 'TENANT_SUSPENDED' });
  });

  it('classifies upstream failures without treating them as a logout', async () => {
    await expect(
      authenticateMe(jsonResponse(503, { error: { code: 'INTERNAL' } })),
    ).resolves.toEqual({ kind: 'error', status: 503 });
  });

  it('rejects an invalid principal payload as an upstream error', async () => {
    await expect(authenticateMe(jsonResponse(200, { id: 'not-a-uuid' }))).resolves.toEqual({
      kind: 'error',
      status: 502,
    });
  });
});

function sessionRecord() {
  return {
    accessToken: 'old-access-token',
    refreshToken: 'old-refresh-token',
    accessExpiresAt: Date.now() - 1_000,
    absoluteExpiresAt: Date.now() + 60_000,
  };
}

function tokenResponse(): Awaited<ReturnType<typeof refreshTokens>> {
  return {
    access_token: 'new-access-token',
    refresh_token: 'new-refresh-token',
    expiresIn: () => 60,
  } as Awaited<ReturnType<typeof refreshTokens>>;
}

describe('server-side refresh', () => {
  beforeEach(() => {
    vi.mocked(refreshTokens).mockReset();
  });

  it('single-flights concurrent refreshes for one session', async () => {
    const store = getSessionStore();
    const sessionId = store.create(sessionRecord());
    const session = store.get(sessionId);
    if (!session) throw new Error('test session missing');

    let release: (() => void) | undefined;
    vi.mocked(refreshTokens).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(tokenResponse());
        }),
    );

    const first = refreshSession(sessionId, session);
    const second = refreshSession(sessionId, session);
    release?.();

    const [a, b] = await Promise.all([first, second]);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(a?.accessToken).toBe('new-access-token');
    expect(b?.accessToken).toBe('new-access-token');
    store.delete(sessionId);
  });

  it('deletes the session only for invalid_grant', async () => {
    const store = getSessionStore();
    const sessionId = store.create(sessionRecord());
    const session = store.get(sessionId);
    if (!session) throw new Error('test session missing');

    vi.mocked(refreshTokens).mockRejectedValue(
      new ResponseBodyError('invalid_grant', {
        cause: { error: 'invalid_grant' },
        response: new Response(null, { status: 400 }),
      }),
    );

    await expect(refreshSession(sessionId, session)).resolves.toBeUndefined();
    expect(store.get(sessionId)).toBeUndefined();
  });

  it('keeps the session for transient refresh failures', async () => {
    const store = getSessionStore();
    const sessionId = store.create(sessionRecord());
    const session = store.get(sessionId);
    if (!session) throw new Error('test session missing');

    vi.mocked(refreshTokens).mockRejectedValue(new Error('network down'));

    await expect(refreshSession(sessionId, session)).resolves.toBeUndefined();
    expect(store.get(sessionId)?.accessToken).toBe('old-access-token');
    store.delete(sessionId);
  });
});
