import { availableParallelism, loadavg } from 'node:os';

/**
 * Whether an absolute time budget is meaningful now (S4b-review §7.1): only
 * while the 1-minute load is under 2 × the CPUs, like the integration
 * latency tests (`realtime-computed`). On a loaded machine (a parallel full
 * run, other processes) the test still measures and runs its deterministic
 * checks, but does not fail on the clock. `loadavg` is `[0, 0, 0]` on
 * Windows: budgets always apply there.
 */
export function timingBudgetsApply(): boolean {
  return (loadavg()[0] ?? 0) < 2 * availableParallelism();
}

/**
 * CPU time (user + system, ms) this process spent running `fn` — unlike the
 * wall clock, barely changed by other processes competing for the CPUs (a
 * parallel `turbo run test`, QA S5c: the 1-minute load average lags behind
 * a run that just started, so {@link timingBudgetsApply} alone let wall-clock
 * budgets fail).
 */
export function cpuTimeMs(fn: () => void): number {
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

/** Number of AST nodes (objects with a `type`) under `node`. */
export function countNodes(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((total, item) => total + countNodes(item), 0);
  if (node === null || typeof node !== 'object') return 0;
  let total = typeof (node as { type?: unknown }).type === 'string' ? 1 : 0;
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'span') total += countNodes(value);
  }
  return total;
}
