import { describe, expect, it } from 'vitest';

import { CliError } from '../../src/cli/context.js';
import { parseCommand, USAGE } from '../../src/cli/run.js';

function usageErrorOf(argv: string[]): CliError {
  try {
    parseCommand(argv);
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('expected a usage error');
}

describe('cellhive CLI arguments', () => {
  it.each([[[]], [['--help']], [['-h']], [['setup', '--help']]])('%j prints usage', (argv) => {
    expect(parseCommand(argv)).toBe('help');
  });

  it.each([
    [['migrate']],
    [['setup', '--email', 'a@example.com', '--org', 'Acme']],
    [['setup', '--email', 'a@example.com', '--org', 'Acme', '--timezone', 'Asia/Ho_Chi_Minh']],
    [['org', 'create', '--name', 'Acme', '--owner-email', 'a@example.com']],
    [['user', 'reset-password', '--email', 'a@example.com']],
    [['user', 'reset-password', '--email', 'a@example.com', '--keep-tokens']],
    [['user', 'reset-password', '--email', 'a@example.com', '--revoke-tokens']],
    [['jobs', 'unlock-stale']],
    [['jobs', 'unlock-stale', '--older-than', '90', '--dry-run']],
  ])('%j is a command', (argv) => {
    expect(typeof parseCommand(argv)).toBe('function');
  });

  it.each([
    [['nope'], "Unknown command 'nope'"],
    [['setup', '--org', 'Acme'], '--email is required'],
    [['setup', '--email', 'not-an-email', '--org', 'Acme'], '--email:'],
    [['setup', '--email', 'a@example.com', '--org', 'A', '--timezone', 'Mars/Base'], '--timezone:'],
    [
      ['setup', '--email', 'a@example.com', '--org', 'A', '--password', 'x'],
      "Unknown option '--password'",
    ],
    [['org', 'create', '--name', 'Acme'], '--owner-email is required'],
    [
      ['user', 'reset-password', '--email', 'a@example.com', '--keep-tokens', '--revoke-tokens'],
      'cannot be combined',
    ],
    [['jobs', 'unlock-stale', '--older-than', '0'], '--older-than'],
    [['jobs', 'unlock-stale', '--older-than', 'abc'], '--older-than'],
  ])('%j is a usage error (exit 2)', (argv, message) => {
    const error = usageErrorOf(argv);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain(message);
    expect(error.message).toContain(USAGE);
  });
});
