import { parseArgs } from 'node:util';

import { emailSchema, localeSchema, timeZoneSchema } from '@cellhive/contracts';
import { ConfigError, type Env } from '@cellhive/server-core';

import {
  DEFAULT_STALE_LOCK_MINUTES,
  jobsUnlockStaleCommand,
  migrateCommand,
  orgCreateCommand,
  setupCommand,
  userResetPasswordCommand,
} from './commands.js';
import { CliError, createCliContext, type CliContext, type CliIo } from './context.js';

import type { z } from 'zod';

export const USAGE = `Usage: cellhive <command> [options]

Commands:
  migrate                                   Apply database migrations (like MODE=migrate)
  setup --email <email> --org <name>        First-time setup without the web UI; prints a
        [--name <display name>]             set-password link (no password on the command line)
        [--locale <tag>] [--timezone <tz>]
  org create --name <name> --owner-email <email>
                                            Create an organization; a new owner gets a
                                            set-password link
  user reset-password --email <email>       Print a one-time password reset link (24 h) and
        [--keep-tokens | --revoke-tokens]   revoke every API token of the user in every
                                            organization (--keep-tokens keeps them working)
  jobs unlock-stale [--older-than <min>]    Release job locks of dead workers (locks older
        [--dry-run]                         than ${String(DEFAULT_STALE_LOCK_MINUTES)} minutes by default)

The environment is the server's (DATABASE_URL, PUBLIC_URL, …, SPEC §20).
Results (links, ids) go to stdout; messages go to stderr.`;

const OPTIONS = {
  email: { type: 'string' },
  org: { type: 'string' },
  name: { type: 'string' },
  locale: { type: 'string' },
  timezone: { type: 'string' },
  'owner-email': { type: 'string' },
  'older-than': { type: 'string' },
  'dry-run': { type: 'boolean' },
  'keep-tokens': { type: 'boolean' },
  'revoke-tokens': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>['values'];

function usageError(message: string): CliError {
  return new CliError(`${message}\n\n${USAGE}`, 2);
}

function required(values: Values, name: 'email' | 'org' | 'name' | 'owner-email'): string {
  const value = values[name];
  if (value === undefined || value.trim() === '') throw usageError(`--${name} is required.`);
  return value.trim();
}

function validated<T>(schema: z.ZodType<T>, option: string, value: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw usageError(`--${option}: ${result.error.issues[0]?.message ?? 'invalid'}`);
  return result.data;
}

function optional<T>(
  schema: z.ZodType<T>,
  option: string,
  value: string | undefined,
): T | undefined {
  return value === undefined ? undefined : validated(schema, option, value);
}

type Command = (ctx: CliContext) => Promise<void>;

/** Parses the arguments into the command to run (validation before any connection). */
export function parseCommand(argv: readonly string[]): Command | 'help' {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true || positionals.length === 0) return 'help';
  const command = positionals.join(' ');
  switch (command) {
    case 'migrate':
      return migrateCommand;
    case 'setup': {
      const input = {
        email: validated(emailSchema, 'email', required(values, 'email')),
        org: required(values, 'org'),
        name: values.name?.trim() || undefined,
        locale: optional(localeSchema, 'locale', values.locale),
        timezone: optional(timeZoneSchema, 'timezone', values.timezone),
      };
      return (ctx) => setupCommand(ctx, input);
    }
    case 'org create': {
      const input = {
        name: required(values, 'name'),
        ownerEmail: validated(emailSchema, 'owner-email', required(values, 'owner-email')),
      };
      return (ctx) => orgCreateCommand(ctx, input);
    }
    case 'user reset-password': {
      const email = validated(emailSchema, 'email', required(values, 'email'));
      // Revoking is the default (Quyết định S7 #3); --revoke-tokens only says so explicitly.
      if (values['keep-tokens'] === true && values['revoke-tokens'] === true) {
        throw usageError('--keep-tokens and --revoke-tokens cannot be combined.');
      }
      const revokeTokens = values['keep-tokens'] !== true;
      return (ctx) => userResetPasswordCommand(ctx, { email, revokeTokens });
    }
    case 'jobs unlock-stale': {
      const raw = values['older-than'] ?? String(DEFAULT_STALE_LOCK_MINUTES);
      const minutes = Number(raw);
      if (!/^\d+$/.test(raw) || minutes < 1 || minutes > 7 * 24 * 60) {
        throw usageError('--older-than must be a number of minutes between 1 and 10080.');
      }
      const dryRun = values['dry-run'] === true;
      return (ctx) => jobsUnlockStaleCommand(ctx, { olderThanMinutes: minutes, dryRun });
    }
    default:
      throw usageError(`Unknown command '${command}'.`);
  }
}

/** Runs the CLI; resolves with the process exit code. */
export async function runCli(argv: readonly string[], env: Env, io: CliIo): Promise<number> {
  let ctx: CliContext | undefined;
  try {
    const command = parseCommand(argv);
    if (command === 'help') {
      io.out(USAGE);
      return 0;
    }
    ctx = createCliContext(env, io);
    await command(ctx);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message);
      return error.exitCode;
    }
    if (error instanceof ConfigError) {
      io.err(error.message);
      return 1;
    }
    if (ctx === undefined) throw error;
    ctx.logger.error({ err: error }, 'command failed');
    io.err('Command failed; see the log above.');
    return 1;
  } finally {
    await ctx?.db.destroy();
    ctx?.logger.flush();
  }
}
