import { isId, type Id } from '@cellhive/contracts';

import type { RecordAccessContext } from '../types.js';
import type { TableAccess } from '@cellhive/permissions';

const SYSTEM_SCAN: unique symbol = Symbol('SystemScanAccess');

/**
 * The read context of a system time scan (ADR-34 §1, BACKLOG T546): S5b
 * date reminders scan a date field for **every** live record, with no
 * principal behind the read — who may see a reminder is checked per
 * recipient when it is sent (`notifications.fanout`, ADR-29 §1).
 *
 * Only `RecordQueryService.systemScanAccess` creates one (the brand below is
 * a module-private symbol), and only `RecordQueryService.scanDue` accepts
 * one: every other read rejects it. It reads
 *
 * - live records (not in the trash) of one table of one organization,
 * - **only** the listed fields (filter, range and returned values; any other
 *   field is unknown to it, exactly like a field a member cannot read),
 * - with no record read rule (no role applies to the system).
 *
 * It never leaves the worker: the API never calls `systemScanAccess`, and a
 * lock test keeps its users to `time-scan/**` and `notifications/reminders/**`.
 */
export interface SystemScanAccess {
  readonly [SYSTEM_SCAN]: SystemScanState;
}

interface SystemScanState {
  readonly organizationId: Id<'org'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldIds: readonly Id<'fld'>[];
  /** The equivalent member context the record reader applies. */
  readonly context: RecordAccessContext;
}

/** Most fields one system scan context may read (a date field and a recipient field today). */
export const MAX_SYSTEM_SCAN_FIELDS = 10;

/** Whether `access` is a system scan context (not a member/share link context). */
export function isSystemScanAccess(access: unknown): access is SystemScanAccess {
  return typeof access === 'object' && access !== null && SYSTEM_SCAN in access;
}

/** The field ids of `fieldIds`, de-duplicated; a malformed list is a programming error. */
export function systemScanFieldIds(fieldIds: readonly string[]): Id<'fld'>[] {
  const ids = [...new Set(fieldIds)];
  if (ids.length === 0 || ids.length > MAX_SYSTEM_SCAN_FIELDS) {
    throw new RangeError(
      `a system scan reads 1 to ${String(MAX_SYSTEM_SCAN_FIELDS)} fields, got ${String(ids.length)}`,
    );
  }
  for (const id of ids) {
    if (!isId('fld', id)) throw new TypeError(`not a field id: ${id}`);
  }
  return ids as Id<'fld'>[];
}

/**
 * Builds the context (`RecordQueryService.systemScanAccess` after it found
 * the live table): `read_only` on that table only, the listed fields
 * readable, no operation, no view, read rule "every record".
 */
export function createSystemScanAccess(input: {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldIds: readonly Id<'fld'>[];
  /** Zone of date operands in a filter (the instance default). */
  readonly timeZone: string;
}): SystemScanAccess {
  const fields: TableAccess['fields'] = {};
  for (const id of input.fieldIds) fields[id] = 'read';
  const table: TableAccess = {
    perm: 'read_only',
    operations: [],
    view_rule: { allow_edit: false, visible_views: [] },
    read_scope: 'all',
    fields,
    option_edit_fields: [],
    file_download_fields: [],
  };
  const context: RecordAccessContext = Object.freeze({
    baseId: input.baseId,
    resolved: {
      access: {
        role: null,
        is_admin: false,
        base_rule: { copy: false, download: false, share_link: false },
        tables: { [input.tableId]: table },
        dashboards: {},
      },
      internal: { editFilters: {}, readFilters: { [input.tableId]: null } },
    },
    // Other tables of the base are never read through it (link titles, lookups).
    relatedAccess: {
      access: {
        role: null,
        is_admin: false,
        base_rule: { copy: false, download: false, share_link: false },
        tables: {},
        dashboards: {},
      },
      internal: { editFilters: {}, readFilters: {} },
    },
    userId: null,
    groupMemberUserIds: [],
    timeZone: input.timeZone,
    locale: 'en',
  });
  return Object.freeze({
    [SYSTEM_SCAN]: Object.freeze({
      organizationId: input.organizationId,
      tableId: input.tableId,
      fieldIds: Object.freeze([...input.fieldIds]),
      context,
    }),
  });
}

/**
 * The member context a system scan context stands for, once checked against
 * the read: same organization and same table, else `null` (the caller
 * answers `NOT_FOUND`).
 */
export function systemScanContextOf(
  access: SystemScanAccess,
  organizationId: Id<'org'>,
  tableId: Id<'tbl'>,
): RecordAccessContext | null {
  const state = access[SYSTEM_SCAN];
  return state.organizationId === organizationId && state.tableId === tableId
    ? state.context
    : null;
}

/** The fields a system scan context reads (tests, diagnostics). */
export function systemScanFieldsOf(access: SystemScanAccess): readonly Id<'fld'>[] {
  return access[SYSTEM_SCAN].fieldIds;
}
