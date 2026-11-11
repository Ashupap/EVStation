import { NextResponse, type NextRequest } from 'next/server';
import { dashboardUrl, loadDashboardConfig } from '@/lib/config';
import { clearSessionCookie } from '@/lib/cookies';
import { hasValidOrigin } from '@/lib/csrf';
import { buildLogoutUrl, revokeToken } from '@/lib/oidc';
import { getSessionStore } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const config = loadDashboardConfig();
  if (!hasValidOrigin(request, config.oidcRedirectUri)) {
    return NextResponse.json(
      { error: { code: 'CSRF_REJECTED', message: 'invalid origin' } },
      { status: 403 },
    );
  }

  const sessionId = request.cookies.get(config.sessionCookieName)?.value;
  const session = sessionId ? getSessionStore().get(sessionId) : undefined;
  if (sessionId) getSessionStore().delete(sessionId);

  let redirectTo = dashboardUrl(config, '/login');
  if (session?.idToken) {
    try {
      redirectTo = await buildLogoutUrl(session.idToken);
    } catch {
      // Fall back to local login when Keycloak discovery is unavailable.
    }
  }
  if (session?.refreshToken) {
    try {
      await Promise.race([
        revokeToken(session.refreshToken),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    } catch {
      // Keycloak outage must not prevent local logout.
    }
  }

  const response = NextResponse.redirect(redirectTo, 303);
  clearSessionCookie(response, config);
  response.headers.set('cache-control', 'no-store');
  return response;
}
