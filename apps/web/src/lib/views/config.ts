import {
  formConfigInputSchema,
  gridConfigInputSchema,
  kanbanConfigInputSchema,
  type StoredFormSettings,
  type StoredKanbanSettings,
  type ColorRuleColor,
  type ColorRuleTarget,
  type StoredRecordDetailSettings,
  type SummaryFunction,
  type ViewConfigDto,
} from '@cellhive/contracts';

import { stableQueryHash } from '../query/keys';

/**
 * Keys of a view config a user changes from the view screens (SPEC §8,
 * CONTRACTS §15). `kanban` is the board settings (T314, kanban views only);
 * `form` the form builder's settings (T315, form views only).
 */
export const VIEW_CONFIG_KEYS = [
  'filter',
  'sort',
  'group',
  'hidden_fields',
  'field_order',
  'column_widths',
  'frozen_count',
  'row_height',
  'tree',
  'kanban',
  'form',
  'record_detail',
  'summaries',
  'color_rules',
] as const;
export type ViewConfigKey = (typeof VIEW_CONFIG_KEYS)[number];

interface ConfigSort {
  field: string;
  direction: 'asc' | 'desc';
}

/** The keys of {@link VIEW_CONFIG_KEYS} with plain string ids (ids come from the field list). */
export interface ViewConfigValues {
  filter: Record<string, unknown> | null;
  sort: ConfigSort[];
  group: ConfigSort[];
  hidden_fields: string[];
  field_order: string[];
  column_widths: Record<string, number>;
  frozen_count: number;
  row_height: ViewConfigDto['row_height'];
  tree: ViewConfigDto['tree'];
  /**
   * Record panel settings (T416): columns of the embedded sub-table of each
   * link field (`record_detail.link_columns`, CONTRACTS §15), saved whole.
   */
  record_detail?: StoredRecordDetailSettings | undefined;
  /**
   * (T472) The summary bar of a grid view: field id → function; saved whole.
   * Absent in configs saved before T472 (read as none).
   */
  summaries?: Record<string, SummaryFunction> | undefined;
  /**
   * (T816) Color rules of a grid view, order = priority; saved whole, never
   * temporary (the server evaluates the saved rules only). Responses mark
   * rules naming a deleted field `broken`.
   */
  color_rules?: ViewColorRule[] | undefined;
  /** Board settings of a kanban view (absent on other types); saved whole. */
  kanban?: StoredKanbanSettings | undefined;
  /** Settings of a form view (absent on other types); saved whole (T315). */
  form?: StoredFormSettings | undefined;
}

/**
 * A color rule as the screens read it (T816): a member's view returns its
 * filter and `broken`; a shared view returns neither (the server evaluates).
 */
export interface ViewColorRule {
  id: string;
  enabled: boolean;
  filter?: Record<string, unknown> | null | undefined;
  color: ColorRuleColor;
  target: ColorRuleTarget;
  field_id: string | null;
  broken?: boolean | undefined;
}

/** A view config as the screens read it: saved, being saved and temporary changes merged. */
export type EffectiveViewConfig = Omit<ViewConfigDto, ViewConfigKey> & ViewConfigValues;

/** Some top-level keys of a config, each replacing the stored value as a `PATCH` does. */
export type ViewConfigPatch = Partial<ViewConfigValues>;

/**
 * Column layout (T310): saved at once (debounced) by those who may save the
 * view.
 */
export const LAYOUT_KEYS: readonly ViewConfigKey[] = [
  'hidden_fields',
  'field_order',
  'column_widths',
  'frozen_count',
];

/**
 * Changed like in Lark (T311): temporary, seen only by the user who made
 * them, until "Save" (Ctrl/⌘+S) — also for those who may save the view
 * (`change(patch, { temporary: true })`).
 */
export const TEMPORARY_KEYS: readonly ViewConfigKey[] = [
  'filter',
  'sort',
  'group',
  'row_height',
  // T472 (S4b decision 8): the summary bar shares the Clear/Save bar.
  'summaries',
];

/** Keys whose change reorders or refilters rows (the grid refetches its blocks). */
export const QUERY_KEYS: readonly ViewConfigKey[] = ['filter', 'sort', 'group'];

export function isEmptyPatch(patch: ViewConfigPatch): boolean {
  return Object.keys(patch).length === 0;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || stableQueryHash(a) === stableQueryHash(b);
}

/** The config shown: saved, then changes being saved, then temporary ones. */
export function effectiveConfig(
  saved: EffectiveViewConfig,
  pending: ViewConfigPatch,
  draft: ViewConfigPatch,
): EffectiveViewConfig {
  if (isEmptyPatch(pending) && isEmptyPatch(draft)) return saved;
  return { ...saved, ...pending, ...draft };
}

/** Keys of `patch` whose value differs from `saved` (what "unsaved" means). */
export function changedKeys(saved: EffectiveViewConfig, patch: ViewConfigPatch): ViewConfigKey[] {
  return (Object.keys(patch) as ViewConfigKey[]).filter(
    (key) => !sameValue(patch[key], saved[key]),
  );
}

export function pickKeys(patch: ViewConfigPatch, keys: readonly ViewConfigKey[]): ViewConfigPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => keys.includes(key as ViewConfigKey)),
  );
}

export function omitKeys(patch: ViewConfigPatch, keys: readonly ViewConfigKey[]): ViewConfigPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => !keys.includes(key as ViewConfigKey)),
  );
}

const FIELD_ID = /^fld_[A-Za-z0-9]+$/u;

/** Field ids a config value names: in lists, sort/group, filter conditions, keys (`column_widths`). */
export function referencedFieldIds(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (FIELD_ID.test(value)) into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) referencedFieldIds(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (FIELD_ID.test(key)) into.add(key);
      referencedFieldIds(item, into);
    }
  }
  return into;
}

/** Keys of a (temporary) patch naming a field outside `readable` (not readable, or deleted). */
export function unreadableKeys(
  patch: ViewConfigPatch,
  readable: ReadonlySet<string>,
): ViewConfigKey[] {
  return (Object.keys(patch) as ViewConfigKey[]).filter((key) => {
    // `record_detail` (T416): keys are link fields of this table, values fields of the
    // linked tables (not in `readable`; the sub-table ignores columns it cannot read).
    const named =
      key === 'record_detail'
        ? Object.keys(patch.record_detail?.link_columns ?? {})
        : [...referencedFieldIds(patch[key])];
    return named.some((id) => !readable.has(id));
  });
}

/** A temporary `form` is saved whole: a partial one (older app version) is dropped. */
function completeForm(form: object | undefined): boolean {
  if (form === undefined) return true;
  const keys: readonly (keyof StoredFormSettings)[] = [
    'title',
    'description',
    'cover_attachment_id',
    'fields',
    'success_message',
    'redirect_url',
    'allow_multiple_submissions',
    'require_login',
    'submission_limit',
  ];
  return keys.every((key) => key in form);
}

/**
 * A stored draft from localStorage: untrusted (another app version, a user
 * edit). Validated with the contract's config shape; anything invalid is
 * dropped as a whole.
 */
export function parseDraft(raw: string | null): ViewConfigPatch {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    // A grid draft may hold `summaries` (T472), which kanban and form configs refuse.
    const grid = gridConfigInputSchema.safeParse(value);
    if (grid.success) return pickKeys(grid.data as ViewConfigPatch, VIEW_CONFIG_KEYS);
    // The kanban and form shapes are the grid one plus `kanban` / `form` (a grid view stores neither).
    const kanban = kanbanConfigInputSchema.safeParse(value);
    if (kanban.success) return pickKeys(kanban.data as ViewConfigPatch, VIEW_CONFIG_KEYS);
    const form = formConfigInputSchema.safeParse(value);
    if (!form.success || !completeForm(form.data.form)) return {};
    return pickKeys(form.data as ViewConfigPatch, VIEW_CONFIG_KEYS);
  } catch {
    return {};
  }
}

export function serializeDraft(draft: ViewConfigPatch): string | null {
  return isEmptyPatch(draft) ? null : JSON.stringify(draft);
}
