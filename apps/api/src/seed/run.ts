import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import { ConfigError, loadConfig, type AppConfig, type Env } from '@cellhive/server-core';
import { NestFactory } from '@nestjs/core';
import { destination, pino, type Logger } from 'pino';

import { AppModule } from '../app.module.js';
import { NestLoggerAdapter } from '../common/logging/app-logger.js';
import { rootLoggerOptions } from '../common/logging/root-logger.js';

import {
  DEFAULT_DEMO_PROFILE,
  DEMO_BASE,
  DEMO_EMAIL_TAG_PATTERN,
  DEMO_ORG,
  DEMO_PASSWORD,
  DEMO_USERS,
  demoUsersOf,
  type DemoProfile,
  type DemoUserKey,
} from './demo-fixture.js';
import { DEMO_API_TOKEN } from './demo-s6.js';
import { DEMO_COLOR_RULE, DEMO_DASHBOARD } from './demo-s7.js';
import { DemoSeeder, type DemoSeedOptions, type DemoSeedResult } from './demo-seeder.js';
import { DEMO_INCOMING_WEBHOOK } from './demo-webhooks.js';
import { SeedError } from './seed-error.js';
import { SeedMailer } from './seed-mailer.js';

import type { INestApplicationContext } from '@nestjs/common';

/** Where the seed writes: `out` for the summary, `err` for messages. */
export interface SeedIo {
  out(line: string): void;
  err(line: string): void;
}

export const SEED_USAGE = `Usage: pnpm seed:demo [--force] [--org <name> --email-tag <tag>]

Creates the demo organization "${DEMO_ORG.name}" (CONTRACTS §9): six users, the
group Sales, a workspace and the base "${DEMO_BASE.name}" with the tables
Customers (200), Tickets (2 000, with a small sub-record tree and a sample
attachment on a few tickets), Orders (5 000, linked to Customers) and
Chi tiết đơn hàng (order lines, linked to Orders both ways), formula and
lookup fields computed on the spot (no worker needed), saved views
(grid, Kanban with a cover image, form), sample automations with three
sender identities (not verified) and a Telegram bot (fake token), assignment
notifications on "Phụ trách"/owner, a due-date reminder on Tickets "Hạn" and a
few follows (nothing is notified about the sample data), the incoming
webhook "Đơn từ website" (Bearer; its token printed once, in development)
with an automation creating orders and a sample HTTP request automation
(both off), the HTTP allowlist entry n8n.local:5678, the custom role Sales
given to the group and, in development, a public link to the support form
and an organization link to the open tickets. Every demo user gets the
password ${DEMO_PASSWORD}. No email is sent and no HTTP request is made.

Running it again when the demo data exists changes nothing. Half-created demo
data (an interrupted run) is not repaired: reset the database instead.

  --force   Run although NODE_ENV=production. The demo password is never used
            there: each user gets a random password, printed once. No share
            link is created.

  --org <name> --email-tag <tag>
            Another demo organization next to the default one (the E2E suite
            seeds one per Playwright worker): the same data in the
            organization <name>, every user's email tagged
            (admin+<tag>@demo.cellhive.local). <tag>: lower-case letters,
            digits and dashes. Given together.

The environment is the server's (DATABASE_URL, CACHE_URL, …); run
\`pnpm db:migrate\` first.`;

const RESET_HINT =
  'To start over in development: pnpm dev:infra:down && pnpm dev:infra && pnpm db:migrate && pnpm seed:demo';

/** SQLSTATE `undefined_table`: the migrations have not run. */
const UNDEFINED_TABLE = '42P01';

export interface SeedOptions {
  readonly force: boolean;
  /** Which demo organization to create (default: CONTRACTS §9). */
  readonly profile: DemoProfile;
}

/** Parses the arguments; `help` for `--help`. */
export function parseSeedArgs(argv: readonly string[]): SeedOptions | 'help' {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        org: { type: 'string' },
        'email-tag': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    throw new SeedError(
      `${error instanceof Error ? error.message : String(error)}\n\n${SEED_USAGE}`,
    );
  }
  if (values.help === true) return 'help';
  return { force: values.force === true, profile: profileOf(values.org, values['email-tag']) };
}

function profileOf(org: string | undefined, tag: string | undefined): DemoProfile {
  if (org === undefined && tag === undefined) return DEFAULT_DEMO_PROFILE;
  if (org === undefined || tag === undefined) {
    throw new SeedError(`--org and --email-tag go together.\n\n${SEED_USAGE}`);
  }
  const name = org.trim();
  if (name === '' || name.length > 100) {
    throw new SeedError(`--org must be 1 to 100 characters.\n\n${SEED_USAGE}`);
  }
  if (!DEMO_EMAIL_TAG_PATTERN.test(tag)) {
    throw new SeedError(
      `--email-tag must be lower-case letters, digits and dashes.\n\n${SEED_USAGE}`,
    );
  }
  return { orgName: name, emailTag: tag };
}

/**
 * The password of each demo user: the documented demo password in
 * development and tests; in production (only with `--force`) a random one
 * per user, so that a known password never guards a production account.
 */
export function demoPasswords(config: AppConfig): ReadonlyMap<DemoUserKey, string> {
  const production = config.nodeEnv === 'production';
  return new Map(
    DEMO_USERS.map((user) => [
      user.key,
      production ? `Ob-${randomBytes(18).toString('base64url')}` : DEMO_PASSWORD,
    ]),
  );
}

/** The summary table: who can sign in, with which password, for what. */
export function summaryLines(
  config: AppConfig,
  result: DemoSeedResult,
  passwords: ReadonlyMap<DemoUserKey, string> | null,
  profile: DemoProfile = DEFAULT_DEMO_PROFILE,
): string[] {
  const rows = demoUsersOf(profile).map((user) => [
    user.key,
    user.email,
    user.displayName,
    passwords?.get(user.key) ?? '(unchanged)',
    user.note,
  ]);
  const header = ['Key', 'Email', 'Name', 'Password', 'Access'];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    `Organization: ${profile.orgName} (${result.organizationId})`,
    `Base:         ${DEMO_BASE.name} (${result.baseId})`,
    `Tables:       Customers (${result.tables.customers}), Tickets (${result.tables.tickets}), Orders (${result.tables.orders}), Chi tiết đơn hàng (${result.tables.orderLines})`,
    `Sign in at:   ${config.publicUrl}`,
    '',
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
    ...s5Lines(result.s5),
    ...s5bLines(result.s5b),
    ...s5cLines(result, config.nodeEnv !== 'production'),
    ...s6Lines(result, config.nodeEnv !== 'production'),
    ...s7Lines(result),
    ...shareLinkLines(result.shareLinks),
  ];
}

/** The S5 samples of the run (BACKLOG T519): automations and sender identities. */
function s5Lines(s5: DemoSeedResult['s5']): string[] {
  if (s5 === null) return [];
  const on = s5.automations.filter((automation) => automation.enabled).length;
  return [
    '',
    `Automations (${String(s5.automations.length)}, ${String(on)} on):`,
    ...s5.automations.map(
      (automation) => `  ${automation.enabled ? 'on ' : 'off'}  ${automation.name}`,
    ),
    'Sender identities (not verified: verify them in Settings › Sender identities):',
    ...s5.identities.map(
      (identity) => `  ${identity.name} <${identity.email}>  ${identity.mode}, ${identity.status}`,
    ),
  ];
}

/** The S5b samples of the run (BACKLOG T557): assignment notifications, reminder, follows. */
function s5bLines(s5b: DemoSeedResult['s5b']): string[] {
  if (s5b === null) return [];
  const follows = Object.entries(s5b.follows)
    .map(([user, count]) => `${user} ${String(count)}`)
    .join(', ');
  return [
    `Assignment notifications: ${s5b.assignFields.join(', ')}`,
    `Due-date reminder: ${s5b.reminder} (the day before at 09:00, to the person in charge)`,
    `Sample follows: ${follows}`,
  ];
}

/**
 * The S5c samples (BACKLOG T615): the incoming webhook — its Bearer token
 * printed only by the run that created it, and only in development (it is
 * never stored in clear) —, the allowlist entry and the two automations.
 */
function s5cLines(result: DemoSeedResult, showToken: boolean): string[] {
  const s5c = result.s5c;
  if (s5c === null) {
    return [
      '',
      `Incoming webhook "${DEMO_INCOMING_WEBHOOK.name}": its URL is in the base settings › Webhooks;`,
      'the Bearer token was printed by the run that created it (replace it there).',
    ];
  }
  return [
    '',
    `Automations with webhooks and HTTP (${String(s5c.automations.length)}, all off):`,
    ...s5c.automations.map(
      (automation) => `  ${automation.enabled ? 'on ' : 'off'}  ${automation.name}`,
    ),
    `HTTP allowlist: ${s5c.allowlist.join(', ')}`,
    `Incoming webhook "${s5c.hookName}" (Bearer${showToken ? ', shown only once' : ''}):`,
    `  URL    ${s5c.hookUrl}`,
    showToken
      ? `  Token  ${s5c.bearerToken}`
      : '  Token  not printed in production: replace it in the base settings › Webhooks.',
  ];
}

/**
 * The S6 samples (BACKLOG T719): the API token of u_admin — its value
 * printed only by the run that created it, and only in development (it is
 * stored as a hash) —, the revoked token, the HTTP secret and the role "Kho".
 */
function s6Lines(result: DemoSeedResult, showToken: boolean): string[] {
  const s6 = result.s6;
  if (s6 === null) {
    return [
      '',
      `API token "${DEMO_API_TOKEN.name}": the value was printed by the run that created it;`,
      'create a new one in Settings › API tokens.',
    ];
  }
  const expires = s6.apiToken.expiresAt === null ? 'never' : s6.apiToken.expiresAt.slice(0, 10);
  return [
    '',
    `API token "${s6.apiToken.name}" of u_admin (${s6.apiToken.scopes.join(' + ')}, this base only, expires ${expires}${showToken ? ', shown only once' : ''}):`,
    showToken
      ? `  Token  ${s6.apiToken.token}`
      : '  Token  not printed in production: create a new one in Settings › API tokens.',
    `Revoked API token: "${s6.revokedTokenName}"`,
    `HTTP secret "${s6.secret.name}": allowed hosts ${s6.secret.allowedHosts.join(', ')}`,
    `Role "${s6.warehouseRole.name}": orders of 3 customers (link rule), not assigned`,
  ];
}

/**
 * The S7 samples (BACKLOG T818): the dashboard and its public link — the URL
 * carries the token, printed only by the run that created it (development
 * only) — and the color rule.
 */
function s7Lines(result: DemoSeedResult): string[] {
  const s7 = result.s7;
  if (s7 === null) {
    return [
      '',
      `Dashboard "${DEMO_DASHBOARD.name}": its public link was printed by the run that created it;`,
      'regenerate it from the Share dialog of the dashboard.',
    ];
  }
  return [
    '',
    `Dashboard "${s7.dashboardName}" (${String(s7.widgetCount)} widgets, Sales: read only)`,
    s7.shareUrl === null
      ? '  Public link not created in production.'
      : `  Public link (embedding off, shown only once)  ${s7.shareUrl}`,
    `Color rule: "${DEMO_COLOR_RULE.field}" rows in ${DEMO_COLOR_RULE.color} on "${s7.colorRuleView}"`,
  ];
}

/** The share links of the run: their URLs carry the token, printed only here. */
function shareLinkLines(links: DemoSeedResult['shareLinks']): string[] {
  if (links === null) {
    return [
      '',
      'Share links: their URLs were printed by the run that created them (tokens are not',
      'stored); regenerate one from the Share dialog of the view.',
    ];
  }
  if (links.length === 0) return [];
  const width = Math.max(...links.map((link) => link.viewName.length));
  return [
    '',
    'Share links (shown only once):',
    ...links.map(
      (link) => `  ${link.viewName.padEnd(width)}  ${link.audience.padEnd(6)}  ${link.url}`,
    ),
  ];
}

function seedLogger(config: AppConfig): Logger {
  // Only warnings and errors by default: the terminal shows the summary.
  const level =
    config.logLevel === 'debug' || config.logLevel === 'trace' ? config.logLevel : 'warn';
  return pino(
    { ...rootLoggerOptions(level), base: { service: 'cellhive-seed' } },
    destination({ fd: 2, sync: true }),
  );
}

/**
 * The API's application context without HTTP: the same modules, services
 * and repositories as the server. The metrics port is turned off and no
 * email is ever sent (`SeedMailer`: demo addresses are not deliverable);
 * the mail configuration itself is kept, so sample sender identities get
 * the mode the API would give them (BACKLOG T519).
 */
async function createSeedContext(
  config: AppConfig,
  logger: Logger,
): Promise<INestApplicationContext> {
  const seedConfig: AppConfig = { ...config, metrics: { token: null, port: null } };
  return NestFactory.createApplicationContext(
    AppModule.register({ config: seedConfig, rootLogger: logger, mailService: new SeedMailer() }),
    { logger: new NestLoggerAdapter(logger.child({ component: 'nest' })), abortOnError: false },
  );
}

async function seedWith(
  options: Pick<DemoSeedOptions, 'tableCounts'>,
  profile: DemoProfile,
  app: INestApplicationContext,
  config: AppConfig,
  io: SeedIo,
): Promise<void> {
  const seeder = new DemoSeeder(app, profile);
  const state = await seeder.detect();
  switch (state.kind) {
    case 'complete':
      io.err('Demo data already exists; nothing to do.');
      for (const line of summaryLines(
        config,
        state.result,
        config.nodeEnv === 'production' ? null : demoPasswords(config),
        profile,
      )) {
        io.out(line);
      }
      return;
    case 'partial':
      throw new SeedError(
        `Some demo data exists but not all of it (${state.reason}); refusing to guess.\n${RESET_HINT}`,
      );
    case 'empty': {
      const passwords = demoPasswords(config);
      io.err(`Seeding the demo organization "${profile.orgName}"…`);
      const result = await seeder.seed(passwords, {
        ...options,
        shareLinks: config.nodeEnv !== 'production',
        onProgress: (message) => {
          io.err(`  ${message}`);
        },
      });
      for (const warning of result.s5?.warnings ?? []) io.err(`Warning: ${warning}`);
      if (result.salesRoleAdjustments > 0) {
        io.err(
          `Warning: the Sales role config was adjusted (${String(result.salesRoleAdjustments)} change(s)).`,
        );
      }
      io.err('Done.');
      for (const line of summaryLines(config, result, passwords, profile)) io.out(line);
      if (config.nodeEnv === 'production') {
        io.err('These random passwords are shown only once.');
      }
    }
  }
}

/** Runs `pnpm seed:demo`; resolves with the process exit code. */
export async function runSeed(
  argv: readonly string[],
  env: Env,
  io: SeedIo,
  /** Test-only: smaller tables. */
  seedOptions: Pick<DemoSeedOptions, 'tableCounts'> = {},
): Promise<number> {
  let app: INestApplicationContext | undefined;
  let logger: Logger | undefined;
  try {
    const options = parseSeedArgs(argv);
    if (options === 'help') {
      io.out(SEED_USAGE);
      return 0;
    }
    const config = loadConfig(env);
    if (config.nodeEnv === 'production' && !options.force) {
      throw new SeedError(
        'NODE_ENV is production (the default when unset): refusing to create demo users.\n' +
          'For development, copy .env.example to .env (NODE_ENV=development). To seed a\n' +
          'production instance anyway, pass --force: users then get random passwords.',
      );
    }
    logger = seedLogger(config);
    app = await createSeedContext(config, logger);
    await seedWith(seedOptions, options.profile, app, config, io);
    return 0;
  } catch (error) {
    if (error instanceof SeedError || error instanceof ConfigError) {
      io.err(error.message);
      return 1;
    }
    if ((error as { code?: unknown } | null)?.code === UNDEFINED_TABLE) {
      io.err('The database is not migrated: run `pnpm db:migrate` first.');
      return 1;
    }
    if (logger === undefined) throw error;
    logger.error({ err: error }, 'seed failed');
    io.err(`Seeding failed; see the log above.\n${RESET_HINT}`);
    return 1;
  } finally {
    await app?.close();
    logger?.flush();
  }
}
