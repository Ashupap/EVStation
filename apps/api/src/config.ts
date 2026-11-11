import { isIP } from 'node:net';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default('127.0.0.1'),
  TRUST_PROXY: z.string().default('false'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL_APP: z.string().min(1, 'DATABASE_URL_APP is required'),
  OIDC_ISSUER: z.url(),
  OIDC_AUDIENCE: z.string().default('evstation-api'),
  OIDC_JWKS_URI: z.url().optional(),
  INVITATION_ACCEPT_BASE_URL: z.url().default('http://localhost:3200/invitations/accept'),
});

export type ApiConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  trustProxy: false | number | string[];
  logLevel: string;
  databaseUrlApp: string;
  oidcIssuer: string;
  oidcAudience: string;
  oidcJwksUri: string;
  invitationAcceptBaseUrl: string;
};

function parseTrustProxy(raw: string): ApiConfig['trustProxy'] {
  const value = raw.trim();
  if (value === '' || value === 'false') return false;
  if (value === 'true') {
    throw new Error(
      'invalid API configuration: TRUST_PROXY must be a hop count or a comma-separated proxy/CIDR list',
    );
  }
  if (/^\d+$/u.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops) || hops < 1 || hops > 10) {
      throw new Error('invalid API configuration: TRUST_PROXY hop count must be between 1 and 10');
    }
    return hops;
  }

  const proxies = value.split(',').map((entry) => entry.trim());
  if (proxies.length === 0 || proxies.some((entry) => entry.length === 0)) {
    throw new Error('invalid API configuration: TRUST_PROXY contains an empty proxy entry');
  }
  for (const proxy of proxies) {
    const [address, prefix] = proxy.split('/');
    if (!address || !isIP(address)) {
      throw new Error(`invalid API configuration: TRUST_PROXY has an invalid address: ${proxy}`);
    }
    if (prefix !== undefined) {
      if (!/^\d+$/u.test(prefix) || Number(prefix) < 0 || Number(prefix) > 128) {
        throw new Error(`invalid API configuration: TRUST_PROXY has an invalid CIDR: ${proxy}`);
      }
      const maxPrefix = address.includes(':') ? 128 : 32;
      if (Number(prefix) > maxPrefix) {
        throw new Error(`invalid API configuration: TRUST_PROXY has an invalid CIDR: ${proxy}`);
      }
    }
  }
  return proxies;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`invalid API configuration: ${details.join('; ')}`);
  }
  const value = parsed.data;

  for (const name of ['DATABASE_URL_OWNER', 'DATABASE_URL_MIGRATOR'] as const) {
    if (env[name]) {
      throw new Error(`invalid API configuration: ${name} must not be set for the API runtime`);
    }
  }

  const jwksUri =
    value.OIDC_JWKS_URI ?? `${value.OIDC_ISSUER.replace(/\/$/, '')}/protocol/openid-connect/certs`;

  if (value.NODE_ENV === 'production') {
    for (const [name, url] of [
      ['OIDC_ISSUER', value.OIDC_ISSUER],
      ['OIDC_JWKS_URI', jwksUri],
    ] as const) {
      if (new URL(url).protocol !== 'https:') {
        throw new Error(`invalid API configuration: ${name} must use https in production`);
      }
    }
  }

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    trustProxy: parseTrustProxy(value.TRUST_PROXY),
    logLevel: value.LOG_LEVEL,
    databaseUrlApp: value.DATABASE_URL_APP,
    oidcIssuer: value.OIDC_ISSUER.replace(/\/$/, ''),
    oidcAudience: value.OIDC_AUDIENCE,
    oidcJwksUri: jwksUri,
    invitationAcceptBaseUrl: value.INVITATION_ACCEPT_BASE_URL.replace(/\/$/, ''),
  };
}
