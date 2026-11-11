import { defineConfig } from '@playwright/test';

const dashboardEnv = {
  DASHBOARD_E2E_MODE: 'true',
  NODE_ENV: 'development',
  API_BASE_URL: 'http://127.0.0.1:4100',
  OIDC_ISSUER: 'http://127.0.0.1:8180/realms/evstation',
  OIDC_CLIENT_ID: 'dashboard',
  OIDC_CLIENT_SECRET: 'test-only-dashboard-secret',
  OIDC_REDIRECT_URI: 'http://127.0.0.1:3200/auth/callback',
  SESSION_COOKIE_NAME: 'evstation_session',
  SESSION_ABSOLUTE_TTL_SECONDS: '28800',
  COOKIE_SECURE: 'false',
};

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3200',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node test/e2e/mock-api.mjs',
      url: 'http://127.0.0.1:4100/_health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev',
      url: 'http://127.0.0.1:3200/login',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...process.env, ...dashboardEnv },
    },
  ],
});
