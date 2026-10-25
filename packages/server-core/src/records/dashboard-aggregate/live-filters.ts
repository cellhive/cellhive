import {
  fieldProfile,
  parseExactDate,
  type FilterFieldMeta,
  type FilterNode,
} from '@cellhive/filter-dsl';

import type { WidgetDimensionSpec } from './widget-query.js';
import type {
  FilterControlKind,
  FilterControlValue,
  Id,
  RELATIVE_DATE_RANGES,
  WidgetGroupKey,
} from '@cellhive/contracts';

/**
 * Live filters of a dashboard (BACKLOG T808, CONTRACTS §28.4, "Quyết định
 * S7" #9, #11): pure, no database. The API resolves which declared source
 * (global filter, filter control, cross-filter) applies to a widget;
 * `RecordQueryService` turns each one into a condition on a field the viewer
 * reads — a filter-DSL condition built here for controls, the group key of
 * the source widget's dimension for cross-filters and click-through.
 */

/** A relative date range of a `date_range` control (`last_30_days`, `this_month`…). */
export type RelativeDateRange = (typeof RELATIVE_DATE_RANGES)[number];

/** A filter control (or global filter) value applied to one field. */
export interface ControlLiveFilter {
  readonly kind: 'control';
  /** Opaque key the caller maps back to the request (`ignored`). */
  readonly key: string;
  /** Request path of the value (errors). */
  readonly path: string;
  readonly control: FilterControlKind;
  readonly field: Id<'fld'>;
  readonly value: FilterControlValue;
}

/** One group of a dimension: a cross-filter, or a click-through segment. */
export interface SegmentLiveFilter {
  readonly kind: 'segment';
  readonly key: string;
  readonly path: string;
  readonly dimension: WidgetDimensionSpec;
  readonly value: WidgetGroupKey;
}

export type WidgetLiveFilter = ControlLiveFilter | SegmentLiveFilter;

/** Why a live filter was not applied by `RecordQueryService`. */
export interface IgnoredLiveFilter {
  readonly key: string;
  readonly reason: 'no_permission' | 'broken';
}

/** An inclusive range of calendar days (`YYYY-MM-DD`). */
export interface CivilRange {
  readonly from: string;
  readonly to: string;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a UTC midnight timestamp. */
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** UTC midnight of a civil day (`month` 1–12; out-of-range days roll over like `Date.UTC`). */
const utcDay = (year: number, month: number, day: number): number => Date.UTC(year, month - 1, day);

/** Today in `timeZone` at `now`, as UTC midnight of that civil day. */
function todayIn(now: Date | number, timeZone: string): number {
  const text = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [year = 0, month = 1, day = 1] = text.split('-').map(Number);
  return utcDay(year, month, day);
}

/**
 * The calendar days of a relative range at `now` in `timeZone` (both ends
 * included): `today`, `yesterday`, `last_7_days` / `last_30_days` (ending
 * today), ISO weeks starting on Monday (`this_week`, `last_week`), calendar
 * months, the quarter and years.
 */
export function relativeDateRange(
  relative: RelativeDateRange,
  now: Date | number,
  timeZone: string,
): CivilRange {
  const today = todayIn(now, timeZone);
  const date = new Date(today);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const range = (from: number, to: number): CivilRange => ({ from: isoDay(from), to: isoDay(to) });
  const monday = today - ((date.getUTCDay() + 6) % 7) * DAY_MS;
  switch (relative) {
    case 'today':
      return range(today, today);
    case 'yesterday':
      return range(today - DAY_MS, today - DAY_MS);
    case 'last_7_days':
      return range(today - 6 * DAY_MS, today);
    case 'last_30_days':
      return range(today - 29 * DAY_MS, today);
    case 'this_week':
      return range(monday, monday + 6 * DAY_MS);
    case 'last_week':
      return range(monday - 7 * DAY_MS, monday - DAY_MS);
    case 'this_month':
      return range(utcDay(year, month, 1), utcDay(year, month + 1, 0));
    case 'last_month':
      return range(utcDay(year, month - 1, 1), utcDay(year, month, 0));
    case 'this_quarter': {
      const first = Math.floor((month - 1) / 3) * 3 + 1;
      return range(utcDay(year, first, 1), utcDay(year, first + 3, 0));
    }
    case 'this_year':
      return range(utcDay(year, 1, 1), utcDay(year, 12, 31));
    case 'last_year':
      return range(utcDay(year - 1, 1, 1), utcDay(year - 1, 12, 31));
  }
}

const isCivilDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  parseExactDate(value)?.time === null;

/**
 * Why `value` does not fit a control of `kind` (`null` when it does):
 * `select`/`user` take `values` of ids, `text` takes `values` of text,
 * `number_range` a `range` of numbers, `date_range` a `range` of
 * `YYYY-MM-DD` days or a `relative` range; a range's `from` is at most its
 * `to`. Also checks a control's saved `default`.
 */
export function controlValueIssue(
  kind: FilterControlKind,
  value: FilterControlValue,
): string | null {
  switch (kind) {
    case 'select':
    case 'user':
    case 'text':
      if (!('values' in value)) return `A ${kind} filter takes values`;
      if (!value.values.every((item) => typeof item === 'string')) {
        return `The values of a ${kind} filter are strings`;
      }
      return null;
    case 'number_range': {
      if (!('range' in value)) return 'A number range filter takes a range';
      const { from, to } = value.range;
      if (![from, to].every((bound) => bound === null || typeof bound === 'number')) {
        return 'The bounds of a number range are numbers';
      }
      if (typeof from === 'number' && typeof to === 'number' && from > to) {
        return 'The range starts after it ends';
      }
      return null;
    }
    case 'date_range': {
      if ('relative' in value) return null;
      if (!('range' in value)) return 'A date range filter takes a range or a relative range';
      const { from, to } = value.range;
      if (![from, to].every((bound) => bound === null || isCivilDate(bound))) {
        return 'The bounds of a date range are YYYY-MM-DD days';
      }
      if (typeof from === 'string' && typeof to === 'string' && from > to) {
        return 'The range starts after it ends';
      }
      return null;
    }
  }
}

const exact = (day: string) => ({ $date: { exact: day } });

/**
 * The filter-DSL condition of a control value on `field` (field ids), for
 * the viewer at `now` in `timeZone` (relative date ranges). `null` when the
 * value filters nothing (no values, a range without bounds); `'unfit'` when
 * the field no longer fits the control (converted since it was saved). The
 * value must have passed {@link controlValueIssue}. Operators:
 * `is_any_of` (single select), `has_any_of` (multiple select, users),
 * `contains` (text, any of the values), `between`/`gte`/`lte` (numbers),
 * `between`/`on_or_after`/`on_or_before` with exact days (dates).
 */
export function controlFilterOf(
  control: Pick<ControlLiveFilter, 'control' | 'field' | 'value'>,
  field: FilterFieldMeta,
  now: Date | number,
  timeZone: string,
): FilterNode | null | 'unfit' {
  let group: string;
  let element: string;
  try {
    const profile = fieldProfile(field);
    group = profile.group;
    element = profile.element;
  } catch {
    return 'unfit';
  }
  const { value } = control;
  const id = control.field;
  const values =
    'values' in value
      ? value.values.filter((item): item is string => typeof item === 'string')
      : [];
  switch (control.control) {
    case 'select':
      if (element !== 'option' || (group !== 'single_select' && group !== 'multi')) return 'unfit';
      if (values.length === 0) return null;
      return {
        field: id,
        operator: group === 'single_select' ? 'is_any_of' : 'has_any_of',
        value: values,
      };
    case 'user':
      if (group !== 'multi' || element !== 'user') return 'unfit';
      if (values.length === 0) return null;
      return { field: id, operator: 'has_any_of', value: values };
    case 'text': {
      if (group !== 'text') return 'unfit';
      const texts = values.filter((item) => item.trim() !== '');
      if (texts.length === 0) return null;
      const items: FilterNode[] = texts.map((text) => ({
        field: id,
        operator: 'contains',
        value: text,
      }));
      return items.length === 1 ? (items[0] as FilterNode) : { op: 'or', items };
    }
    case 'number_range': {
      if (group !== 'number') return 'unfit';
      if (!('range' in value)) return null;
      const { from, to } = value.range;
      const low = typeof from === 'number' ? from : null;
      const high = typeof to === 'number' ? to : null;
      if (low !== null && high !== null) {
        return { field: id, operator: 'between', value: [low, high] };
      }
      if (low !== null) return { field: id, operator: 'gte', value: low };
      if (high !== null) return { field: id, operator: 'lte', value: high };
      return null;
    }
    case 'date_range': {
      if (group !== 'datetime') return 'unfit';
      let from: string | null = null;
      let to: string | null = null;
      if ('relative' in value) {
        ({ from, to } = relativeDateRange(value.relative, now, timeZone));
      } else if ('range' in value) {
        from = typeof value.range.from === 'string' ? value.range.from : null;
        to = typeof value.range.to === 'string' ? value.range.to : null;
      }
      if (from !== null && to !== null) {
        return { field: id, operator: 'between', value: [exact(from), exact(to)] };
      }
      if (from !== null) return { field: id, operator: 'on_or_after', value: exact(from) };
      if (to !== null) return { field: id, operator: 'on_or_before', value: exact(to) };
      return null;
    }
  }
}
