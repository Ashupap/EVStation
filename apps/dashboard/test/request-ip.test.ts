import { describe, expect, it } from 'vitest';
import type { DashboardConfig } from '../src/lib/config.js';
import { clientIp, endUserIp } from '../src/lib/request-ip.js';

function config(trustProxy: DashboardConfig['trustProxy']): DashboardConfig {
  return {
    nodeEnv: 'development',
    apiBaseUrl: 'http://localhost:4000',
    oidcIssuer: 'http://localhost:8180/realms/evstation',
    oidcClientId: 'dashboard',
    oidcClientSecret: 'secret',
    oidcRedirectUri: 'http://localhost:3200/auth/callback',
    sessionCookieName: 'evstation_session',
    loginCookieName: 'evstation_session_login',
    sessionAbsoluteTtlSeconds: 28800,
    sessionIdleTtlSeconds: 1800,
    cookieSecure: false,
    trustProxy,
    e2eMode: false,
  };
}

function headers(value?: string): Headers {
  const result = new Headers();
  if (value) result.set('x-forwarded-for', value);
  return result;
}

describe('client IP resolution', () => {
  it('ignores X-Forwarded-For when no proxy is trusted', () => {
    expect(clientIp(headers('198.51.100.1, 203.0.113.9'), config(false))).toBe('direct');
    expect(endUserIp(headers('198.51.100.1, 203.0.113.9'), config(false))).toBeUndefined();
  });

  it('uses the entry counted from the right and ignores a spoofed leftmost value', () => {
    const proxied = config(1);
    const value = '198.51.100.1, 203.0.113.9';
    expect(clientIp(headers(value), proxied)).toBe('203.0.113.9');
    expect(endUserIp(headers(value), proxied)).toBe('203.0.113.9');
  });

  it('separates two clients behind the same proxy', () => {
    const proxied = config(1);
    expect(clientIp(headers('203.0.113.9'), proxied)).toBe('203.0.113.9');
    expect(clientIp(headers('203.0.113.10'), proxied)).toBe('203.0.113.10');
  });

  it('walks multiple trusted hops from the right', () => {
    expect(clientIp(headers('198.51.100.1, 203.0.113.9, 10.0.0.1'), config(2))).toBe('203.0.113.9');
  });

  it('falls back to the shared bucket for missing, short or invalid forwarding data', () => {
    expect(clientIp(headers(), config(1))).toBe('direct');
    expect(clientIp(headers('10.0.0.1'), config(2))).toBe('direct');
    expect(clientIp(headers('not-an-ip'), config(1))).toBe('direct');
    expect(clientIp(headers('198.51.100.1, not-an-ip'), config(1))).toBe('direct');
  });

  it('accepts bracketed IPv6 entries', () => {
    expect(clientIp(headers('[2001:db8::1]'), config(1))).toBe('2001:db8::1');
  });
});
