import { describe, expect, it } from 'vitest';
import { hasValidOrigin, safeReturnTo } from '../src/lib/csrf.js';

const EXPECTED_ORIGIN = 'https://console.example.com';

function request(headers: Record<string, string>): Request {
  return new Request('http://dashboard:3200/api/tenant', { method: 'POST', headers });
}

describe('BFF origin checks', () => {
  it('accepts a request from the configured dashboard origin', () => {
    expect(
      hasValidOrigin(
        request({
          host: 'dashboard:3200',
          origin: EXPECTED_ORIGIN,
        }),
        EXPECTED_ORIGIN,
      ),
    ).toBe(true);
  });

  it('ignores forwarded host and protocol headers when comparing the origin', () => {
    expect(
      hasValidOrigin(
        request({
          host: 'dashboard:3200',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'http',
          origin: EXPECTED_ORIGIN,
        }),
        EXPECTED_ORIGIN,
      ),
    ).toBe(true);
    expect(
      hasValidOrigin(
        request({
          host: 'dashboard:3200',
          'x-forwarded-host': EXPECTED_ORIGIN,
          'x-forwarded-proto': 'https',
          origin: 'https://evil.example',
        }),
        EXPECTED_ORIGIN,
      ),
    ).toBe(false);
  });

  it('rejects a foreign, missing, or malformed origin', () => {
    expect(
      hasValidOrigin(
        request({ host: 'dashboard:3200', origin: 'https://evil.example' }),
        EXPECTED_ORIGIN,
      ),
    ).toBe(false);
    expect(hasValidOrigin(request({ host: 'dashboard:3200' }), EXPECTED_ORIGIN)).toBe(false);
    expect(
      hasValidOrigin(request({ host: 'dashboard:3200', origin: 'not a url' }), EXPECTED_ORIGIN),
    ).toBe(false);
  });
});

describe('return-to validation', () => {
  const base = 'https://console.example.com/auth/callback';

  it('allows only internal app paths', () => {
    expect(safeReturnTo('/app', base)).toBe('/app');
    expect(safeReturnTo('/app/sites?status=active#top', base)).toBe('/app/sites?status=active#top');
    expect(safeReturnTo('/app/../login', base)).toBe('/app');
    expect(safeReturnTo('/application', base)).toBe('/app');
    expect(safeReturnTo('/login', base)).toBe('/app');
    expect(safeReturnTo(null, base)).toBe('/app');
  });

  it.each([
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    'http://console.example.com/login',
    'javascript:alert(1)',
    '/%2F%2Fevil.example',
    '/%5Cevil.example',
    '/app/%2e%2e/login',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    `/${'x'.repeat(600)}`,
  ])('rejects unsafe return target %j', (value) => {
    expect(safeReturnTo(value, base)).toBe('/app');
  });
});
