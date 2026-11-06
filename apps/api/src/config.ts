import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
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
  logLevel: string;
  databaseUrlApp: string;
  oidcIssuer: string;
  oidcAudience: string;
  oidcJwksUri: string;
  invitationAcceptBaseUrl: string;
};

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

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    databaseUrlApp: value.DATABASE_URL_APP,
    oidcIssuer: value.OIDC_ISSUER.replace(/\/$/, ''),
    oidcAudience: value.OIDC_AUDIENCE,
    oidcJwksUri: jwksUri,
    invitationAcceptBaseUrl: value.INVITATION_ACCEPT_BASE_URL.replace(/\/$/, ''),
  };
}
