import { andFilters, type FilterNode } from './filter.js';
import { isViewVisible } from './prepare.js';

import type { EffectiveAccess, TableAccess } from './access.js';
import type { InternalAccess, ResolvedBaseAccess } from './resolve.js';
import type { Id } from '@cellhive/contracts';

/**
 * Share links (SPEC §14.1 step 7, §15A.2; CONTRACTS §16; BACKLOG T304).
 *
 * A link acts as principal `share_link`. What it may do is the
 * intersection of
 * 1. the **current** access of the user who created it (resolved again on
 *    every request: a creator who lost access makes the link gone, `410`),
 * 2. the scope of its target, and
 * 3. read only (a form link: create only).
 *
 * The result is an ordinary `ResolvedBaseAccess` covering a single table,
 * so the record services apply it like any other access.
 */

/** What a link points at, as loaded from the current meta. */
export type ShareLinkScope =
  | {
      readonly kind: 'view';
      readonly tableId: Id<'tbl'>;
      readonly viewId: Id<'viw'>;
      /** The view's saved filter (DSL, field ids); always applied, never shown. */
      readonly filter: FilterNode | null;
      /** `hidden_fields` of the view: never returned through the link. */
      readonly hiddenFields: readonly Id<'fld'>[];
    }
  | {
      readonly kind: 'form';
      readonly tableId: Id<'tbl'>;
      readonly viewId: Id<'viw'>;
      /** Fields of the form (`config.form.fields[].field`). */
      readonly formFields: readonly Id<'fld'>[];
    }
  | {
      readonly kind: 'dashboard';
      readonly dashboardId: Id<'dsh'>;
      /**
       * Tables the dashboard reads: those of its data widgets, filter
       * controls and global filter targets (BACKLOG T809).
       */
      readonly tableIds: readonly Id<'tbl'>[];
    };

/** Whether an access reads a dashboard (SPEC §10, §14.1: base admins, or `dashboards.<id>`). */
export function canReadDashboard(
  access: Pick<EffectiveAccess, 'is_admin' | 'dashboards'>,
  dashboardId: Id<'dsh'>,
): boolean {
  return access.is_admin || access.dashboards[dashboardId] === 'read_only';
}

/** Whether an access may create and manage share links (SPEC §15A.1). */
export function canShareLinks(access: Pick<EffectiveAccess, 'is_admin' | 'base_rule'>): boolean {
  return access.is_admin || access.base_rule.share_link;
}

/** Organization policy for `audience = public` (CONTRACTS §16). */
export type PublicSharingPolicy = 'allowed' | 'forms_only' | 'disabled';

/** Whether the organization policy lets a link of this kind be public. */
export function publicSharingAllows(
  policy: PublicSharingPolicy,
  targetType: 'view' | 'form' | 'dashboard',
): boolean {
  return policy === 'allowed' || (policy === 'forms_only' && targetType === 'form');
}

/** Lifecycle of a stored link, before any permission check. */
export type ShareLinkState = 'active' | 'disabled' | 'expired' | 'revoked';

export function shareLinkState(
  link: {
    readonly enabled: boolean;
    readonly expiresAt: Date | null;
    readonly revokedAt: Date | null;
  },
  now: Date,
): ShareLinkState {
  if (link.revokedAt !== null) return 'revoked';
  if (!link.enabled) return 'disabled';
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

const EMPTY_BASE_RULE = { copy: false, download: false, share_link: false } as const;

function scopedAccess(
  tables: Record<Id<'tbl'>, TableAccess>,
  internal: InternalAccess,
  dashboards: EffectiveAccess['dashboards'] = {},
): ResolvedBaseAccess {
  return {
    access: {
      role: null,
      is_admin: false,
      base_rule: { ...EMPTY_BASE_RULE },
      tables,
      dashboards,
    },
    internal,
  };
}

/**
 * A dashboard link (BACKLOG T809, SPEC §15A.2): the creator's current
 * access ∩ the tables the dashboard reads, read only — each of those tables
 * the creator reads with the fields they read (`read`) and their read rule;
 * no operation, view, copy, download or file; the dashboard itself
 * `read_only` and no other. `null` when the creator no longer reads the
 * dashboard.
 */
function dashboardLinkAccess(
  creator: ResolvedBaseAccess,
  scope: Extract<ShareLinkScope, { kind: 'dashboard' }>,
): ResolvedBaseAccess | null {
  if (!canReadDashboard(creator.access, scope.dashboardId)) return null;
  const tables: Record<Id<'tbl'>, TableAccess> = {};
  const readFilters: InternalAccess['readFilters'] = {};
  for (const tableId of new Set(scope.tableIds)) {
    const table = creator.access.tables[tableId];
    if (table === undefined) continue;
    const fields: TableAccess['fields'] = {};
    for (const fieldId of Object.keys(table.fields) as Id<'fld'>[]) fields[fieldId] = 'read';
    tables[tableId] = {
      perm: 'read_only',
      operations: [],
      view_rule: { allow_edit: false, visible_views: [] },
      read_scope: table.read_scope,
      fields,
      option_edit_fields: [],
      file_download_fields: [],
    };
    readFilters[tableId] = creator.internal.readFilters[tableId] ?? null;
  }
  return scopedAccess(
    tables,
    { editFilters: {}, readFilters },
    {
      [scope.dashboardId]: 'read_only',
    },
  );
}

/**
 * Effective access of a share link, or `null` when the link cannot act at
 * all: the creator has no access to the base any more, may no longer share
 * (`base_rule.share_link`, admin), cannot read the table or the target view
 * (`visible_views`), or — for a form — may no longer add records. The
 * caller answers `410 SHARE_LINK_GONE` for `null`.
 *
 * - `view`: `read_only`, no operation; fields = creator's readable fields
 *   minus the view's `hidden_fields`; read rule = creator's read rule AND
 *   the view filter; `visible_views` = the target view only.
 * - `form`: `edit` with `add` only; fields = form fields the creator may
 *   write on create (`edit`/`create`), each downgraded to `create`; the
 *   creator's edit rule still applies to the new record (P14).
 * - `dashboard` (T809): the dashboard `read_only` when the creator still
 *   reads it (else `null`); the tables it reads as the creator reads them,
 *   `read_only` — see {@link dashboardLinkAccess}.
 *
 * The link never gets copy, download, option editing or file download
 * rights here; link settings (`allow_copy`…) are applied by the share
 * endpoints on top.
 */
export function resolveShareLinkAccess(
  creator: ResolvedBaseAccess | null,
  scope: ShareLinkScope,
): ResolvedBaseAccess | null {
  if (creator === null || !canShareLinks(creator.access)) return null;
  if (scope.kind === 'dashboard') return dashboardLinkAccess(creator, scope);
  const table = creator.access.tables[scope.tableId];
  if (table === undefined || !isViewVisible(table, scope.viewId)) return null;
  const readFilter = creator.internal.readFilters[scope.tableId] ?? null;

  if (scope.kind === 'view') {
    const hidden = new Set<string>(scope.hiddenFields);
    const fields: TableAccess['fields'] = {};
    for (const fieldId of Object.keys(table.fields) as Id<'fld'>[]) {
      if (!hidden.has(fieldId)) fields[fieldId] = 'read';
    }
    const filter = andFilters([readFilter, scope.filter]);
    return scopedAccess(
      {
        [scope.tableId]: {
          perm: 'read_only',
          operations: [],
          view_rule: { allow_edit: false, visible_views: [scope.viewId] },
          read_scope: filter === null ? 'all' : 'filter',
          fields,
          option_edit_fields: [],
          file_download_fields: [],
        },
      },
      { editFilters: {}, readFilters: { [scope.tableId]: filter } },
    );
  }

  const canAdd =
    (table.perm === 'edit' || table.perm === 'manage') && table.operations.includes('add');
  if (!canAdd) return null;
  const fields: TableAccess['fields'] = {};
  for (const fieldId of scope.formFields) {
    const perm = table.fields[fieldId];
    if (perm === 'edit' || perm === 'create') fields[fieldId] = 'create';
  }
  const editFilter = creator.internal.editFilters[scope.tableId];
  return scopedAccess(
    {
      [scope.tableId]: {
        perm: 'edit',
        operations: ['add'],
        view_rule: { allow_edit: false, visible_views: [scope.viewId] },
        read_scope: readFilter === null ? 'all' : 'filter',
        fields,
        option_edit_fields: [],
        file_download_fields: [],
      },
    },
    {
      editFilters: editFilter === undefined ? {} : { [scope.tableId]: editFilter },
      readFilters: { [scope.tableId]: readFilter },
    },
  );
}
