import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api';
import { getAuthContext } from '@/lib/auth';
import { hasValidOrigin } from '@/lib/csrf';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ token: z.string().min(20).max(512) }).strict();
const acceptedSchema = z.object({
  tenant_id: z.string().uuid(),
  membership_id: z.string().uuid(),
  role: z.enum(['tenant_admin', 'site_manager', 'viewer']),
});

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'invalid request body' } },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'INVALID_INVITATION', message: 'invalid invitation token' } },
      { status: 400 },
    );
  }

  const response = await apiFetch(
    auth.session,
    '/invitations/accept',
    { method: 'POST', body: JSON.stringify({ token: parsed.data.token }) },
    new Headers(request.headers),
  );
  if (!response.ok) {
    return NextResponse.json(
      {
        error: {
          code: response.status === 401 ? 'UNAUTHORIZED' : 'INVITATION_FAILED',
          message: 'invitation could not be accepted',
        },
      },
      { status: response.status === 401 ? 401 : 400 },
    );
  }

  const accepted = acceptedSchema.safeParse(await response.json());
  if (!accepted.success) {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_ERROR', message: 'invalid API response' } },
      { status: 502 },
    );
  }
  const result = NextResponse.json(accepted.data);
  result.headers.set('cache-control', 'no-store');
  return result;
}
