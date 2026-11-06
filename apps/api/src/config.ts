import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL_APP: z.string().min(1, 'DATABASE_URL_APP is required'),
  DATABASE_URL_OWNER: z.string().min(1).optional(),
  DATABASE_URL_MIGRATOR: z.string().min(1).optional(),
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
  databaseUrlOwner?: string;
  databaseUrlMigrator?: string;
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
  const jwksUri =
    value.OIDC_JWKS_URI ?? `${value.OIDC_ISSUER.replace(/\/$/, '')}/protocol/openid-connect/certs`;

  for (const [name, url] of [
    ['DATABASE_URL_OWNER', value.DATABASE_URL_OWNER],
    ['DATABASE_URL_MIGRATOR', value.DATABASE_URL_MIGRATOR],
  ] as const) {
    if (url && url === value.DATABASE_URL_APP) {
      throw new Error(`invalid API configuration: ${name} must differ from DATABASE_URL_APP`);
    }
  }

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    databaseUrlApp: value.DATABASE_URL_APP,
    databaseUrlOwner: value.DATABASE_URL_OWNER,
    databaseUrlMigrator: value.DATABASE_URL_MIGRATOR,
    oidcIssuer: value.OIDC_ISSUER.replace(/\/$/, ''),
    oidcAudience: value.OIDC_AUDIENCE,
    oidcJwksUri: jwksUri,
    invitationAcceptBaseUrl: value.INVITATION_ACCEPT_BASE_URL.replace(/\/$/, ''),
  };
}
