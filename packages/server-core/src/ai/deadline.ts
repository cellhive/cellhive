import { aiTimeout } from './errors.js';

/** Budget of one interactive AI request, every call and repair round included (CONTRACTS §29.7). */
export const AI_REQUEST_BUDGET_MS = 90_000;

/**
 * The time left to an AI request: interactive routes share one budget
 * between all their provider calls so the answer arrives before the reverse
 * proxy gives up (`proxy_read_timeout 120s`).
 */
export interface AiDeadline {
  /** Milliseconds left; `0` once spent. */
  remainingMs(): number;
}

export function createDeadline(
  budgetMs: number = AI_REQUEST_BUDGET_MS,
  now: () => number = Date.now,
): AiDeadline {
  const end = now() + budgetMs;
  return { remainingMs: () => Math.max(0, end - now()) };
}

/** The time left, or `504 AI_TIMEOUT` when none is. */
export function remainingOrTimeout(deadline: AiDeadline, host?: string): number {
  const left = deadline.remainingMs();
  if (left <= 0) throw aiTimeout(host);
  return left;
}
