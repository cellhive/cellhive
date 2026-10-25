/**
 * `pnpm test:matrix` (BACKLOG T719, CONTRACTS §5): runs, in one command,
 * every integration test file of the API that names a row of the
 * permission matrix — P01–P77 — in a test or describe title, whole
 * (the tests of a file build on each other's state, so they are not
 * filtered by name), then prints how many passing tests name each row.
 * A test counts for the rows its own title names; only a title naming none
 * falls back to its describe titles, so a describe "P39–P43" does not credit
 * every test inside it to all five rows.
 * Fails when a test fails or a row has none. P21 and P65–P77 (S7, BACKLOG
 * T818) joined the required rows with `permissions-s7-matrix.int.test.ts`.
 *
 * Extra arguments go to Vitest.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REQUIRED = Array.from({ length: 77 }, (_v, index) => index + 1).map(
  (n) => `P${String(n).padStart(2, '0')}`,
);

/** Every name mentioning a row: `P07`, `P01/P19`, `P16–P18` (ranges expanded). */
export function codesOf(name: string): string[] {
  const codes = new Set<string>();
  for (const match of name.matchAll(/\bP(\d{2})(?:\s*[–-]\s*P(\d{2}))?\b/gu)) {
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    for (let n = from; n <= Math.max(from, to); n += 1) {
      codes.add(`P${String(n).padStart(2, '0')}`);
    }
  }
  return [...codes];
}

interface JsonReport {
  readonly testResults: readonly {
    readonly name: string;
    readonly assertionResults: readonly {
      readonly title: string;
      readonly fullName: string;
      readonly status: string;
    }[];
  }[];
}

/** Integration test files with a matrix row in a title (a string literal naming `Pnn`). */
function matrixFiles(): string[] {
  const root = 'test/int';
  return readdirSync(root)
    .filter((name) => name.endsWith('.int.test.ts') && !name.includes('.bench.'))
    .filter((name) => {
      const text = readFileSync(join(root, name), 'utf8');
      return /(?:describe|it|test)(?:\.each[^(]*\([\s\S]*?\))?\(\s*['"`][^'"`\n]*\bP\d{2}\b/u.test(
        text,
      );
    })
    .map((name) => join(root, name))
    .sort();
}

/** The rows a test counts for: those of its own title, else those of its describes. */
function rowsOf(test: { readonly title: string; readonly fullName: string }): string[] {
  const own = codesOf(test.title);
  return own.length > 0 ? own : codesOf(test.fullName);
}

const dir = mkdtempSync(join(tmpdir(), 'cellhive-matrix-'));
const output = join(dir, 'report.json');
try {
  const run = spawnSync(
    'vitest',
    [
      'run',
      '-c',
      'vitest.int.config.ts',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${output}`,
      ...process.argv.slice(2),
      ...matrixFiles(),
    ],
    { stdio: 'inherit', shell: false },
  );
  if (run.error !== undefined) throw run.error;
  const report = JSON.parse(readFileSync(output, 'utf8')) as JsonReport;
  const rows = new Map<string, { passed: number; failed: number; files: Set<string> }>();
  for (const code of REQUIRED) rows.set(code, { passed: 0, failed: 0, files: new Set() });
  for (const file of report.testResults) {
    const shortName = file.name.replace(/^.*\/test\/int\//u, '');
    for (const test of file.assertionResults) {
      for (const code of rowsOf(test)) {
        const row = rows.get(code);
        if (row === undefined || test.status === 'skipped' || test.status === 'pending') continue;
        if (test.status === 'passed') row.passed += 1;
        else row.failed += 1;
        row.files.add(shortName);
      }
    }
  }
  const lines = ['', 'Permission matrix (CONTRACTS §5) — tests per row:', ''];
  let missing = 0;
  let failed = 0;
  for (const [code, row] of rows) {
    if (row.passed === 0) missing += 1;
    failed += row.failed;
    const status = row.failed > 0 ? 'FAIL' : row.passed === 0 ? 'NONE' : 'ok  ';
    lines.push(
      `${status} ${code} ${String(row.passed).padStart(3)} passed` +
        `${row.failed > 0 ? `, ${String(row.failed)} failed` : ''}  ${[...row.files].sort().join(', ')}`,
    );
  }
  const all = report.testResults.flatMap((file) => file.assertionResults);
  const total = all.filter((test) => test.status === 'passed').length;
  const named = all.filter((test) => test.status === 'passed' && rowsOf(test).length > 0);
  lines.push(
    '',
    `${String(report.testResults.length)} files, ${String(total)} tests passed ` +
      `(${String(named.length)} name a row), ${String(all.length - total)} not passed; ` +
      `${String(rows.size)} rows, ` +
      `${String(missing)} without a test, ${String(failed)} failures on a row.`,
    '',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = run.status !== 0 || missing > 0 || failed > 0 ? 1 : 0;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
