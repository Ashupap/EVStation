export interface DashboardConfig {
  nodeEnv: 'development' | 'test' | 'production';
  apiBaseUrl: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcRedirectUri: string;
  sessionCookieName: string;
  loginCookieName: string;
  sessionAbsoluteTtlSeconds: number;
  sessionIdleTtlSeconds: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  e2eMode: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`invalid dashboard configuration: ${name} is required`);
  return value;
}

function url(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`invalid dashboard configuration: ${name} must be a URL`);
  }
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim();
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`invalid dashboard configuration: ${name} must be true or false`);
}

export function dashboardUrl(config: DashboardConfig, path: string): URL {
  return new URL(path, config.oidcRedirectUri);
}

export function loadDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const nodeEnv = required(env, 'NODE_ENV') as DashboardConfig['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('invalid dashboard configuration: NODE_ENV is invalid');
  }

  const absoluteTtl = Number(env.SESSION_ABSOLUTE_TTL_SECONDS ?? '28800');
  if (!Number.isSafeInteger(absoluteTtl) || absoluteTtl < 60) {
    throw new Error(
      'invalid dashboard configuration: SESSION_ABSOLUTE_TTL_SECONDS must be at least 60',
    );
  }

  const idleTtl = Number(env.SESSION_IDLE_TTL_SECONDS ?? '1800');
  if (!Number.isSafeInteger(idleTtl) || idleTtl < 60) {
    throw new Error(
      'invalid dashboard configuration: SESSION_IDLE_TTL_SECONDS must be at least 60',
    );
  }

  const baseCookieName = (env.SESSION_COOKIE_NAME?.trim() || 'evstation_session').replace(
    /^__Host-/u,
    '',
  );
  if (!/^[A-Za-z0-9_-]+$/u.test(baseCookieName)) {
    throw new Error('invalid dashboard configuration: SESSION_COOKIE_NAME is invalid');
  }
  const cookieSecure = bool(env, 'COOKIE_SECURE', nodeEnv === 'production');
  const sessionCookieName = cookieSecure ? `__Host-${baseCookieName}` : baseCookieName;

  const config: DashboardConfig = {
    nodeEnv,
    apiBaseUrl: url(env, 'API_BASE_URL'),
    oidcIssuer: url(env, 'OIDC_ISSUER'),
    oidcClientId: required(env, 'OIDC_CLIENT_ID'),
    oidcClientSecret: required(env, 'OIDC_CLIENT_SECRET'),
    oidcRedirectUri: url(env, 'OIDC_REDIRECT_URI'),
    sessionCookieName,
    loginCookieName: `${sessionCookieName}_login`,
    sessionAbsoluteTtlSeconds: absoluteTtl,
    sessionIdleTtlSeconds: idleTtl,
    cookieSecure,
    trustProxy: bool(env, 'TRUST_PROXY', false),
    e2eMode: bool(env, 'DASHBOARD_E2E_MODE', false),
  };

  if (config.e2eMode && config.nodeEnv === 'production') {
    throw new Error(
      'invalid dashboard configuration: DASHBOARD_E2E_MODE is forbidden in production',
    );
  }
  if (config.nodeEnv === 'production') {
    for (const [name, value] of [
      ['API_BASE_URL', config.apiBaseUrl],
      ['OIDC_ISSUER', config.oidcIssuer],
      ['OIDC_REDIRECT_URI', config.oidcRedirectUri],
    ] as const) {
      if (new URL(value).protocol !== 'https:') {
        throw new Error(`invalid dashboard configuration: ${name} must use https in production`);
      }
    }
    if (!config.cookieSecure) {
      throw new Error('invalid dashboard configuration: COOKIE_SECURE must be true in production');
    }
  }

  return config;
}
