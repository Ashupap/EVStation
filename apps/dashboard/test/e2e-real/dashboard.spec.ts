import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env.E2E_USER_PASSWORD || 'evstation-dev-password';

async function signInWithKeycloak(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login').click();
  await page.waitForURL(/\/realms\/evstation\/protocol\/openid-connect\/auth/u);
  await page.locator('#username').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
  await expect(page).toHaveURL(/\/app$/u);
}

test('signs in through real Keycloak without exposing tokens to the browser', async ({
  page,
  context,
}) => {
  await signInWithKeycloak(page, 'admin@acme.example');
  await expect(page.getByText('Acme Charging').first()).toBeVisible();

  const session = (await context.cookies()).find((cookie) => cookie.name === 'evstation_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Lax');
  expect(session?.value).not.toContain('eyJ');

  const browser = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
    cookie: document.cookie,
    body: document.body.innerText,
  }));
  expect(browser.cookie).not.toContain('eyJ');
  expect(browser.local).not.toContain('eyJ');
  expect(browser.session).not.toContain('eyJ');
  expect(browser.body).not.toContain('eyJ');
});

test('logs out through Keycloak and clears the server-side session', async ({ page, context }) => {
  await signInWithKeycloak(page, 'admin@acme.example');
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login(?:[?#]|$)/u);

  const session = (await context.cookies()).find((cookie) => cookie.name === 'evstation_session');
  expect(session).toBeUndefined();
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login(?:[?#]|$)/u);
});

test('real Keycloak user permissions match the seeded viewer role', async ({ page }) => {
  await signInWithKeycloak(page, 'viewer@acme.example');
  await expect(page.getByTestId('nav-sites')).toBeVisible();
  await expect(page.getByTestId('nav-users')).toHaveCount(0);
  await page.goto('/app/users');
  await expect(page).toHaveURL(/\/app$/u);
});
