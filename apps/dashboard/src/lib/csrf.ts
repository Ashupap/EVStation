function headerValue(headers: Headers, name: string): string | undefined {
  return headers.get(name)?.split(',')[0]?.trim() || undefined;
}

export function hasValidOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  const host = headerValue(request.headers, 'x-forwarded-host') ?? request.headers.get('host');
  if (!host) return false;
  const protocol =
    headerValue(request.headers, 'x-forwarded-proto') ?? new URL(request.url).protocol.slice(0, -1);

  return originUrl.protocol === `${protocol}:` && originUrl.host === host;
}

export function safeReturnTo(value: string | null): string {
  if (!value || value.length > 512) return '/app';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/app';
  return value;
}
