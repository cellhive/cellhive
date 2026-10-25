import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { E2E_STACK_ENV } from './ports';

const API_DIST = fileURLToPath(new URL('../../api/dist/', import.meta.url));

/**
 * Runs an API seed script or the server CLI (`apps/api/dist/<script>`) against the E2E stack
 * and returns its stdout. The stack runs with NODE_ENV=production; seeds run
 * with `development` so that the documented development-only passwords apply
 * (CONTRACTS §9). Progress on stderr is passed through.
 */
export function runSeed(
  script: 'seed.js' | 'seed-bench.js' | 'cli.js',
  args: readonly string[] = [],
): Promise<string> {
  const raw = process.env[E2E_STACK_ENV];
  if (raw === undefined) throw new Error('The E2E global setup did not publish the stack env.');
  const env = { ...(JSON.parse(raw) as NodeJS.ProcessEnv), NODE_ENV: 'development' };
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [`${API_DIST}${script}`, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${script} exited with code ${String(code)}:\n${out}`));
    });
  });
}

/**
 * Display names of the demo Orders title and customer link (CONTRACTS §9,
 * T421b: Vietnamese like the rest of the demo).
 */
export const DEMO_ORDER_TITLE = 'Tên đơn hàng';
export const DEMO_ORDER_CUSTOMER = 'Khách hàng';

/** Demo credentials of CONTRACTS §9 (development only). */
export const DEMO_PASSWORD = 'Cellhive-demo-2026';
export const DEMO_ADMIN_EMAIL = 'admin@demo.cellhive.local';
/** Bench credentials printed by `seed:bench` (development only). */
export const BENCH_EMAIL = 'bench@bench.cellhive.local';
export const BENCH_PASSWORD = 'Cellhive-bench-2026';
