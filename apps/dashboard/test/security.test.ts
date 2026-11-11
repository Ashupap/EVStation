import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, buildSecurityHeaders } from '../src/lib/security.js';

describe('security response headers', () => {
  it('uses a nonce-based CSP and hardened browser headers', () => {
    const nonce = 'dGVzdC1ub25jZQ==';
    const headers = buildSecurityHeaders({
      nonce,
      nodeEnv: 'development',
      cookieSecure: false,
    });

    expect(headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
    expect(headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('content-security-policy')).toContain("base-uri 'self'");
    expect(headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(headers.get('content-security-policy')).toContain("'unsafe-eval'");
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('same-origin');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('permissions-policy')).toContain('camera=()');
    expect(headers.get('strict-transport-security')).toBeNull();
  });

  it('adds HSTS only when the dashboard is served over secure HTTPS', () => {
    const headers = buildSecurityHeaders({
      nonce: 'nonce',
      nodeEnv: 'production',
      cookieSecure: true,
    });

    expect(headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(headers.get('content-security-policy')).not.toContain("'unsafe-eval'");
  });

  it('does not fall back to unsafe-inline scripts or styles', () => {
    const csp = buildContentSecurityPolicy({ nonce: 'abc', development: false });
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
  });
});
