#!/usr/bin/env node
/**
 * `cellhive` command-line tool (SPEC §14.1A, §14.2), shipped in the server
 * image: `node dist/cli.js <command>` (e.g. `docker compose exec api node
 * dist/cli.js user reset-password --email a@example.com`), or
 * `pnpm cellhive <command>` in a checkout.
 */
import process from 'node:process';

import { runCli } from './cli/run.js';

const io = {
  out: (line: string): void => {
    process.stdout.write(`${line}\n`);
  },
  err: (line: string): void => {
    process.stderr.write(`${line}\n`);
  },
};

runCli(process.argv.slice(2), process.env, io).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `cellhive: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
