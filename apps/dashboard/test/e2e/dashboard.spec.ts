import { expect, test, type Page } from '@playwright/test';

const TENANT_B = '10000000-0000-4000-8000-000000000002';

async function login(page: Page, persona = 'admin'): Promise<void> {
  await page.goto(`/auth/test-login?persona=${persona}`);
  await expect(page).toHaveURL(/\/app$/u);
}

function browserStorage(page: Page) {
  return page.evaluate(() => ({
    cookie: document.cookie,
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
    body: document.body.innerText,
  }));
}

test('signs in with an opaque cookie and never exposes tokens to the browser', async ({
  page,
  context,
}) => {
  await login(page);

  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === 'evstation_session');
  expect(session).toBeTruthy();
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Lax');
  expect(session?.secure).toBe(false);
  expect(session?.value).not.toContain('test-access-token');

  const storage = await browserStorage(page);
  expect(storage.cookie).not.toContain('test-access-token');
  expect(storage.local).not.toContain('test-access-token');
  expect(storage.session).not.toContain('test-access-token');
  expect(storage.body).not.toContain('test-access-token');
});

test('logs out locally and clears the session cookie', async ({ page, context }) => {
  await login(page);
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login$/u);

  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === 'evstation_session')).toBeUndefined();
});

test('hides tenant-admin navigation from a viewer and blocks the direct route', async ({
  page,
}) => {
  await login(page, 'viewer');
  await expect(page.getByTestId('nav-sites')).toBeVisible();
  await expect(page.getByTestId('nav-users')).toHaveCount(0);
  await expect(page.getByTestId('nav-invitations')).toHaveCount(0);

  await page.goto('/app/users');
  await expect(page).toHaveURL(/\/app$/u);
});

test('switches tenant context through the CSRF-protected BFF', async ({ page }) => {
  await login(page, 'multitenant');
  await page.getByLabel('Tenant').selectOption(TENANT_B);
  await page.getByTestId('tenant-switch').click();
  await expect(page).toHaveURL(/\/app$/u);
  await expect(page.getByText('Tenant Beta').first()).toBeVisible();

  await page.goto('/app/sites');
  await expect(page.getByText('Central Charging Hub')).toBeVisible();
});

test('redirects to sign-in when the server-side session has expired', async ({ page }) => {
  await page.goto('/auth/test-login?persona=expired');
  await expect(page).toHaveURL(/\/login(?:\?|$)/u);
  await expect(page.getByTestId('login')).toBeVisible();
});

test('rejects state-changing BFF requests with a foreign Origin', async ({ page }) => {
  await login(page);
  const response = await page.context().request.post('/api/tenant', {
    headers: { origin: 'http://evil.example' },
    form: { tenantId: TENANT_B },
  });
  expect(response.status()).toBe(403);

  await page.goto('/app');
  await expect(page.getByText('Tenant Alpha').first()).toBeVisible();
});

test('sets hardened security headers with a nonce on page responses', async ({ page }) => {
  const response = await page.goto('/login');
  const headers = response?.headers() ?? {};
  const csp = headers['content-security-policy'] ?? '';

  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/u);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("form-action 'self'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('same-origin');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['permissions-policy']).toContain('camera=()');

  await expect(page.locator('script[nonce]').first()).toHaveCount(1);
  const nonce = await page.evaluate(() => document.querySelector('script[nonce]')?.nonce ?? '');
  expect(nonce).toBeTruthy();
  expect(csp).toContain(`'nonce-${nonce}'`);
});

test('never redirects a malicious returnTo off the dashboard origin', async ({ page }) => {
  const response = await page.context().request.get('/auth/login?returnTo=//evil.example', {
    maxRedirects: 0,
  });
  const location = response.headers()['location'] ?? '';
  expect(location.startsWith('http://evil.example')).toBe(false);
  expect(location.startsWith('https://evil.example')).toBe(false);
});

test('rejects logout CSRF and keeps the session active', async ({ page }) => {
  await login(page);
  const response = await page.context().request.post('/auth/logout', {
    headers: { origin: 'http://evil.example' },
  });
  expect(response.status()).toBe(403);

  await page.goto('/app');
  await expect(page.getByText('Tenant Alpha').first()).toBeVisible();
});

test('rejects invitation acceptance CSRF without calling the API', async ({ page }) => {
  await login(page, 'viewer');
  const response = await page.context().request.post('/api/invitations/accept', {
    headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
    data: { token: 'good-invitation-token-1234567890' },
  });
  expect(response.status()).toBe(403);

  const last = await page.context().request.get('http://127.0.0.1:4100/_debug/last');
  const request = (await last.json()) as { path: string };
  expect(request.path).not.toBe('/invitations/accept');
});

test('forwards the access token, request id and end-user IP to the API only', async ({
  page,
  context,
}) => {
  await context.setExtraHTTPHeaders({
    'x-forwarded-for': '203.0.113.9',
    'x-request-id': 'e2e-request-id',
  });
  await login(page);

  const last = await page.context().request.get('http://127.0.0.1:4100/_debug/last');
  expect(last.ok()).toBe(true);
  const request = (await last.json()) as {
    path: string;
    headers: Record<string, string>;
  };
  expect(request.path).toBe('/me');
  expect(request.headers.authorization).toBe('Bearer test-access-token-admin');
  expect(request.headers['x-request-id']).toBe('e2e-request-id');
  expect(request.headers['x-forwarded-for']).toBe('203.0.113.9');
});

test('accepts an invitation using only the URL fragment token', async ({ page }) => {
  await login(page, 'viewer');
  const token = 'good-invitation-token-1234567890';
  await page.goto(`/invitations/accept#token=${token}`);
  await expect(page.getByTestId('invitation-accepted')).toBeVisible();
  await expect(page).not.toHaveURL(/#/u);

  const storage = await browserStorage(page);
  expect(storage.cookie).not.toContain(token);
  expect(storage.local).not.toContain(token);
  expect(storage.session).not.toContain(token);
  expect(storage.body).not.toContain(token);

  const last = await page.context().request.get('http://127.0.0.1:4100/_debug/last');
  const request = (await last.json()) as { path: string; body: string };
  expect(request.path).toBe('/invitations/accept');
  expect(request.body).toContain(token);
});

test('blocks an unverified email before the console', async ({ page }) => {
  await page.goto('/auth/test-login?persona=unverified');
  await expect(page).toHaveURL(/\/unverified-email$/u);
  await expect(page.getByText('Verify your email address')).toBeVisible();
});

test('keeps the active tenant in the server-side session', async ({ page }) => {
  await login(page, 'viewer');
  await expect(page.getByText('Tenant Alpha').first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('Tenant Alpha').first()).toBeVisible();
});
