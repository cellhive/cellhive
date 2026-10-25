/**
 * `pnpm seed:bench [--rows N]` (CONTRACTS §9, SPEC §21): creates the bench
 * organization and a table of 200 000 records × 30 fields, its 20 000
 * customers and the computed fields (BACKLOG T464) through the services
 * (see `seed/bench-seed.ts`). Development only. Progress goes to
 * stderr, the summary to stdout.
 */
import process from 'node:process';

import { loadConfig } from '@cellhive/server-core';
import { destination, pino } from 'pino';

import { createApp } from './app.factory.js';
import { rootLoggerOptions } from './common/logging/root-logger.js';
import { seedBench } from './seed/bench-seed.js';

function rowsArgument(argv: readonly string[]): number | undefined {
  const index = argv.indexOf('--rows');
  if (index === -1) return undefined;
  const rows = Number(argv[index + 1]);
  if (!Number.isSafeInteger(rows) || rows < 1) throw new Error('--rows expects a positive integer');
  return rows;
}

async function main(): Promise<void> {
  const rows = rowsArgument(process.argv.slice(2));
  const config = loadConfig(process.env);
  const logger = pino(
    { ...rootLoggerOptions('warn'), base: { service: 'cellhive-seed' } },
    destination(2),
  );
  const app = await createApp(config, { logger });
  try {
    const started = Date.now();
    let reported = 0;
    const result = await seedBench(app, {
      ...(rows === undefined ? {} : { rows }),
      onProgress: (done, total) => {
        if (done - reported >= 10_000 || done === total) {
          reported = done;
          const seconds = (Date.now() - started) / 1000;
          process.stderr.write(
            `seed:bench ${String(done)}/${String(total)} records (${seconds.toFixed(0)} s)\n`,
          );
        }
      },
    });
    const summary = result.created
      ? `created ${String(result.rows)} records in ${(result.insertMs / 1000).toFixed(1)} s`
      : 'already present, nothing created';
    const computedLine = result.created
      ? `  computed: ${String(result.computed.length)} formula/lookup fields ready in ${(result.computedMs / 1000).toFixed(1)} s` +
        (result.customers === null
          ? ''
          : ` (${String(result.customers.rows)} customers: ${result.customers.tableId})`)
      : undefined;
    const linkLine =
      result.bigLinkCell === null
        ? undefined
        : `  500-link cell: ${result.bigLinkCell.recordId} . ${result.bigLinkCell.fieldName}`;
    process.stdout.write(
      [
        `seed:bench: ${summary}`,
        `  table:    ${result.tableId}`,
        `  base:     ${result.baseId}`,
        `  sign in:  ${result.email} / ${result.password} (development only)`,
        ...(computedLine === undefined ? [] : [computedLine]),
        ...(linkLine === undefined ? [] : [linkLine]),
        `  events:   ${String(result.settledEvents)} marked dispatched (no events.dispatch backlog)`,
        `  automations: ${String(result.automations)} created (off: the automation bench turns them on)`,
        '',
      ].join('\n'),
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `seed:bench: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
