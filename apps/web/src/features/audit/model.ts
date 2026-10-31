import {
  AUDIT_ACTION_PREFIXES,
  AUDIT_VIA_KINDS,
  MAX_AUDIT_FILTER_VALUES,
  type AuditActionPrefix,
  type AuditLogEntryDto,
  type AuditRefsDto,
  type AuditViaKind,
} from '@cellhive/contracts';

/**
 * Pure model of the audit log viewer (T716, CONTRACTS §11.4): filters in the
 * URL, the API query they stand for, and how an entry is named from `refs`.
 * Nothing here renders: values stay text (never HTML) for the components.
 */

// --- Action groups ---------------------------------------------------------------------

/**
 * The action groups (`action_prefix`) as the UI shows them: under the rows of
 * the CONTRACTS §8 catalogue (Record, Schema, …). Every prefix is in exactly
 * one category (unit test).
 */
export const ACTION_CATEGORIES = [
  { key: 'record', prefixes: ['record.'] },
  { key: 'schema', prefixes: ['table.', 'field.', 'view.', 'schema.'] },
  {
    key: 'people',
    prefixes: [
      'org.',
      'org_member.',
      'invitation.',
      'group.',
      'group_member.',
      'workspace.',
      'workspace_member.',
      'email_identity.',
      'setup.',
      'email.',
    ],
  },
  { key: 'access', prefixes: ['base.', 'role.', 'role_assignment.', 'permission.'] },
  {
    key: 'sharing',
    prefixes: ['share_link.', 'form.', 'webhook.', 'schedule.', 'api_token.', 'incoming_webhook.'],
  },
  { key: 'automation', prefixes: ['automation.', 'button.', 'dashboard.', 'ai.', 'ai_settings.'] },
  {
    key: 'security',
    prefixes: [
      'auth.',
      'user.',
      'export.',
      'mcp.',
      'audit.',
      'secret.',
      'http_allowlist.',
      'user_channel.',
    ],
  },
] as const satisfies readonly { key: string; prefixes: readonly AuditActionPrefix[] }[];

/** i18n key of a group: the prefix without its dot (`record.` → `record`). */
export function prefixKey(prefix: string): string {
  return prefix.endsWith('.') ? prefix.slice(0, -1) : prefix;
}

/**
 * An action split for its label: the group (`record.`) and the verb
 * (`updated`; `run.failed` → `run_failed`, i18next keys cannot hold dots).
 * `null` when the action has no known group (shown as is).
 */
export function actionParts(action: string): { prefix: AuditActionPrefix; verb: string } | null {
  const dot = action.indexOf('.');
  if (dot <= 0) return null;
  const prefix = action.slice(0, dot + 1);
  if (!(AUDIT_ACTION_PREFIXES as readonly string[]).includes(prefix)) return null;
  return { prefix: prefix as AuditActionPrefix, verb: verbKey(action.slice(dot + 1)) };
}

export function verbKey(verb: string): string {
  return verb.replaceAll('.', '_');
}

// --- Filters ---------------------------------------------------------------------------

export const RANGE_PRESETS = ['24h', '7d', '30d', '90d', 'all', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const DEFAULT_RANGE: RangePreset = '7d';

const PRESET_MS: Record<Exclude<RangePreset, 'all' | 'custom'>, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};

/** Entity types offered by the "Object type" filter (the API takes any). */
export const ENTITY_TYPES = [
  'record',
  'table',
  'field',
  'view',
  'base',
  'workspace',
  'org',
  'user',
  'group',
  'role',
  'share_link',
  'api_token',
  'automation',
  'incoming_webhook',
  'secret',
  'email_identity',
  'job',
] as const;

export interface AuditFilters {
  readonly range: RangePreset;
  /** `YYYY-MM-DD` in the viewer's time zone, both inclusive (custom range only). */
  readonly from: string | null;
  readonly to: string | null;
  readonly actors: readonly string[];
  readonly prefixes: readonly AuditActionPrefix[];
  readonly actions: readonly string[];
  readonly entityType: string | null;
  /** Organization page only. */
  readonly baseId: string | null;
  readonly via: readonly AuditViaKind[];
  readonly batchId: string | null;
}

export const DEFAULT_FILTERS: AuditFilters = {
  range: DEFAULT_RANGE,
  from: null,
  to: null,
  actors: [],
  prefixes: [],
  actions: [],
  entityType: null,
  baseId: null,
  via: [],
  batchId: null,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/u;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)].slice(0, MAX_AUDIT_FILTER_VALUES);
}

/** Filters from the page URL; unknown or malformed values are dropped. */
export function parseFilters(params: URLSearchParams): AuditFilters {
  const range = params.get('range');
  const preset = (RANGE_PRESETS as readonly string[]).includes(range ?? '')
    ? (range as RangePreset)
    : DEFAULT_RANGE;
  const from = params.get('from');
  const to = params.get('to');
  const customFrom = from !== null && DATE.test(from) ? from : null;
  const customTo = to !== null && DATE.test(to) ? to : null;
  const custom = preset === 'custom' && (customFrom !== null || customTo !== null);
  const one = (key: string) => {
    const value = params.get(key);
    return value !== null && TOKEN.test(value) ? value : null;
  };
  return {
    range: preset === 'custom' && !custom ? DEFAULT_RANGE : preset,
    from: custom ? customFrom : null,
    to: custom ? customTo : null,
    actors: unique(params.getAll('actor').filter((value) => TOKEN.test(value))),
    prefixes: unique(
      params
        .getAll('group')
        .filter((value): value is AuditActionPrefix =>
          (AUDIT_ACTION_PREFIXES as readonly string[]).includes(value),
        ),
    ),
    actions: unique(params.getAll('action').filter((value) => TOKEN.test(value))),
    entityType: one('entity'),
    baseId: one('base'),
    via: unique(
      params
        .getAll('via')
        .filter((value): value is AuditViaKind =>
          (AUDIT_VIA_KINDS as readonly string[]).includes(value),
        ),
    ),
    batchId: one('batch'),
  };
}

/** The URL search of `filters` (defaults left out). */
export function filtersToParams(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.range !== DEFAULT_RANGE) params.set('range', filters.range);
  if (filters.range === 'custom') {
    if (filters.from !== null) params.set('from', filters.from);
    if (filters.to !== null) params.set('to', filters.to);
  }
  for (const actor of filters.actors) params.append('actor', actor);
  for (const prefix of filters.prefixes) params.append('group', prefix);
  for (const action of filters.actions) params.append('action', action);
  if (filters.entityType !== null) params.set('entity', filters.entityType);
  if (filters.baseId !== null) params.set('base', filters.baseId);
  for (const via of filters.via) params.append('via', via);
  if (filters.batchId !== null) params.set('batch', filters.batchId);
  return params;
}

/** Whether anything besides the default time range narrows the list. */
export function hasNarrowingFilters(filters: AuditFilters): boolean {
  return (
    filters.actors.length > 0 ||
    filters.prefixes.length > 0 ||
    filters.actions.length > 0 ||
    filters.entityType !== null ||
    filters.baseId !== null ||
    filters.via.length > 0 ||
    filters.batchId !== null
  );
}

/** Offset of `timeZone` from UTC at `instant`, in ms (`Asia/Ho_Chi_Minh` → +7 h). */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a calendar day (`YYYY-MM-DD`) starts in `timeZone`, plus `days`. */
export function startOfDay(date: string, timeZone: string, days = 0): Date {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day + days);
  let instant = guess - zoneOffsetMs(guess, timeZone);
  // Across a DST change the offset at the result differs from the guess's.
  instant = guess - zoneOffsetMs(instant, timeZone);
  return new Date(instant);
}

/** `YYYY-MM-DD` of `instant` in `timeZone`. */
export function dayOf(instant: Date, timeZone: string): string {
  const shifted = new Date(instant.getTime() + zoneOffsetMs(instant.getTime(), timeZone));
  return shifted.toISOString().slice(0, 10);
}

/** `from`/`to` (ISO, `to` exclusive) of a range; `now` anchors the presets. */
export function rangeBounds(
  filters: Pick<AuditFilters, 'range' | 'from' | 'to'>,
  now: number,
  timeZone: string,
): { from?: string; to?: string } {
  if (filters.range === 'all') return {};
  if (filters.range === 'custom') {
    return {
      ...(filters.from === null ? {} : { from: startOfDay(filters.from, timeZone).toISOString() }),
      ...(filters.to === null ? {} : { to: startOfDay(filters.to, timeZone, 1).toISOString() }),
    };
  }
  return { from: new Date(now - PRESET_MS[filters.range]).toISOString() };
}

/** Query (and export body `filters`) of the API for `filters`. */
// A type (not an interface): it is passed as a query-string record.
export type AuditQuery = {
  actor_id?: string[];
  action_prefix?: AuditActionPrefix[];
  action?: string[];
  entity_type?: string;
  base_id?: string;
  via?: AuditViaKind[];
  batch_id?: string;
  from?: string;
  to?: string;
};

export function toQuery(
  filters: AuditFilters,
  now: number,
  timeZone: string,
  scope: 'org' | 'base',
): AuditQuery {
  const query: AuditQuery = { ...rangeBounds(filters, now, timeZone) };
  if (filters.actors.length > 0) query.actor_id = [...filters.actors];
  if (filters.prefixes.length > 0) query.action_prefix = [...filters.prefixes];
  if (filters.actions.length > 0) query.action = [...filters.actions];
  if (filters.entityType !== null) query.entity_type = filters.entityType;
  if (scope === 'org' && filters.baseId !== null) query.base_id = filters.baseId;
  if (filters.via.length > 0) query.via = [...filters.via];
  if (filters.batchId !== null) query.batch_id = filters.batchId;
  return query;
}

// --- Names from `refs` -----------------------------------------------------------------

export const EMPTY_REFS: AuditRefsDto = { users: {}, fields: {}, tables: {}, api_tokens: {} };

/** Merges the `refs` of every loaded page ("Load more" keeps the earlier names). */
export function mergeRefs(pages: readonly { refs?: AuditRefsDto | undefined }[]): AuditRefsDto {
  const merged = {
    users: {} as AuditRefsDto['users'],
    fields: {} as AuditRefsDto['fields'],
    tables: {} as AuditRefsDto['tables'],
    api_tokens: {} as AuditRefsDto['api_tokens'],
  };
  for (const page of pages) {
    if (page.refs === undefined) continue;
    Object.assign(merged.users, page.refs.users);
    Object.assign(merged.fields, page.refs.fields);
    Object.assign(merged.tables, page.refs.tables);
    Object.assign(merged.api_tokens, page.refs.api_tokens);
  }
  return merged;
}

/**
 * A name to show, or the id with "deleted" (`name: null, deleted: true`),
 * or an id the page cannot name (`name: null, deleted: false`).
 */
export interface Named {
  readonly id: string | null;
  readonly name: string | null;
  readonly deleted: boolean;
}

export type ActorLabel =
  | ({ readonly kind: 'user' } & Named)
  | ({ readonly kind: 'automation' } & Named)
  | ({ readonly kind: 'share_link' } & Named)
  | { readonly kind: 'system' | 'api_token' | 'webhook' };

export function actorOf(entry: AuditLogEntryDto, refs: AuditRefsDto): ActorLabel {
  const { actor } = entry;
  switch (actor.type) {
    case 'user': {
      const ref = actor.id === null ? undefined : refs.users[actor.id];
      const name = ref?.display_name ?? actor.name;
      return { kind: 'user', id: actor.id, name, deleted: name === null };
    }
    case 'automation':
      return { kind: 'automation', id: actor.id, name: actor.name, deleted: false };
    case 'share_link':
      return { kind: 'share_link', id: actor.id, name: actor.name, deleted: false };
    case 'api_token':
    case 'webhook':
    case 'system':
      return { kind: actor.type };
  }
}

/** Where the change came from besides the actor (`via`). */
export type ViaLabel =
  | { readonly kind: 'api_token'; readonly name: string | null }
  | { readonly kind: 'automation' | 'share_link' | 'import' | 'reverted' | 'incoming_webhook' };

export function viaOf(entry: AuditLogEntryDto, refs: AuditRefsDto): ViaLabel[] {
  const via = entry.via;
  if (via === null) return [];
  const labels: ViaLabel[] = [];
  if ('api_token_id' in via) {
    // A name only when the server gave one (org owner/admin, the token's owner):
    // a masked token (`api_token_id: null`) reads "through an API token".
    const id = via.api_token_id ?? null;
    const name = id === null ? null : (via.api_token_name ?? refs.api_tokens[id]?.name ?? null);
    labels.push({ kind: 'api_token', name });
  }
  if (via.automation_id !== undefined) labels.push({ kind: 'automation' });
  if (via.incoming_webhook_id !== undefined) labels.push({ kind: 'incoming_webhook' });
  if (via.share_link_id !== undefined) labels.push({ kind: 'share_link' });
  if (via.import_job_id !== undefined) labels.push({ kind: 'import' });
  if (via.reverted_from !== undefined) labels.push({ kind: 'reverted' });
  return labels;
}

export interface EntityLabel extends Named {
  readonly type: string;
  /** The table a record or field belongs to, when named. */
  readonly table: Named | null;
}

function tableNamed(id: string | null, refs: AuditRefsDto): Named | null {
  if (id === null) return null;
  const ref = refs.tables[id];
  return ref === undefined
    ? { id, name: null, deleted: true }
    : { id, name: ref.name, deleted: ref.deleted };
}

/**
 * The object of an entry: tables, fields, users and API tokens are named
 * from `refs` (gone → id + "deleted"), bases from `baseNames`; others by
 * type and id.
 */
export function entityOf(
  entry: AuditLogEntryDto,
  refs: AuditRefsDto,
  baseNames: ReadonlyMap<string, string>,
): EntityLabel {
  const id = entry.entity_id;
  const type = entry.entity_type;
  const plain = { type, id, name: null, deleted: false, table: null };
  if (id === null) return plain;
  switch (type) {
    case 'record':
      return { ...plain, table: tableNamed(entry.table_id, refs) };
    case 'table': {
      const table = tableNamed(id, refs);
      return { ...plain, name: table?.name ?? null, deleted: table?.deleted ?? true };
    }
    case 'field': {
      const field = refs.fields[id];
      return field === undefined
        ? { ...plain, deleted: true, table: tableNamed(entry.table_id, refs) }
        : {
            ...plain,
            name: field.name,
            deleted: field.deleted,
            table: tableNamed(field.table_id, refs),
          };
    }
    case 'user': {
      const name = refs.users[id]?.display_name ?? null;
      return { ...plain, name, deleted: name === null };
    }
    case 'api_token': {
      const token = refs.api_tokens[id];
      return { ...plain, name: token?.name ?? null };
    }
    case 'base':
      return { ...plain, name: baseNames.get(id) ?? null };
    default:
      return plain;
  }
}

// --- Before / after --------------------------------------------------------------------

export interface DiffRow {
  readonly key: string;
  /** Field entries of a record: the current field name; `null` → id + "deleted". */
  readonly label: Named;
  /** Text of the values (JSON for anything but a string); `null` = no value. */
  readonly before: string | null;
  readonly after: string | null;
  readonly changed: boolean;
}

/** Text of a stored value: strings as they are, anything else as JSON. Never HTML. */
export function valueText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function isRedacted(entry: AuditLogEntryDto): boolean {
  return entry.before?.['redacted'] === true || entry.after?.['redacted'] === true;
}

/**
 * Before/after of an entry as rows: for records each key is a field id,
 * named by its **current** name from `refs` (a field removed for good →
 * id + "deleted"); other entries keep their keys. Order: `after`'s keys,
 * then keys only in `before`.
 */
export function diffRows(entry: AuditLogEntryDto, refs: AuditRefsDto): DiffRow[] {
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])];
  const fieldKeys = entry.entity_type === 'record';
  return keys.map((key) => {
    const field = fieldKeys ? refs.fields[key] : undefined;
    const label: Named = fieldKeys
      ? field === undefined
        ? { id: key, name: null, deleted: true }
        : { id: key, name: field.name, deleted: field.deleted }
      : { id: key, name: key, deleted: false };
    const was = valueText(before[key]);
    const now = valueText(after[key]);
    return { key, label, before: was, after: now, changed: was !== now };
  });
}

/** An export's download link, only when it is one of this API's paths. */
export function safeDownloadUrl(result: Record<string, unknown> | null): string | null {
  const url = result?.['download_url'];
  return typeof url === 'string' && /^\/api\/v1\/[A-Za-z0-9/_.-]+$/u.test(url) ? url : null;
}
