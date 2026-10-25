import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Existing sources: type-aware linting needs files the TypeScript projects know. */
const REPOSITORY_FILE = 'packages/server-core/src/db/page.ts';
const ALLOWED_FILE = 'packages/server-core/src/schema/physical.ts';

const RAW_SQL = [
  "import { sql, CompiledQuery } from 'kysely';",
  "export const a = sql.raw('SELECT 1');",
  'export const b = sql.lit(1);',
  "export const c = CompiledQuery.raw('SELECT 1');",
  'export const d = sql`SELECT ${1}`;',
  '',
].join('\n');

async function rawSqlMessages(filePath: string): Promise<number[]> {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(RAW_SQL, { filePath: `${ROOT}${filePath}` });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-syntax')
    .map((message) => message.line);
}

/** AGENTS.md golden rule 2, enforced by `eslint.config.js`. */
describe('lint: raw SQL text is banned', () => {
  it('flags sql.raw, sql.lit and CompiledQuery.raw, but not sql`…` with parameters', async () => {
    expect(await rawSqlMessages(REPOSITORY_FILE)).toEqual([2, 3, 4]);
  }, 60_000);

  it('allows them only in the reviewed DDL files', async () => {
    expect(await rawSqlMessages(ALLOWED_FILE)).toEqual([]);
  }, 60_000);
});
