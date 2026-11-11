export interface SecurityHeaderOptions {
  nonce: string;
  nodeEnv: 'development' | 'test' | 'production';
  cookieSecure: boolean;
  formActionOrigins?: string[];
}

export function buildContentSecurityPolicy({
  nonce,
  development,
  formActionOrigins = [],
}: {
  nonce: string;
  development: boolean;
  formActionOrigins?: string[];
}): string {
  const scriptEval = development ? " 'unsafe-eval'" : '';
  const connect = development ? "connect-src 'self' ws: http:;" : "connect-src 'self';";
  const upgrade = development ? '' : ' upgrade-insecure-requests;';

  return [
    "default-src 'self';",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${scriptEval};`,
    `style-src 'self' 'nonce-${nonce}';`,
    "img-src 'self' blob: data:;",
    "font-src 'self';",
    connect,
    "object-src 'none';",
    "base-uri 'self';",
    `form-action 'self'${formActionOrigins.length ? ` ${formActionOrigins.join(' ')}` : ''};`,
    "frame-ancestors 'none';",
    `frame-src 'none';`,
    `worker-src 'self' blob:;${upgrade}`,
  ]
    .join(' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

export function buildSecurityHeaders(options: SecurityHeaderOptions): Headers {
  const headers = new Headers();
  const development = options.nodeEnv === 'development';
  headers.set(
    'content-security-policy',
    buildContentSecurityPolicy({
      nonce: options.nonce,
      development,
      formActionOrigins: options.formActionOrigins,
    }),
  );
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'same-origin');
  headers.set(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  if (options.nodeEnv === 'production' && options.cookieSecure) {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  return headers;
}
