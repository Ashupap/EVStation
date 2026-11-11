import { NextResponse, type NextRequest } from 'next/server';
import { getAuthContext } from '@/lib/auth';
import { dashboardUrl, loadDashboardConfig } from '@/lib/config';
import { hasValidOrigin } from '@/lib/csrf';
import { getSessionStore } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function readTenantId(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as { tenantId?: unknown };
    return body.tenantId;
  }
  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    return (await request.formData()).get('tenantId');
  }
  return undefined;
}

export async function POST(request: NextRequest) {
  const config = loadDashboardConfig();
  if (!hasValidOrigin(request, config.oidcRedirectUri)) {
    return NextResponse.json(
      { error: { code: 'CSRF_REJECTED', message: 'invalid origin' } },
      { status: 403 },
    );
  }
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'sign in required' } },
      { status: 401 },
    );
  }

  const value = await readTenantId(request);
  if (typeof value !== 'string') {
    return NextResponse.json(
      { error: { code: 'INVALID_TENANT', message: 'tenantId is required' } },
      { status: 400 },
    );
  }
  const tenantId = value.trim();
  if (tenantId !== '' && !UUID_PATTERN.test(tenantId)) {
    return NextResponse.json(
      { error: { code: 'INVALID_TENANT', message: 'tenantId must be a UUID' } },
      { status: 400 },
    );
  }
  if (tenantId && !auth.principal.memberships.some((item) => item.tenant_id === tenantId)) {
    return NextResponse.json(
      { error: { code: 'TENANT_FORBIDDEN', message: 'tenant is not available' } },
      { status: 403 },
    );
  }

  getSessionStore().update(auth.sessionId, { tenantId: tenantId || undefined });
  const response = NextResponse.redirect(dashboardUrl(config, '/app'), 303);
  response.headers.set('cache-control', 'no-store');
  return response;
}
