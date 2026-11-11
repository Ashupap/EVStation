import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ResponseBodyError } from 'openid-client';
import { cache } from 'react';
import { apiFetch } from './api';
import { loadDashboardConfig } from './config';
import { readSessionCookie } from './cookies';
import { refreshTokens } from './oidc';
import type { Principal } from './types';
import { principalSchema, type Membership, type Role } from './types';
import type { SessionRecord } from './session-store';
import { getSessionStore } from './session-store';

export interface AuthContext {
  sessionId: string;
  session: SessionRecord;
  principal: Principal;
}

export interface TenantContext extends AuthContext {
  membership: Membership;
  tenantId: string;
}

export type MeResult =
  | { kind: 'ok'; principal: Principal }
  | { kind: 'unauthenticated' }
  | { kind: 'unverified' }
  | { kind: 'forbidden'; code: string }
  | { kind: 'error'; status: number };

export async function authenticateMe(response: Response): Promise<MeResult> {
  if (response.status === 401) return { kind: 'unauthenticated' };
  if (response.status === 403) {
    let code = 'FORBIDDEN';
    try {
      const body = (await response.json()) as { error?: { code?: unknown } };
      if (typeof body.error?.code === 'string') code = body.error.code;
    } catch {
      // A 403 without a JSON body is still an authorization failure.
    }
    return code === 'EMAIL_UNVERIFIED' ? { kind: 'unverified' } : { kind: 'forbidden', code };
  }
  if (!response.ok) return { kind: 'error', status: response.status };

  try {
    return { kind: 'ok', principal: principalSchema.parse(await response.json()) };
  } catch {
    return { kind: 'error', status: 502 };
  }
}

const globalRefresh = globalThis as typeof globalThis & {
  __evstationRefreshFlights?: Map<string, Promise<SessionRecord | undefined>>;
};
const refreshFlights =
  globalRefresh.__evstationRefreshFlights ?? new Map<string, Promise<SessionRecord | undefined>>();
globalRefresh.__evstationRefreshFlights = refreshFlights;

async function performRefresh(
  sessionId: string,
  session: SessionRecord,
): Promise<SessionRecord | undefined> {
  if (!session.refreshToken) {
    getSessionStore().delete(sessionId);
    return undefined;
  }
  try {
    const tokens = await refreshTokens(session.refreshToken);
    const expiresIn = tokens.expiresIn() ?? 60;
    const updated = getSessionStore().update(sessionId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.refreshToken,
      idToken: tokens.id_token ?? session.idToken,
      accessExpiresAt: Date.now() + Math.max(30, expiresIn) * 1000,
    });
    return updated;
  } catch (error) {
    if (error instanceof ResponseBodyError && error.error === 'invalid_grant') {
      getSessionStore().delete(sessionId);
    }
    return undefined;
  }
}

export function refreshSession(
  sessionId: string,
  session: SessionRecord,
): Promise<SessionRecord | undefined> {
  const existing = refreshFlights.get(sessionId);
  if (existing) return existing;

  const tracked = performRefresh(sessionId, session).finally(() => {
    if (refreshFlights.get(sessionId) === tracked) refreshFlights.delete(sessionId);
  });
  refreshFlights.set(sessionId, tracked);
  return tracked;
}

async function getSession(): Promise<{ sessionId: string; session: SessionRecord } | undefined> {
  const config = loadDashboardConfig();
  const sessionId = await readSessionCookie(config);
  if (!sessionId) return undefined;
  const store = getSessionStore();
  let session = store.get(sessionId);
  if (!session) return undefined;
  if (session.accessExpiresAt <= Date.now() + 30_000) {
    session = await refreshSession(sessionId, session);
    if (!session) return undefined;
  }
  return { sessionId, session };
}

export async function hasServerSession(): Promise<boolean> {
  const config = loadDashboardConfig();
  const sessionId = await readSessionCookie(config);
  return Boolean(sessionId && getSessionStore().get(sessionId));
}

export type AuthState =
  { kind: 'ok'; auth: AuthContext } | { kind: 'anonymous' } | { kind: 'unavailable' };

export const getAuthState = cache(async (): Promise<AuthState> => {
  const current = await getSession();
  if (!current) return { kind: 'anonymous' };
  const incomingHeaders = await headers();
  const response = await apiFetch(
    current.session,
    '/me',
    { method: 'GET' },
    new Headers(incomingHeaders),
  );
  const result = await authenticateMe(response);

  if (result.kind === 'unauthenticated') {
    getSessionStore().delete(current.sessionId);
    return { kind: 'anonymous' };
  }
  if (result.kind === 'unverified') redirect('/unverified-email');
  if (result.kind === 'error') return { kind: 'unavailable' };
  if (result.kind !== 'ok') return { kind: 'anonymous' };

  return { kind: 'ok', auth: { ...current, principal: result.principal } };
});

export const getAuthContext = cache(async (): Promise<AuthContext | undefined> => {
  const state = await getAuthState();
  return state.kind === 'ok' ? state.auth : undefined;
});

export function activeMembership(
  principal: Principal,
  session: SessionRecord,
): Membership | undefined {
  const selected = principal.memberships.find(
    (membership) => membership.tenant_id === session.tenantId && membership.tenant_name,
  );
  if (selected) return selected;
  if (principal.memberships.length === 1) return principal.memberships[0];
  return undefined;
}

export async function requireAuth(): Promise<AuthContext> {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');
  if (!auth.principal.email_verified) redirect('/unverified-email');
  return auth;
}

export async function requireTenant(roles?: Role[]): Promise<TenantContext> {
  const auth = await requireAuth();
  const membership = activeMembership(auth.principal, auth.session);
  if (!membership) redirect('/app');
  if (roles && !roles.includes(membership.role)) redirect('/app');
  return { ...auth, membership, tenantId: membership.tenant_id };
}

export async function requirePlatformAdmin(): Promise<AuthContext> {
  const auth = await requireAuth();
  if (!auth.principal.is_platform_admin) redirect('/app');
  return auth;
}
