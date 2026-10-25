import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

import { E2E_WEB_URL } from './e2e/ports';

/**
 * E2E tests (FRONTEND §11.2). `e2e/global-setup.ts` starts PostgreSQL and
 * Valkey with Testcontainers, migrates, runs the built API and serves the
 * production build with `vite preview` (same security headers as nginx).
 * Run from the repository root with `pnpm test:e2e` (builds first).
 *
 * Parallel (BACKLOG T800): each worker has its own organization seeded with
 * the demo data (`e2e/fixtures.ts`), so spec files run two at a time on the
 * one stack (`E2E_WORKERS` overrides the count). Three projects, in order:
 * - `fresh-instance`: T011, which needs an instance nobody has set up yet;
 * - `parallel`: every other spec;
 * - `instance`: specs tagged `@instance` (they change or read what the whole
 *   instance shares) and specs that start containers of their own, one at a
 *   time once `parallel` is done.
 */
const PERF = process.env['E2E_PERF'] === '1';
const WORKERS = Number(process.env['E2E_WORKERS'] ?? 2);
const FRESH_INSTANCE = /t011\.spec\.ts$/u;
const E2E_DIR = fileURLToPath(new URL('./e2e/', import.meta.url));
/**
 * Specs with a stack of their own (they import Testcontainers). Starting or
 * stopping a container adds or removes network interfaces on a Linux host
 * (veth, bridge), and Chromium fails every request still waiting for a
 * socket with `net::ERR_NETWORK_CHANGED` — in the other worker's browser
 * too (a page load whose lazy chunks fail stays blank). So these never run
 * next to another spec: they go to the serial `instance` project, whatever
 * their tags (FRONTEND §11.2).
 */
const OWN_CONTAINERS = readdirSync(E2E_DIR)
  .filter(
    (name) =>
      name.endsWith('.spec.ts') &&
      /from '(?:testcontainers|@testcontainers\/[\w-]+)'/u.test(
        readFileSync(`${E2E_DIR}${name}`, 'utf8'),
      ),
  )
  .map((name) => name.replaceAll('.', '\\.'));
const chrome = { ...devices['Desktop Chrome'] };

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Performance budgets on 200 000 seeded rows (@perf) run on their own, one at a
  // time: `pnpm test:e2e:perf`.
  workers: PERF ? 1 : WORKERS,
  forbidOnly: process.env['CI'] !== undefined,
  // A perf number is measured once: a retry would hide a red budget (BACKLOG T801).
  retries: process.env['CI'] === undefined || PERF ? 0 : 1,
  reporter: [
    ...(process.env['CI'] === undefined
      ? ([['list']] as const)
      : ([
          ['github'],
          [
            'html',
            {
              open: 'never',
              // CI runs the instance project into a report of its own.
              outputFolder: process.env['PLAYWRIGHT_HTML_OUTPUT_DIR'] ?? 'playwright-report',
            },
          ],
        ] as const)),
    // `perf-results.json` + the job summary of the nightly `perf` workflow (FRONTEND §11.1).
    ...(PERF ? ([['./e2e/perf-reporter.ts']] as const) : []),
  ],
  use: {
    baseURL: E2E_WEB_URL,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  projects: PERF
    ? [{ name: 'chromium', grep: /@perf/u, use: chrome }]
    : [
        { name: 'fresh-instance', testMatch: FRESH_INSTANCE, workers: 1, use: chrome },
        {
          name: 'parallel',
          testIgnore: [
            FRESH_INSTANCE,
            ...OWN_CONTAINERS.map((file) => new RegExp(`${file}$`, 'u')),
          ],
          grepInvert: /@perf|@instance/u,
          dependencies: ['fresh-instance'],
          use: chrome,
        },
        {
          name: 'instance',
          testIgnore: FRESH_INSTANCE,
          // `grep` sees the file name too: tagged tests, and every test of an own-stack spec.
          grep: [/@instance/u, ...OWN_CONTAINERS.map((file) => new RegExp(file, 'u'))],
          grepInvert: /@perf/u,
          workers: 1,
          dependencies: ['parallel'],
          use: chrome,
        },
      ],
});
