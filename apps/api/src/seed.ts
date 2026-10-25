/**
 * `pnpm seed:demo` (CONTRACTS §9): demo data for development, created
 * through the API's own services. See `seed/run.ts`.
 */
import process from 'node:process';

import { runSeed } from './seed/run.js';

const io = {
  out: (line: string): void => {
    process.stdout.write(`${line}\n`);
  },
  err: (line: string): void => {
    process.stderr.write(`${line}\n`);
  },
};

runSeed(process.argv.slice(2), process.env, io).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `seed:demo: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
