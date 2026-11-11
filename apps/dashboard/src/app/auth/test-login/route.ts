import { NextResponse, type NextRequest } from 'next/server';
import { dashboardUrl, loadDashboardConfig } from '@/lib/config';
import { setSessionCookie } from '@/lib/cookies';
import { getSessionStore } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

const TENANT_A = '10000000-0000-4000-8000-000000000001';

const personas: Record<string, { tenantId: string; accessExpiresAt?: number }> = {
  admin: { tenantId: TENANT_A },
  viewer: { tenantId: TENANT_A },
  manager: { tenantId: TENANT_A },
  unverified: { tenantId: TENANT_A },
  multitenant: { tenantId: TENANT_A },
  expired: { tenantId: TENANT_A, accessExpiresAt: Date.now() - 1_000 },
};

export async function GET(request: NextRequest) {
  const config = loadDashboardConfig();
  if (!config.e2eMode || config.nodeEnv === 'production') {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'route not found' } },
      { status: 404 },
    );
  }

  const persona = request.nextUrl.searchParams.get('persona') ?? 'admin';
  const selected = personas[persona];
  if (!selected) {
    return NextResponse.json(
      { error: { code: 'INVALID_PERSONA', message: 'unknown test persona' } },
      { status: 400 },
    );
  }

  const sessionId = getSessionStore().create({
    accessToken: `test-access-token-${persona}`,
    accessExpiresAt: selected.accessExpiresAt ?? Date.now() + 60 * 60 * 1000,
    absoluteExpiresAt: Date.now() + config.sessionAbsoluteTtlSeconds * 1000,
    tenantId: persona === 'multitenant' ? TENANT_A : selected.tenantId,
  });
  const response = NextResponse.redirect(dashboardUrl(config, '/app'));
  setSessionCookie(response, sessionId, config);
  response.headers.set('cache-control', 'no-store');
  return response;
}
