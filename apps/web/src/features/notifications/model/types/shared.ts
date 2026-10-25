import type { ItemKind } from '../items';
import type { NotificationDto } from '@cellhive/contracts';

/**
 * What a renderer of one notification type needs (T552, FRONTEND §14.1).
 * Pure: the panel passes i18next's `t` of the `notifications` namespace,
 * the names it could resolve with the viewer's access and the formatters
 * of the viewer's language and time zone; tests pass the same.
 */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface ItemContext {
  readonly t: Translate;
  readonly locale: string;
  /** Formatters of the viewer's language and time zone (`useFormatters`). */
  readonly format: {
    readonly timeZone: string;
    readonly dateTime: (value: string | Date) => string;
    readonly number: (value: number) => string;
  };
  /**
   * Name of a field of the item's table as the viewer sees it now, or
   * `null` (no longer readable, still loading, deleted).
   */
  readonly fieldName: (fieldId: string) => string | null;
  /** Name of the item's table when the renderer needs it (`import.finished`), else `null`. */
  readonly tableName: string | null;
  readonly now: Date;
}

/** A status chip: always text (and an icon in the panel), never color alone. */
export interface ItemPill {
  readonly label: string;
  readonly tone: 'neutral' | 'warning' | 'danger' | 'success';
}

export interface ItemView {
  readonly kind: ItemKind;
  readonly title: string;
  readonly body: string | null;
  readonly pill: ItemPill | null;
  /**
   * `record.assigned` of a bulk write, or `record.followed_changed` of an
   * incoming webhook's writes (T608): the records the panel can list (≤ 20
   * of `count`).
   */
  readonly records: { readonly ids: readonly string[]; readonly count: number } | null;
  /** `import.finished` with failed rows: the job whose error report may still be downloaded. */
  readonly report: { readonly jobId: string } | null;
}

export const NO_EXTRAS = { pill: null, records: null, report: null } as const;

/** A string field of `data` (stored parameters, CONTRACTS §22.1), else `null`. */
export function str(item: Pick<NotificationDto, 'data'>, key: string): string | null {
  const value = item.data[key];
  return typeof value === 'string' ? value : null;
}

/** A non-negative integer field of `data`, else `null`. */
export function int(item: Pick<NotificationDto, 'data'>, key: string): number | null {
  const value = item.data[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** `data.source` names an incoming webhook (T608: writes gathered per hook, table and minute). */
export function hasWebhookSource(item: Pick<NotificationDto, 'data'>): boolean {
  const source = item.data.source;
  return (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as Record<string, unknown>).incoming_webhook_id === 'string'
  );
}

/** Body lines (the panel keeps line breaks); `null` when none. */
export function lines(...parts: readonly (string | null)[]): string | null {
  const kept = parts.filter((part): part is string => part !== null && part !== '');
  return kept.length === 0 ? null : kept.join('\n');
}

/** A list of strings in `data` (ids), else `[]`. */
export function strings(item: Pick<NotificationDto, 'data'>, key: string): string[] {
  const value = item.data[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Most field names spelled out in a title; the others are counted ("and 2 more"). */
export const FIELD_NAMES_SHOWN = 3;

/**
 * "Status, Owner and 2 more" for the fields of `ids` the viewer still sees,
 * in the language's list style; `null` when none can be named.
 */
export function fieldList(ids: readonly string[], ctx: ItemContext): string | null {
  const names = ids
    .map((id) => ctx.fieldName(id))
    .filter((name): name is string => name !== null && name !== '');
  if (names.length === 0) return null;
  const shown = names.slice(0, FIELD_NAMES_SHOWN);
  const hidden = names.length - shown.length;
  const parts =
    hidden > 0
      ? [
          ...shown,
          ctx.t('item.moreFields', { count: hidden, formatted: ctx.format.number(hidden) }),
        ]
      : shown;
  return new Intl.ListFormat(ctx.locale, { style: 'long', type: 'conjunction' }).format(parts);
}

/** «Title» of the record or table the item is about, or "a record" when it cannot be named. */
export function quoted(title: string | null, ctx: ItemContext, fallbackKey: string): string {
  return title === null || title === ''
    ? ctx.t(fallbackKey)
    : ctx.t('item.quoted', { text: title });
}

/**
 * Who did it: a user's name; "An automation" / "Someone" otherwise (an
 * actor without a name: API token, share link, system, a user who left).
 */
export function actorLabel(item: Pick<NotificationDto, 'actor'>, ctx: ItemContext): string {
  const { actor } = item;
  if (actor?.name != null && actor.name !== '') return actor.name;
  return actor?.type === 'automation' ? ctx.t('item.actorAutomation') : ctx.t('item.actorSomeone');
}
