import { NextResponse, type NextRequest } from 'next/server';
import { dashboardUrl, loadDashboardConfig } from '@/lib/config';
import { clearLoginCookie, setSessionCookie } from '@/lib/cookies';
import { safeReturnTo } from '@/lib/csrf';
import { getLoginStore } from '@/lib/login-store';
import { exchangeCode } from '@/lib/oidc';
import { getSessionStore } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const config = loadDashboardConfig();
  const transactionId = request.cookies.get(config.loginCookieName)?.value;
  const transaction = transactionId ? getLoginStore().consume(transactionId) : undefined;

  if (!transaction) {
    const response = NextResponse.redirect(dashboardUrl(config, '/login?error=login_expired'));
    clearLoginCookie(response, config);
    return response;
  }

  try {
    const tokens = await exchangeCode(
      dashboardUrl(config, `${request.nextUrl.pathname}${request.nextUrl.search}`),
      transaction,
    );
    const expiresIn = tokens.expiresIn() ?? 60;
    const sessionId = getSessionStore().create({
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      accessExpiresAt: Date.now() + Math.max(30, expiresIn) * 1000,
      absoluteExpiresAt: Date.now() + config.sessionAbsoluteTtlSeconds * 1000,
    });
    const response = NextResponse.redirect(
      dashboardUrl(config, safeReturnTo(transaction.returnTo)),
    );
    setSessionCookie(response, sessionId, config);
    clearLoginCookie(response, config);
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    const response = NextResponse.redirect(dashboardUrl(config, '/login?error=login_failed'));
    clearLoginCookie(response, config);
    return response;
  }
}
