import { test as base } from '@playwright/test';

import { DEMO_PASSWORD, runSeed } from './seed';

export { expect } from '@playwright/test';

/** Demo user of CONTRACTS §9 by the local part of its email (`u_editor` → `editor`). */
export type DemoUserKey = 'admin' | 'editor' | 'reader' | 'sales1' | 'sales2' | 'out';

/**
 * The organization of one Playwright worker on the shared E2E stack
 * (BACKLOG T800, FRONTEND §11.2): the full demo data of CONTRACTS §9 seeded
 * by `seed:demo --org e2e-w<n> --email-tag w<n>` — same base, tables, views,
 * roles, automations and tokens, users `admin+w<n>@demo.cellhive.local`, … —
 * and the administrator of the specs that build their own bases
 * (`owner+w<n>@cellhive.test`, an admin of that organization).
 */
export interface WorkerOrg {
  /** Parallel slot of the worker (`0 … workers − 1`). */
  readonly slot: number;
  /** `w<slot>`: the email tag. */
  readonly tag: string;
  /** Organization name (and slug): `e2e-w<slot>`. */
  readonly orgName: string;
  readonly orgSlug: string;
  /** Password of every demo user (development only, CONTRACTS §9). */
  readonly password: string;
  /** Email of a demo user of this organization. */
  email(key: DemoUserKey): string;
  /** Email of the administrator of the specs that build their own bases. */
  readonly ownerEmail: string;
  /**
   * Display name of that administrator. One name for every spec: the first
   * spec of the worker creates the account with it and the others find it
   * (a spec asserting "Account menu for …" must not depend on which ran first).
   */
  readonly ownerName: string;
  /**
   * Their own organization (`e2e-w<slot>-owner`, made with `cellhive org
   * create`, stack defaults `en`/UTC like `/setup`): the bases those specs
   * build never sit next to the demo users and their names.
   */
  readonly ownerOrgName: string;
  /**
   * Client address of the worker's browsers (`198.51.100.<slot + 1>`,
   * TEST-NET-2), sent as `X-Forwarded-For`: the `vite preview` proxy appends
   * its own hop (`xfwd`) and the API trusts loopback proxies
   * (`TRUSTED_PROXIES` default), so the per-IP limits (sign-in 20 a minute,
   * failed Bearer, share links) count each worker as its own client, like
   * two people on two networks, instead of two workers draining one window.
   */
  readonly clientIp: string;
}

/** The {@link WorkerOrg} of a parallel slot. */
export function workerOrgFor(slot: number): WorkerOrg {
  const tag = `w${String(slot)}`;
  return {
    slot,
    tag,
    orgName: `e2e-${tag}`,
    orgSlug: `e2e-${tag}`,
    password: DEMO_PASSWORD,
    email: (key) => `${key}+${tag}@demo.cellhive.local`,
    ownerEmail: `owner+${tag}@cellhive.test`,
    ownerName: 'Nguyễn Văn Ánh',
    ownerOrgName: `e2e-${tag}-owner`,
    clientIp: `198.51.100.${String(slot + 1)}`,
  };
}

/**
 * Parallel slot of this worker process. Playwright sets `TEST_PARALLEL_INDEX`
 * before it loads the spec files, and two live workers never share one; a
 * worker started again after a failure keeps the slot, so it reuses the
 * organization instead of seeding a new one. (Outside a worker — listing the
 * tests — it is 0; nothing runs there.)
 */
export function workerSlot(): number {
  const slot = Number(process.env['TEST_PARALLEL_INDEX'] ?? '0');
  return Number.isInteger(slot) && slot >= 0 ? slot : 0;
}

/**
 * The organization of this worker, for module-level constants and helpers
 * of a spec. The same value as the `workerOrg` fixture, which also makes
 * sure the organization is seeded before the first hook of the spec.
 */
export const WORKER_ORG: WorkerOrg = workerOrgFor(workerSlot());

/**
 * `test` of every spec on the shared stack: the worker fixture `workerOrg`
 * seeds the worker's organization once (`seed:demo` with the worker's org
 * and tag; a second run finds it complete and changes nothing) before the
 * first hook or test of the worker. Specs read users, org and base names
 * from it (or {@link WORKER_ORG}), never from the demo constants of
 * `seed.ts`, which stay the documented ones of the specs with a stack of
 * their own.
 */
export const test = base.extend<object, { workerOrg: WorkerOrg }>({
  // Every context of the worker, `browser.newContext()` in hooks included.
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    await use({ ...extraHTTPHeaders, 'X-Forwarded-For': WORKER_ORG.clientIp });
  },
  workerOrg: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixture's dependencies from this pattern.
    async ({}, use) => {
      await runSeed('seed.js', ['--org', WORKER_ORG.orgName, '--email-tag', WORKER_ORG.tag]);
      await use(WORKER_ORG);
    },
    { scope: 'worker', auto: true, timeout: 300_000 },
  ],
});
