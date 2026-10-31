import {
  MAX_WIDGET_QUERIES_PER_INSTANCE,
  MAX_WIDGET_QUERIES_PER_USER,
  WIDGET_QUERY_TIMEOUT_MS,
  WIDGET_RETRY_AFTER_SECONDS,
} from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';
import { Injectable } from '@nestjs/common';

interface Waiter {
  readonly key: string;
  readonly start: () => void;
}

/**
 * A widget query that ran too long (`statement_timeout`) as `504
 * QUERY_TIMEOUT` with `Retry-After`, like one that waited too long in the
 * line (CONTRACTS §28.3) — for every caller of the line: dashboards, AI
 * Q&A, MCP `aggregate_records`. Other errors pass unchanged.
 */
export function withRetryAfter(error: unknown): unknown {
  if (!(error instanceof AppError) || error.code !== 'QUERY_TIMEOUT') return error;
  if (error.retryAfterSeconds !== undefined) return error;
  return new AppError('QUERY_TIMEOUT', {
    detail: error.detail ?? 'The widget query took too long and was cancelled.',
    retryAfterSeconds: WIDGET_RETRY_AFTER_SECONDS,
    cause: error,
  });
}

/**
 * In-process line of widget queries (BACKLOG T806, CONTRACTS §28.7): at
 * most `perUser` running at once per user and `total` per api instance;
 * the others wait in arrival order (a waiter whose user is at their limit
 * lets the next one pass). A query that waited longer than the widget
 * timeout gives up with `504 QUERY_TIMEOUT` and `Retry-After`, as one that
 * ran too long. Several instances each keep their own line (S7 research
 * §4.6: a shared semaphore in Valkey when that is not enough).
 */
@Injectable()
export class WidgetQueryLimiter {
  perUser = MAX_WIDGET_QUERIES_PER_USER;
  total = MAX_WIDGET_QUERIES_PER_INSTANCE;
  waitMs = WIDGET_QUERY_TIMEOUT_MS;

  private running = 0;
  private readonly byKey = new Map<string, number>();
  private readonly waiting: Waiter[] = [];

  /** Queries running now (for tests and metrics). */
  get active(): number {
    return this.running;
  }

  /** Runs `task` when a slot of `key` (a user) and of the instance is free. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      return await task();
    } finally {
      this.release(key);
    }
  }

  private canStart(key: string): boolean {
    return this.running < this.total && (this.byKey.get(key) ?? 0) < this.perUser;
  }

  private take(key: string): void {
    this.running += 1;
    this.byKey.set(key, (this.byKey.get(key) ?? 0) + 1);
  }

  private acquire(key: string): Promise<void> {
    if (this.canStart(key) && !this.waiting.some((waiter) => waiter.key === key)) {
      this.take(key);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        key,
        start: () => {
          clearTimeout(timer);
          this.take(key);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(
          new AppError('QUERY_TIMEOUT', {
            detail: 'Too many widget queries are running; try again shortly.',
            retryAfterSeconds: WIDGET_RETRY_AFTER_SECONDS,
          }),
        );
      }, this.waitMs);
      timer.unref();
      this.waiting.push(waiter);
    });
  }

  private release(key: string): void {
    this.running -= 1;
    const left = (this.byKey.get(key) ?? 1) - 1;
    if (left <= 0) this.byKey.delete(key);
    else this.byKey.set(key, left);
    // Start every waiter that may run now, oldest first.
    for (let index = 0; index < this.waiting.length && this.running < this.total;) {
      const waiter = this.waiting[index] as Waiter;
      if (this.canStart(waiter.key)) {
        this.waiting.splice(index, 1);
        waiter.start();
      } else {
        index += 1;
      }
    }
  }
}
