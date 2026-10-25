import { isValidTimeZone } from '@cellhive/field-types';

import {
  isDateValue,
  isFieldRefValue,
  isFilterCondition,
  isVariableValue,
  type DateSpec,
  type DateValue,
  type FieldRefValue,
  type FilterNode,
  type FilterNodeOf,
  type FilterOperand,
  type FilterValue,
  type VariableValue,
} from './ast.js';
import {
  addDays,
  addMonths,
  civilDateInZone,
  formatCivilDate,
  isoWeekday,
  parseExactDate,
  startOfDay,
  zonedEpoch,
  type CivilDate,
} from './dates.js';

/**
 * A date operand resolved to a half-open interval, in two forms so that the
 * SQL compiler and the evaluator (T105) can use it without table meta:
 *
 * - `start`/`end`: ISO 8601 UTC instants, for `timestamptz` columns;
 * - `start_date`/`end_date`: `YYYY-MM-DD`, for date-only (`date`) columns.
 *
 * Both are `[start, end)`. Operator semantics against a range `r`:
 * `is` → `start ≤ v < end`; `before` → `v < start`; `after` → `v ≥ end`;
 * `on_or_before` → `v < end`; `on_or_after` → `v ≥ start`;
 * `between [a, b]` → `a.start ≤ v < b.end`; `intersects`/`disjoint` (lookup)
 * compare the value against each range as `is` does.
 *
 * Granularity: a day for day-based operands (`today`, `days_ago`, an exact
 * date…), a week/month/year for `this_week`, `this_month`, `last_month`,
 * `this_year`, one minute for an exact `YYYY-MM-DDTHH:mm` and one millisecond
 * for `now`. The date form always spans whole days (`now` → today).
 */
export interface DateRange {
  $range: {
    start: string;
    end: string;
    start_date: string;
    end_date: string;
  };
}

export type ResolvedOperand = string | number | boolean | null | DateRange | FieldRefValue;
export type ResolvedValue = ResolvedOperand | ResolvedOperand[];
export type ResolvedFilterNode = FilterNodeOf<ResolvedValue>;

export interface ResolveContext {
  /** Acting user; `null` (anonymous share link, system) makes `current_user` match nobody. */
  readonly userId: string | null;
  /**
   * `current_user_groups` (SPEC §6.1): user ids of every member of every group
   * the acting user belongs to (the acting user included). The caller expands
   * group membership; empty when there is no user or the user has no group.
   */
  readonly groupMemberUserIds: readonly string[];
  /** IANA zone of the org/user; every date operand is computed in it. */
  readonly timeZone: string;
  /** Evaluation instant; the result is a pure function of it. */
  readonly now: Date | number;
}

export function isDateRange(value: unknown): value is DateRange {
  return typeof value === 'object' && value !== null && '$range' in value;
}

interface Resolver {
  readonly userId: string | null;
  readonly groupMemberUserIds: readonly string[];
  readonly timeZone: string;
  readonly nowMs: number;
  readonly today: CivilDate;
}

function dayRange(from: CivilDate, to: CivilDate, timeZone: string): DateRange {
  return {
    $range: {
      start: new Date(startOfDay(from, timeZone)).toISOString(),
      end: new Date(startOfDay(to, timeZone)).toISOString(),
      start_date: formatCivilDate(from),
      end_date: formatCivilDate(to),
    },
  };
}

function relativeRange(spec: Extract<DateSpec, { relative: unknown }>, r: Resolver): DateRange {
  const { today, timeZone } = r;
  const days = (from: number, to: number) =>
    dayRange(addDays(today, from), addDays(today, to), timeZone);
  const amount = spec.amount ?? 0;
  switch (spec.relative) {
    case 'today':
      return days(0, 1);
    case 'tomorrow':
      return days(1, 2);
    case 'yesterday':
      return days(-1, 0);
    case 'days_ago':
      return days(-amount, -amount + 1);
    case 'days_from_now':
      return days(amount, amount + 1);
    case 'this_week': {
      const monday = addDays(today, 1 - isoWeekday(today));
      return dayRange(monday, addDays(monday, 7), timeZone);
    }
    case 'this_month': {
      const first = { ...today, day: 1 };
      return dayRange(first, addMonths(first, 1), timeZone);
    }
    case 'last_month': {
      const first = { ...today, day: 1 };
      return dayRange(addMonths(first, -1), first, timeZone);
    }
    case 'this_year':
      return dayRange(
        { year: today.year, month: 1, day: 1 },
        { year: today.year + 1, month: 1, day: 1 },
        timeZone,
      );
  }
}

function exactRange(text: string, timeZone: string): DateRange {
  const exact = parseExactDate(text);
  if (exact === null) throw new RangeError(`Invalid $date.exact ${JSON.stringify(text)}`);
  const day: CivilDate = { year: exact.year, month: exact.month, day: exact.day };
  if (exact.time === null) return dayRange(day, addDays(day, 1), timeZone);
  const start = zonedEpoch(day, exact.time.hour, exact.time.minute, timeZone);
  return {
    $range: {
      start: new Date(start).toISOString(),
      end: new Date(start + 60_000).toISOString(),
      start_date: formatCivilDate(day),
      end_date: formatCivilDate(addDays(day, 1)),
    },
  };
}

function dateRange(value: DateValue, r: Resolver): DateRange {
  const spec = value.$date;
  return 'exact' in spec ? exactRange(spec.exact, r.timeZone) : relativeRange(spec, r);
}

function variable(value: VariableValue, r: Resolver): ResolvedValue {
  switch (value.$var) {
    case 'current_user':
      return r.userId;
    case 'current_user_groups':
      return [...new Set(r.groupMemberUserIds)];
    case 'today':
      return relativeRange({ relative: 'today' }, r);
    case 'now':
      return {
        $range: {
          start: new Date(r.nowMs).toISOString(),
          end: new Date(r.nowMs + 1).toISOString(),
          start_date: formatCivilDate(r.today),
          end_date: formatCivilDate(addDays(r.today, 1)),
        },
      };
  }
}

function operand(value: FilterOperand, r: Resolver): ResolvedValue {
  if (isVariableValue(value)) return variable(value, r);
  if (isDateValue(value)) return dateRange(value, r);
  return value;
}

function resolveValue(value: FilterValue, r: Resolver): ResolvedValue {
  if (!Array.isArray(value)) return operand(value, r);
  // Inside a list, `current_user_groups` spreads and an absent `current_user` drops out.
  return value.flatMap((item): ResolvedOperand[] => {
    const resolved = operand(item, r);
    if (Array.isArray(resolved)) return resolved;
    if (resolved === null && isVariableValue(item)) return [];
    return [resolved];
  });
}

function resolveNode(node: FilterNode, r: Resolver): ResolvedFilterNode {
  if (isFilterCondition(node)) {
    const { value, ...rest } = node;
    if (value === undefined || isFieldRefValue(value))
      return value === undefined ? rest : { ...rest, value };
    return { ...rest, value: resolveValue(value, r) };
  }
  if (node.op === 'not') return { op: 'not', item: resolveNode(node.item, r) };
  return { op: node.op, items: node.items.map((item) => resolveNode(item, r)) };
}

/**
 * Replaces `$var` and `$date` operands of a validated filter with concrete
 * values: `current_user` → user id (or `null`), `current_user_groups` →
 * the (deduplicated) user ids of all members of the acting user's groups,
 * spread into the surrounding list, and every date operand →
 * a {@link DateRange} computed in `ctx.timeZone`. Weeks start on Monday
 * (ISO 8601). Deterministic for a given `ctx.now`; does not mutate `ast`.
 */
export function resolveVariables(ast: FilterNode, ctx: ResolveContext): ResolvedFilterNode {
  if (!isValidTimeZone(ctx.timeZone)) {
    throw new RangeError(`Unknown time zone ${JSON.stringify(ctx.timeZone)}`);
  }
  const nowMs = typeof ctx.now === 'number' ? ctx.now : ctx.now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('Invalid now');
  return resolveNode(ast, {
    userId: ctx.userId,
    groupMemberUserIds: ctx.groupMemberUserIds,
    timeZone: ctx.timeZone,
    nowMs,
    today: civilDateInZone(nowMs, ctx.timeZone),
  });
}
