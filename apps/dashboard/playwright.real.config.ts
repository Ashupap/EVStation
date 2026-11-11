import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function readEnv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const vars: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

const compose = readEnv(path.join(repoRoot, 'infra/compose/.env'));
const appPassword = process.env.OUR_DB_APP_PASSWORD || compose.OUR_DB_APP_PASSWORD;
const dbPort = process.env.OUR_DB_HOST_PORT || compose.OUR_DB_HOST_PORT || '5432';

if (!appPassword) {
  throw new Error('real dashboard E2E needs OUR_DB_APP_PASSWORD or infra/compose/.env');
}

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

const apiEnv = {
  ...inheritedEnv,
  NODE_ENV: 'development',
  PORT: '4000',
  HOST: '127.0.0.1',
  TRUST_PROXY: 'false',
  DATABASE_URL_APP: `postgres://evstation_app:${encodeURIComponent(appPassword)}@localhost:${dbPort}/evstation`,
  OIDC_ISSUER: 'http://localhost:8180/realms/evstation',
  OIDC_AUDIENCE: 'evstation-api',
  INVITATION_ACCEPT_BASE_URL: 'http://localhost:3200/invitations/accept',
};

const dashboardEnv = {
  ...inheritedEnv,
  NODE_ENV: 'development',
  API_BASE_URL: 'http://127.0.0.1:4000',
  OIDC_ISSUER: 'http://localhost:8180/realms/evstation',
  OIDC_CLIENT_ID: 'dashboard',
  OIDC_CLIENT_SECRET: compose.KC_DASHBOARD_CLIENT_SECRET ?? '',
  OIDC_REDIRECT_URI: 'http://localhost:3200/auth/callback',
  SESSION_COOKIE_NAME: 'evstation_session',
  SESSION_ABSOLUTE_TTL_SECONDS: '28800',
  SESSION_IDLE_TTL_SECONDS: '1800',
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
};
delete dashboardEnv.DASHBOARD_E2E_MODE;

export default defineConfig({
  testDir: './test/e2e-real',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3200',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @evstation/api start',
      url: 'http://127.0.0.1:4000/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: apiEnv,
    },
    {
      command: 'pnpm dev',
      url: 'http://localhost:3200/login',
      reuseExistingServer: false,
      timeout: 120_000,
      env: dashboardEnv,
    },
  ],
});
