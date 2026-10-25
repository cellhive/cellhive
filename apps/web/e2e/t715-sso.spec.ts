import { randomBytes } from 'node:crypto';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { FAKE_OIDC_NAME, MAIL_OIDC_NAME } from './fake-oidc';
import { expect, test, WORKER_ORG } from './fixtures';
import { api, apiSignIn, expectNoSeriousA11yViolations, ok, signInFirstAdmin } from './support';

/**
 * T715: signing in with SSO and connected accounts (CONTRACTS §27, BACKLOG
 * T715) against the fake OIDC provider the E2E global setup runs
 * (`fake-oidc.ts`, `OIDC_PROVIDERS=fake-idp,mail-idp`, `ALLOW_SIGNUP=true` on `fake-idp`):
 *
 * 1. an email that already has an account, not connected → the guidance
 *    on `/login?error=OIDC_ACCOUNT_EXISTS`, no session;
 * 2. the administrator connects the provider from the account menu (the
 *    provider is asked to authenticate again: `max_age=0`), signs out, opens
 *    an app page → `/login?next=…` → "Continue with Fake IdP" → the same
 *    user, on that page;
 * 3. a user created by the provider (no password) cannot disconnect its
 *    only connection: the explanation, keyboard only, axe;
 * 4. a password user connecting a provider account another user has →
 *    `/account/connections?error=IDENTITY_IN_USE`;
 * 5. unknown `?error=` values are never shown; Vietnamese at 375 px.
 */

const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = randomBytes(4).toString('hex');
const ADMIN_SUB = `admin-${RUN}`;
const JIT_SUB = `jit-${RUN}`;
const JIT_EMAIL = `jit-${RUN}@sso.example.test`;
const CONTINUE = `Continue with ${FAKE_OIDC_NAME}`;

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
let adminSession: Session | undefined;
let jitSession: Session | undefined;
let orgSlug = '';

async function newPage(
  browser: Browser,
  options: {
    readonly session?: Session | undefined;
    readonly language?: 'en' | 'vi';
    readonly viewport?: { width: number; height: number };
  } = {},
): Promise<Page> {
  const context = await browser.newContext({
    // The fake provider's certificate is self-signed.
    ignoreHTTPSErrors: true,
    viewport: options.viewport ?? { width: 1280, height: 900 },
    ...(options.session === undefined ? {} : { storageState: options.session }),
  });
  await context.addInitScript((language) => {
    window.localStorage.setItem('cellhive.language', language);
  }, options.language ?? 'en');
  return context.newPage();
}

/** The provider's sign-in form: who signs in. */
async function signInAtProvider(
  page: Page,
  user: { readonly sub: string; readonly email?: string; readonly name?: string },
): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Fake IdP' })).toBeVisible();
  await page.getByLabel('Subject').fill(user.sub);
  if (user.email !== undefined) await page.getByLabel('Email', { exact: true }).fill(user.email);
  if (user.name !== undefined) await page.getByLabel('Name').fill(user.name);
  await page.getByRole('button', { name: 'Sign in to Fake IdP' }).click();
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const page = await newPage(browser);
  await page.goto('/login');
  await signInFirstAdmin(page, ADMIN);
  const me = await ok<{ orgs: { slug: string }[] }>(page, 'GET', '/me');
  orgSlug = me.orgs[0]?.slug ?? '';
  // A retry of this file starts from no connection.
  const identities = await ok<{ items: { id: string }[] }>(page, 'GET', '/me/identities');
  for (const identity of identities.items) {
    await ok(page, 'DELETE', `/me/identities/${identity.id}`);
  }
  adminSession = await page.context().storageState();
  await page.context().close();
});

test('an email that has an account but no connection gets the guidance, no session', async ({
  browser,
}) => {
  const page = await newPage(browser);
  await page.goto('/login');
  const provider = page.getByRole('link', { name: CONTINUE });
  await expect(provider).toHaveAttribute('href', '/api/v1/auth/oidc/fake-idp/start');
  await expectNoSeriousA11yViolations(page, '/login with a provider');
  await provider.click();
  await signInAtProvider(page, { sub: `other-${RUN}`, email: ADMIN.email });
  await expect(page).toHaveURL(/\/login\?error=OIDC_ACCOUNT_EXISTS$/u);
  await expect(page.getByTestId('login-sso-error')).toHaveText(
    'An account with this email already exists. Sign in with your password, then connect the provider under "Connected accounts" in your account menu.',
  );
  await expectNoSeriousA11yViolations(page, '/login?error=OIDC_ACCOUNT_EXISTS');
  expect((await api(page, 'GET', '/me')).status).toBe(401);
  await page.context().close();
});

test('connect the provider from the account menu, then sign in with it and land on `next`', async ({
  browser,
}) => {
  const page = await newPage(browser, { session: adminSession });
  await page.goto(`/o/${orgSlug}`);
  await page
    .getByRole('button', { name: `Account menu for ${ADMIN.name}` })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Connected accounts' }).click();
  await expect(page).toHaveURL(/\/account\/connections$/u);
  await expect(page.getByRole('heading', { name: 'Connected accounts', level: 1 })).toBeVisible();
  await expect(page.getByText('No account is connected yet.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, '/account/connections, none connected');

  await page.getByRole('button', { name: `Connect ${FAKE_OIDC_NAME}` }).click();
  // Linking makes the provider authenticate again (CONTRACTS §27.3).
  await expect(page.getByTestId('fake-idp-max-age')).toHaveText('max_age: 0');
  await signInAtProvider(page, { sub: ADMIN_SUB, email: ADMIN.email });
  await expect(page).toHaveURL(/\/account\/connections$/u);
  const row = page.getByTestId('identity-row');
  await expect(row).toContainText(FAKE_OIDC_NAME);
  await expect(row).toContainText(ADMIN.email);
  await expect(row).toContainText('not used to sign in yet');
  // The stack's second provider (Mail IdP, T719) is still offered.
  await expect(page.getByRole('button', { name: `Connect ${MAIL_OIDC_NAME}` })).toBeVisible();
  await expect(page.getByText('Every identity provider of this server is connected.')).toHaveCount(
    0,
  );

  // Signed out, an app page asks to sign in first and is opened afterwards.
  // The session ends outside the app's own sign-out (an API call): the server
  // closes this tab's WebSocket with 4401 and the tab goes to the sign-in,
  // keeping where it was. Called from outside the page, whose navigation
  // would otherwise interrupt the call.
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'ob_csrf');
  const logout = await page.request.post('/api/v1/auth/logout', {
    headers: { 'X-CSRF-Token': decodeURIComponent(csrf?.value ?? '') },
  });
  expect(logout.status()).toBe(204);
  await expect(page).toHaveURL(
    new RegExp(`/login\\?next=${encodeURIComponent('/account/connections')}$`, 'u'),
  );
  const next = `/o/${orgSlug}/settings/notifications`;
  await page.goto(next);
  await expect(page).toHaveURL(/\/login\?next=/u);
  await page.getByRole('link', { name: CONTINUE }).click();
  await signInAtProvider(page, { sub: ADMIN_SUB });
  await expect(page).toHaveURL(new RegExp(`${next}$`, 'u'));
  const me = await ok<{ user: { email: string } }>(page, 'GET', '/me');
  expect(me.user.email).toBe(ADMIN.email);
  await page.goto('/account/connections');
  await expect(page.getByTestId('identity-row')).toContainText('last sign-in');
  adminSession = await page.context().storageState();
  await page.context().close();
});

test('a user without a password cannot disconnect its only connection (keyboard)', async ({
  browser,
}) => {
  const page = await newPage(browser);
  await page.goto('/login');
  await page.getByRole('link', { name: CONTINUE }).click();
  await signInAtProvider(page, { sub: JIT_SUB, email: JIT_EMAIL, name: 'Trần Thị Mai' });
  // A new account (ALLOW_SIGNUP) without an organization.
  await expect(page.getByRole('heading', { name: 'No organization' })).toBeVisible();
  jitSession = await page.context().storageState();

  await page.goto('/account/connections');
  const disconnect = page.getByRole('button', { name: `Disconnect ${FAKE_OIDC_NAME}` });
  await expect(disconnect).toBeVisible();
  await page.getByRole('heading', { name: 'Your connected accounts' }).click();
  // Keyboard only from here: Tab to "Disconnect", Enter, Tab to confirm, Enter.
  for (let presses = 0; presses < 10; presses += 1) {
    if (await disconnect.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(disconnect).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: `Disconnect ${FAKE_OIDC_NAME}?` });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Disconnect', exact: true });
  for (let presses = 0; presses < 5; presses += 1) {
    if (await confirm.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByTestId('last-login-method')).toContainText(
    'This is the only way you can sign in',
  );
  await expect(confirm).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'last login method explanation');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(disconnect).toBeFocused();
  await expect(page.getByTestId('identity-row')).toContainText(JIT_EMAIL);
  await page.context().close();
});

test('connecting a provider account another user has → IDENTITY_IN_USE', async ({ browser }) => {
  // A password user of the organization, invited by the administrator.
  const admin = await newPage(browser, { session: adminSession });
  await admin.goto('/login');
  const me = await ok<{ orgs: { id: string }[] }>(admin, 'GET', '/me');
  const email = `member-${RUN}@cellhive.test`;
  const invitation = await ok<{ invite_url: string }>(
    admin,
    'POST',
    `/orgs/${me.orgs[0]?.id ?? ''}/invitations`,
    { email, role: 'member' },
  );
  await admin.context().close();
  const page = await newPage(browser);
  await page.goto('/login');
  const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
  const password = 'E2E-Member-Password-2026';
  await ok(page, 'POST', `/invitations/${token}/accept`, { display_name: 'Lê Văn Bình', password });
  await apiSignIn(page, email, password);
  await page.goto('/account/connections');
  await page.getByRole('button', { name: `Connect ${FAKE_OIDC_NAME}` }).click();
  await signInAtProvider(page, { sub: JIT_SUB, email: JIT_EMAIL });
  await expect(page).toHaveURL(/\/account\/connections\?error=IDENTITY_IN_USE$/u);
  await expect(page.getByTestId('link-error')).toContainText(
    'This account of the provider is already connected to another Cellhive user',
  );
  await expect(page.getByText('No account is connected yet.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, '/account/connections?error=IDENTITY_IN_USE');
  await page.context().close();
});

test('unknown `?error=` values are never shown', async ({ browser }) => {
  const page = await newPage(browser);
  await page.goto('/login?error=CALL_555_0100%3Cb%3Ex%3C%2Fb%3E');
  await expect(page.getByTestId('login-sso-error')).toHaveText(
    'Sign-in did not complete. Try again.',
  );
  await expect(page.locator('body')).not.toContainText('555');
  await page.context().close();
});

test('Vietnamese at 375 px: sign-in errors and connected accounts', async ({ browser }) => {
  const viewport = { width: 375, height: 812 };
  const page = await newPage(browser, { language: 'vi', viewport });
  await page.goto('/login?error=UNAUTHENTICATED');
  await expect(page.getByRole('link', { name: `Tiếp tục với ${FAKE_OIDC_NAME}` })).toBeVisible();
  await expect(page.getByTestId('login-sso-error')).toHaveText(
    'Tài khoản của bạn đã bị vô hiệu hoá. Hãy liên hệ quản trị viên.',
  );
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, '/login 375 px vi');
  await page.context().close();

  const jit = await newPage(browser, { session: jitSession, language: 'vi', viewport });
  await jit.goto('/account/connections?error=OIDC_STATE_INVALID');
  await expect(jit.getByRole('heading', { name: 'Tài khoản đã kết nối', level: 1 })).toBeVisible();
  await expect(jit.getByTestId('link-error')).toContainText('Quá trình kết nối quá lâu');
  await expect(jit.getByTestId('identity-row')).toContainText(JIT_EMAIL);
  expect(await overflow(jit)).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(jit, '/account/connections 375 px vi');
  await jit.getByRole('button', { name: `Gỡ kết nối ${FAKE_OIDC_NAME}` }).click();
  await expect(jit.getByRole('alertdialog')).toBeVisible();
  expect(await overflow(jit)).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(jit, 'disconnect dialog 375 px vi');
  await jit.context().close();
});
