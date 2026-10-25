import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Request } from '@playwright/test';

import { WORKER_ORG } from './fixtures';
import { E2E_WEB_URL } from './ports';
import { runSeed } from './seed';

export interface ApiCallTracker {
  /** Resolves once no API call of the page is in flight and none started for `quietMs`. */
  idle(quietMs?: number): Promise<void>;
}

/**
 * Follows the page's `/api/v1/` calls from now on (attach it before the
 * navigation it should cover), so a spec can wait for the app to settle
 * instead of sleeping a fixed time (T319).
 */
export function trackApiCalls(page: Page): ApiCallTracker {
  const pending = new Set<Request>();
  let lastChange = Date.now();
  page.on('request', (request) => {
    if (!request.url().includes('/api/v1/')) return;
    pending.add(request);
    lastChange = Date.now();
  });
  const settle = (request: Request) => {
    if (pending.delete(request)) lastChange = Date.now();
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
  return {
    async idle(quietMs = 500) {
      await expect
        .poll(() => pending.size === 0 && Date.now() - lastChange >= quietMs, {
          timeout: 30_000,
          intervals: [100],
        })
        .toBe(true);
    },
  };
}

/**
 * Waits until the enter/exit animations and transitions of overlays (T322b
 * motion: 110–200 ms) are over, so that measures and colors are the final ones.
 * T421b: an animation may start a frame or two after the action that caused
 * it (an exit after a state change, `@starting-style` enter transitions, a
 * fade that starts when the previous one ends), so it waits two frames first
 * and then again until no finite animation runs any more (at most ~3 s).
 */
export async function animationsSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    const deadline = performance.now() + 3_000;
    for (;;) {
      await frame();
      await frame();
      const running = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === 'running' &&
            animation.effect?.getTiming().iterations !== Infinity,
        );
      if (running.length === 0 || performance.now() > deadline) return;
      await Promise.race([
        Promise.all(running.map((animation) => animation.finished.catch(() => undefined))),
        // A paused animation never finishes.
        new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - performance.now()))),
      ]);
    }
  });
}

/**
 * axe-core on the current page (FRONTEND §11.2): WCAG 2.x A/AA rules, and
 * no violation of impact "serious" or "critical" is allowed. Runs on the
 * settled page (a fading dialog would blend its colors).
 */
export async function expectNoSeriousA11yViolations(page: Page, label: string): Promise<void> {
  await animationsSettled(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  expect(serious, `axe violations on ${label}`).toEqual([]);
}

/**
 * Every piece of UI text on the page: visible text lines plus accessible
 * names given by attributes (aria-label, placeholder, title, alt).
 */
export async function uiTexts(page: Page): Promise<string[]> {
  const texts = await page.evaluate(() => {
    const lines = document.body.innerText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const attributes = [...document.querySelectorAll('[aria-label], [placeholder], [title], [alt]')]
      .flatMap((element) =>
        ['aria-label', 'placeholder', 'title', 'alt'].map((name) => element.getAttribute(name)),
      )
      .filter((value): value is string => value !== null && value.trim() !== '');
    return [...lines, ...attributes, document.title];
  });
  return [...new Set(texts)];
}

/** Records Content-Security-Policy violations reported by the browser. */
export function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
      violations.push(message.text());
    }
  });
  return violations;
}

/**
 * How long a helper keeps retrying `429`: the widest window of the limits a
 * spec meets (`POST /auth/login`, 20 a minute per IP) plus some slack. All
 * specs of a worker sign in from one client address (the worker's, T800)
 * and one set of demo users, so a spec can inherit a spent window from the
 * spec before it (T319).
 */
const RATE_LIMIT_DEADLINE_MS = 70_000;
/** Wait when a `429` carries no usable `Retry-After`. */
const DEFAULT_RETRY_MS = 2_000;

/**
 * Milliseconds to wait for a `Retry-After` value (delta-seconds or an
 * HTTP date), never past `deadline`, never less than a short pause.
 */
export function retryDelayMs(retryAfter: string | null | undefined, deadline: number): number {
  let wait = DEFAULT_RETRY_MS;
  if (retryAfter !== null && retryAfter !== undefined && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) wait = seconds * 1000 + 250;
    else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) wait = at - Date.now() + 250;
    }
  }
  return Math.max(250, Math.min(wait, deadline - Date.now()));
}

/**
 * Runs `attempt` again while it answers `429`, waiting for its `Retry-After`
 * (when the answer carries one) and giving up after ~70 s: the answer is
 * then returned as is and the caller's assertion reports it.
 */
export async function retryWhileRateLimited<
  T extends { status: number; retryAfter?: string | null },
>(attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + RATE_LIMIT_DEADLINE_MS;
  for (;;) {
    const answer = await attempt();
    if (answer.status !== 429 || Date.now() >= deadline) return answer;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(answer.retryAfter, deadline)));
  }
}

export interface ApiAnswer<T> {
  status: number;
  body: T;
  /** The `Retry-After` header of the response, if any. */
  retryAfter: string | null;
}

/**
 * One API call from inside the page, like the SPA: the browser keeps the
 * session cookie, and the CSRF token is the `ob_csrf` cookie echoed in
 * `X-CSRF-Token` (CONTRACTS §1.1). The page must be on the app origin.
 */
async function apiOnce<T>(
  page: Page,
  method: string,
  path: string,
  body: unknown,
): Promise<ApiAnswer<T>> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = document.cookie
        .split('; ')
        .find((cookie) => cookie.startsWith('ob_csrf='))
        ?.slice('ob_csrf='.length);
      const response = await fetch(`/api/v1${path}`, {
        method,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(csrf === undefined ? {} : { 'X-CSRF-Token': decodeURIComponent(csrf) }),
        },
        body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? null : (JSON.parse(text) as T),
        retryAfter: response.headers.get('retry-after'),
      };
    },
    { method, path, body },
  ) as Promise<ApiAnswer<T>>;
}

/** Opens the app origin first when the page is still blank (cookies, relative fetch). */
async function onAppOrigin(page: Page): Promise<void> {
  if (!page.url().startsWith(E2E_WEB_URL)) await page.goto('/login');
}

/**
 * An API call for test setup or checks (T319): same as the SPA, and a `429`
 * (per-IP sign-in limit, per-user/base write limits of SPEC §13.1) waits for
 * `Retry-After` and tries again instead of failing the spec.
 */
export async function api<T = Record<string, unknown>>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiAnswer<T>> {
  await onAppOrigin(page);
  return retryWhileRateLimited(() => apiOnce<T>(page, method, path, body));
}

/** {@link api} that must succeed (2xx); returns the body. */
export async function ok<T = Record<string, unknown>>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const answer = await api<T>(page, method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
}

/**
 * `POST /auth/login` from the page (session cookie + CSRF like the SPA) —
 * the one way specs sign in unless the login page itself is under test.
 * Sign-in is limited to 20 a minute per IP and every spec of a worker
 * shares the worker's client address: a `429` waits for its `Retry-After`
 * and tries again.
 */
export async function apiSignIn(page: Page, email: string, password: string): Promise<void> {
  const answer = await api(page, 'POST', '/auth/login', { email, password });
  expect(answer.status, `sign in as ${email}`).toBe(204);
}

export interface FirstAdmin {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

/**
 * Signs `page` in as the administrator of the specs that build their own
 * bases — the worker's `owner+w<n>@cellhive.test` ({@link WORKER_ORG},
 * BACKLOG T800), the only member of their own organization
 * (`e2e-w<n>-owner`), so `me.orgs[0]` is that organization. The first spec
 * of the worker that needs them creates them: the worker's demo
 * administrator invites them (their name and password), `cellhive org
 * create` gives them their organization (the stack defaults, `en`/UTC, like
 * `/setup`), and they leave the demo organization again — so their bases
 * never sit next to the demo users and their names.
 */
export async function signInFirstAdmin(page: Page, admin: FirstAdmin): Promise<void> {
  // The account is shared by every spec of the worker: whichever runs first creates it.
  expect(admin, 'the administrator of the worker is the same for every spec').toMatchObject({
    email: WORKER_ORG.ownerEmail,
    name: WORKER_ORG.ownerName,
  });
  const first = await api(page, 'POST', '/auth/login', {
    email: admin.email,
    password: admin.password,
  });
  if (first.status === 204) return;
  expect(first.status, `sign in as ${admin.email}`).toBe(401);
  await apiSignIn(page, WORKER_ORG.email('admin'), WORKER_ORG.password);
  const me = await ok<{ orgs: { id: string; name: string }[] }>(page, 'GET', '/me');
  const demoOrg = me.orgs.find((item) => item.name === WORKER_ORG.orgName)?.id ?? '';
  expect(demoOrg, `the organization ${WORKER_ORG.orgName}`).not.toBe('');
  const invitation = await ok<{ invite_url: string }>(
    page,
    'POST',
    `/orgs/${demoOrg}/invitations`,
    { email: admin.email, role: 'admin' },
  );
  await ok(page, 'POST', '/auth/logout');
  const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
  // Accepting creates the account (and signs it in).
  const accepted = await ok<{ user: { id: string } }>(
    page,
    'POST',
    `/invitations/${token}/accept`,
    { display_name: admin.name, password: admin.password },
  );
  await ok(page, 'POST', '/auth/logout');
  await runSeed('cli.js', [
    'org',
    'create',
    '--name',
    WORKER_ORG.ownerOrgName,
    '--owner-email',
    admin.email,
  ]);
  await apiSignIn(page, WORKER_ORG.email('admin'), WORKER_ORG.password);
  await ok(page, 'DELETE', `/orgs/${demoOrg}/members/${accepted.user.id}`);
  await ok(page, 'POST', '/auth/logout');
  await apiSignIn(page, admin.email, admin.password);
}
