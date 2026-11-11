import { NextResponse, type NextRequest } from 'next/server';
import { dashboardUrl, loadDashboardConfig } from '@/lib/config';
import { setLoginCookie } from '@/lib/cookies';
import { safeReturnTo } from '@/lib/csrf';
import { getLoginStore } from '@/lib/login-store';
import { buildLoginUrl } from '@/lib/oidc';
import { getLoginRateLimiter } from '@/lib/rate-limit';
import { clientIp } from '@/lib/request-ip';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const config = loadDashboardConfig();
  const limit = getLoginRateLimiter().check(clientIp(request.headers, config));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: 'too many login attempts' } },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  const returnTo = safeReturnTo(
    request.nextUrl.searchParams.get('returnTo'),
    dashboardUrl(config, '/').toString(),
  );
  try {
    const login = await buildLoginUrl();
    const transactionId = getLoginStore().create({
      state: login.state,
      nonce: login.nonce,
      codeVerifier: login.codeVerifier,
      returnTo,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const response = NextResponse.redirect(login.url);
    setLoginCookie(response, transactionId, config);
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    return NextResponse.redirect(dashboardUrl(config, '/login?error=oidc_unavailable'));
  }
}
