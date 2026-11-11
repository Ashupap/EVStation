import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { apiFetch, parseApiJson } from './api';
import { loadDashboardConfig } from './config';
import { readSessionCookie } from './cookies';
import { refreshTokens } from './oidc';
import type { SessionRecord } from './session-store';
import { getSessionStore } from './session-store';
import { principalSchema, type Membership, type Principal, type Role } from './types';

export interface AuthContext {
  sessionId: string;
  session: SessionRecord;
  principal: Principal;
}

export interface TenantContext extends AuthContext {
  membership: Membership;
  tenantId: string;
}

async function refreshSession(
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
    if (!updated) return undefined;
    return updated;
  } catch {
    getSessionStore().delete(sessionId);
    return undefined;
  }
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

export const getAuthContext = cache(async (): Promise<AuthContext | undefined> => {
  const current = await getSession();
  if (!current) return undefined;
  const incomingHeaders = await headers();
  const response = await apiFetch(
    current.session,
    '/me',
    { method: 'GET' },
    new Headers(incomingHeaders),
  );
  if (response.status === 401) {
    getSessionStore().delete(current.sessionId);
    return undefined;
  }
  const principal = await parseApiJson(response, principalSchema);
  return { ...current, principal };
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
