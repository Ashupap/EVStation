import { NextResponse, type NextRequest } from 'next/server';
import { loadDashboardConfig } from '@/lib/config';
import { buildSecurityHeaders } from '@/lib/security';

export function proxy(request: NextRequest) {
  const config = loadDashboardConfig();
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const securityHeaders = buildSecurityHeaders({
    nonce,
    nodeEnv: config.nodeEnv,
    cookieSecure: config.cookieSecure,
    formActionOrigins: [new URL(config.oidcIssuer).origin],
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set(
    'content-security-policy',
    securityHeaders.get('content-security-policy') ?? '',
  );

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  securityHeaders.forEach((value, name) => response.headers.set(name, value));
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
