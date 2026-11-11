import { NextResponse, type NextRequest } from 'next/server';
import { dashboardUrl, loadDashboardConfig } from '@/lib/config';
import { clearSessionCookie } from '@/lib/cookies';
import { hasValidOrigin } from '@/lib/csrf';
import { revokeToken } from '@/lib/oidc';
import { getSessionStore } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) {
    return NextResponse.json(
      { error: { code: 'CSRF_REJECTED', message: 'invalid origin' } },
      { status: 403 },
    );
  }

  const config = loadDashboardConfig();
  const sessionId = request.cookies.get(config.sessionCookieName)?.value;
  if (sessionId) {
    const session = getSessionStore().get(sessionId);
    getSessionStore().delete(sessionId);
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
  }

  const response = NextResponse.redirect(dashboardUrl(config, '/login'), 303);
  clearSessionCookie(response, config);
  response.headers.set('cache-control', 'no-store');
  return response;
}
