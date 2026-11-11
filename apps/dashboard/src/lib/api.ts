import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { loadDashboardConfig } from './config';
import type { SessionRecord } from './session-store';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function endUserIp(headers: Headers): string | undefined {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || headers.get('x-real-ip')?.trim() || undefined;
}

export async function apiFetch(
  session: SessionRecord,
  path: string,
  init: RequestInit = {},
  incomingHeaders?: Headers,
): Promise<Response> {
  const config = loadDashboardConfig();
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${session.accessToken}`);
  headers.set('accept', 'application/json');
  headers.set('x-request-id', incomingHeaders?.get('x-request-id') || randomUUID());
  if (session.tenantId) headers.set('x-tenant-id', session.tenantId);
  const ip = incomingHeaders ? endUserIp(incomingHeaders) : undefined;
  if (ip) headers.set('x-forwarded-for', ip);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  return fetch(new URL(path.replace(/^\//u, ''), `${config.apiBaseUrl}/`), {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
}

export async function parseApiJson<T>(response: Response, schema: ZodType<T>): Promise<T> {
  if (!response.ok) throw new ApiError(response.status, 'API request failed');
  return schema.parse(await response.json());
}
