import { describe, expect, it } from 'vitest';
import { loadDashboardConfig } from '../src/lib/config.js';

const base = {
  NODE_ENV: 'development',
  API_BASE_URL: 'http://localhost:4000',
  OIDC_ISSUER: 'http://localhost:8180/realms/evstation',
  OIDC_CLIENT_ID: 'dashboard',
  OIDC_CLIENT_SECRET: 'secret',
  OIDC_REDIRECT_URI: 'http://localhost:3200/auth/callback',
  COOKIE_SECURE: 'false',
} as NodeJS.ProcessEnv;

describe('dashboard configuration', () => {
  it('derives the login cookie and defaults', () => {
    const config = loadDashboardConfig(base);
    expect(config.sessionCookieName).toBe('evstation_session');
    expect(config.loginCookieName).toBe('evstation_session_login');
    expect(config.sessionAbsoluteTtlSeconds).toBe(28800);
    expect(config.sessionIdleTtlSeconds).toBe(1800);
    expect(config.trustProxy).toBe(false);
    expect(config.e2eMode).toBe(false);
  });

  it('prefixes cookies with __Host- only when secure', () => {
    const config = loadDashboardConfig({
      ...base,
      NODE_ENV: 'production',
      API_BASE_URL: 'https://api.example.com',
      OIDC_ISSUER: 'https://id.example.com/realms/evstation',
      OIDC_REDIRECT_URI: 'https://console.example.com/auth/callback',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: '1',
    });
    expect(config.sessionCookieName).toBe('__Host-evstation_session');
    expect(config.loginCookieName).toBe('__Host-evstation_session_login');
  });

  it('does not double-prefix an explicit __Host- cookie name', () => {
    const config = loadDashboardConfig({
      ...base,
      NODE_ENV: 'production',
      API_BASE_URL: 'https://api.example.com',
      OIDC_ISSUER: 'https://id.example.com/realms/evstation',
      OIDC_REDIRECT_URI: 'https://console.example.com/auth/callback',
      COOKIE_SECURE: 'true',
      SESSION_COOKIE_NAME: '__Host-evstation_session',
      TRUST_PROXY: '1',
    });
    expect(config.sessionCookieName).toBe('__Host-evstation_session');
  });

  it('validates idle timeout and trust proxy hops', () => {
    expect(loadDashboardConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(() => loadDashboardConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/u);
    expect(() => loadDashboardConfig({ ...base, TRUST_PROXY: 'maybe' })).toThrow(/TRUST_PROXY/u);
    expect(() => loadDashboardConfig({ ...base, TRUST_PROXY: '11' })).toThrow(/TRUST_PROXY/u);
    expect(() => loadDashboardConfig({ ...base, SESSION_IDLE_TTL_SECONDS: '59' })).toThrow(
      /SESSION_IDLE_TTL_SECONDS/u,
    );
  });

  it('requires an explicit trust proxy hop count in production', () => {
    expect(() =>
      loadDashboardConfig({
        ...base,
        NODE_ENV: 'production',
        API_BASE_URL: 'https://api.example.com',
        OIDC_ISSUER: 'https://id.example.com/realms/evstation',
        OIDC_REDIRECT_URI: 'https://console.example.com/auth/callback',
        COOKIE_SECURE: 'true',
      }),
    ).toThrow(/TRUST_PROXY must be set/u);
  });

  it('rejects insecure production redirects and cookies', () => {
    expect(() =>
      loadDashboardConfig({
        ...base,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/max|https|COOKIE_SECURE/u);
  });

  it('accepts secure production configuration', () => {
    const config = loadDashboardConfig({
      ...base,
      NODE_ENV: 'production',
      API_BASE_URL: 'https://api.example.com',
      OIDC_ISSUER: 'https://id.example.com/realms/evstation',
      OIDC_REDIRECT_URI: 'https://console.example.com/auth/callback',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: '1',
    });
    expect(config.cookieSecure).toBe(true);
  });

  it('forbids the test-login escape hatch in production', () => {
    expect(() =>
      loadDashboardConfig({
        ...base,
        NODE_ENV: 'production',
        API_BASE_URL: 'https://api.example.com',
        OIDC_ISSUER: 'https://id.example.com/realms/evstation',
        OIDC_REDIRECT_URI: 'https://console.example.com/auth/callback',
        COOKIE_SECURE: 'true',
        TRUST_PROXY: '1',
        DASHBOARD_E2E_MODE: 'true',
      }),
    ).toThrow(/DASHBOARD_E2E_MODE/u);
  });

  it('requires the confidential client secret', () => {
    expect(() => loadDashboardConfig({ ...base, OIDC_CLIENT_SECRET: '' })).toThrow(
      /OIDC_CLIENT_SECRET/u,
    );
  });
});
