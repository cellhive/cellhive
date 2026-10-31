import { orgScope } from '../../db/repository.js';
import { AppError } from '../../errors/app-error.js';
import { recordAiQuotaExhausted } from '../metrics.js';

import { AiUsageRepository } from './ai-usage.repository.js';

import type { Db } from '../../db/create-db.js';
import type { AiUsage } from '../client.js';
import type { AiFeature, Id } from '@cellhive/contracts';

/** The quota day of an instant: its civil date in the organization zone and the next midnight. */
export interface QuotaDay {
  /** `YYYY-MM-DD` in the zone. */
  readonly day: string;
  /** First instant of the next day in the zone: when the quota resets. */
  readonly resetAt: Date;
}

function civilDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}

/** Milliseconds the zone is ahead of UTC at instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The day `now` falls on in `timeZone` (an IANA name) and the instant the
 * next one starts — on a day whose midnight a DST change skips, the first
 * instant that exists (01:00). Pure; callers inject the clock.
 */
export function quotaDayOf(now: Date, timeZone: string): QuotaDay {
  const day = civilDay(now.getTime(), timeZone);
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  const midnight = Date.UTC(year, month - 1, date + 1);
  const first = midnight - offsetAt(midnight, timeZone);
  const second = midnight - offsetAt(first, timeZone);
  const next = civilDay(midnight, 'UTC');
  // Two guesses around a DST change: the earliest one already in the next day.
  const resetAt = [Math.min(first, second), Math.max(first, second)].find(
    (candidate) => civilDay(candidate, timeZone) === next,
  );
  return { day, resetAt: new Date(resetAt ?? Math.max(first, second)) };
}

/** `429 AI_QUOTA_EXCEEDED` with `Retry-After` until the reset (never retried by workers). */
export function aiQuotaExceeded(dailyTokenLimit: number, quotaDay: QuotaDay, now: Date): AppError {
  const message = 'The AI token quota of the organization for today is used up.';
  return new AppError('AI_QUOTA_EXCEEDED', {
    detail: message,
    errors: [
      {
        path: '',
        code: 'AI_QUOTA_EXCEEDED',
        message,
        params: {
          reset_at: quotaDay.resetAt.toISOString(),
          daily_token_limit: dailyTokenLimit,
        },
      },
    ],
    retryAfterSeconds: (quotaDay.resetAt.getTime() - now.getTime()) / 1000,
    params: { temporary: false },
  });
}

export interface AiQuotaContext {
  readonly organizationId: Id<'org'>;
  /** The organization time zone (its `settings.timezone`, else the instance default). */
  readonly timeZone: string;
  readonly now: Date;
}

/**
 * Daily token quota of an organization (BACKLOG T906, ADR-39 §6, Quyết
 * định S8 #13): checked **before** every call, recorded **after** it from
 * the provider's `usage` (estimated without one) — failed calls that
 * reported usage too. Check-then-record: the overshoot is at most the calls
 * in flight × their `max_tokens`, accepted instead of reservations.
 */
export class AiUsageLedger {
  private readonly usage: AiUsageRepository;

  constructor(db: Db) {
    this.usage = new AiUsageRepository(db);
  }

  /** `429 AI_QUOTA_EXCEEDED` when today's tokens reached `dailyTokenLimit` (`null`: no limit). */
  async check(context: AiQuotaContext, dailyTokenLimit: number | null): Promise<void> {
    if (dailyTokenLimit === null) return;
    const today = quotaDayOf(context.now, context.timeZone);
    const used = await this.usage.tokensOn(orgScope(context.organizationId), today.day);
    if (used < dailyTokenLimit) return;
    recordAiQuotaExhausted();
    throw aiQuotaExceeded(dailyTokenLimit, today, context.now);
  }

  /** Adds one call's tokens to the day of `context.now`. */
  async record(context: AiQuotaContext, feature: AiFeature, usage: AiUsage): Promise<void> {
    const { day } = quotaDayOf(context.now, context.timeZone);
    await this.usage.add(orgScope(context.organizationId), day, feature, usage);
  }

  /** Prompt + completion tokens of today. */
  async usedToday(context: AiQuotaContext): Promise<number> {
    return this.usage.tokensOn(
      orgScope(context.organizationId),
      quotaDayOf(context.now, context.timeZone).day,
    );
  }
}
