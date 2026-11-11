import { describe, expect, it } from 'vitest';
import { hasValidOrigin, safeReturnTo } from '../src/lib/csrf.js';

function request(headers: Record<string, string>): Request {
  return new Request('http://localhost:3200/api/tenant', { method: 'POST', headers });
}

describe('BFF origin checks', () => {
  it('accepts a same-origin request', () => {
    expect(
      hasValidOrigin(
        request({
          host: 'localhost:3200',
          origin: 'http://localhost:3200',
        }),
      ),
    ).toBe(true);
  });

  it('uses forwarded host and protocol behind a trusted front proxy', () => {
    expect(
      hasValidOrigin(
        request({
          host: 'dashboard:3200',
          'x-forwarded-host': 'console.example.com',
          'x-forwarded-proto': 'https',
          origin: 'https://console.example.com',
        }),
      ),
    ).toBe(true);
  });

  it('rejects a foreign, missing, or malformed origin', () => {
    expect(
      hasValidOrigin(request({ host: 'localhost:3200', origin: 'https://evil.example' })),
    ).toBe(false);
    expect(hasValidOrigin(request({ host: 'localhost:3200' }))).toBe(false);
    expect(hasValidOrigin(request({ host: 'localhost:3200', origin: 'not a url' }))).toBe(false);
  });
});

describe('return-to validation', () => {
  it('allows local paths and rejects open redirects', () => {
    expect(safeReturnTo('/app/sites')).toBe('/app/sites');
    expect(safeReturnTo('//evil.example')).toBe('/app');
    expect(safeReturnTo('/\\evil.example')).toBe('/app');
    expect(safeReturnTo('https://evil.example')).toBe('/app');
    expect(safeReturnTo(null)).toBe('/app');
  });
});
