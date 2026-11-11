function isUnsafe(value: string): boolean {
  return /[\u0000-\u001f\u007f\\]/u.test(value);
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function hasValidOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}

export function safeReturnTo(value: string | null, base: string): string {
  const fallback = '/app';
  if (!value || value.length > 512) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (isUnsafe(value)) return fallback;

  const decoded = decode(value);
  if (decoded === undefined || isUnsafe(decoded) || decoded.startsWith('//')) return fallback;

  let target: URL;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
    target = new URL(decoded, baseUrl);
  } catch {
    return fallback;
  }

  if (target.origin !== baseUrl.origin) return fallback;
  if (target.pathname !== '/app' && !target.pathname.startsWith('/app/')) return fallback;

  return `${target.pathname}${target.search}${target.hash}`;
}
