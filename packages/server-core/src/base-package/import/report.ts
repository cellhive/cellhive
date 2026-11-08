import {
  BASE_IMPORT_REPORT_MAX_ITEMS,
  type BaseImportDetachedItem,
  type BaseImportReport,
  type BaseImportSkippedFileReason,
  type Id,
} from '@cellhive/contracts';

import type { PackageDetached } from '../manifest.js';

/**
 * The parts of the import report (`BaseImportReport`, CONTRACTS §12.2) the
 * steps of T1019 fill: what each one created, the secrets, sending
 * identities, groups and incoming webhooks the automations named (to set up
 * again), the AI fields and the covers and email images left out. Every
 * list is capped at `BASE_IMPORT_REPORT_MAX_ITEMS`; names are those the
 * package gives, never anything of the target organization.
 */

/** Detached kinds reported in `secrets_to_reconnect`; the rest in `webhooks_to_recreate`. */
const RECONNECT_KINDS: ReadonlySet<PackageDetached['kind']> = new Set([
  'secret',
  'email_identity',
  'group',
]);

/**
 * Adds the detached slots of one imported automation: one item per kind and
 * name (a secret two automations used is one item listing both), each
 * automation once per item.
 */
export function reportDetached(
  report: BaseImportReport,
  automation: { readonly id: Id<'aut'>; readonly name: string },
  detached: readonly PackageDetached[],
): void {
  for (const slot of detached) {
    const list = RECONNECT_KINDS.has(slot.kind)
      ? report.secrets_to_reconnect
      : report.webhooks_to_recreate;
    let item = list.find((entry) => entry.kind === slot.kind && entry.name === slot.name);
    if (item === undefined) {
      if (list.length >= BASE_IMPORT_REPORT_MAX_ITEMS) continue;
      item = { kind: slot.kind, name: slot.name, automations: [] };
      list.push(item);
    }
    const automations = item.automations as BaseImportDetachedItem['automations'][number][];
    if (
      automations.length < BASE_IMPORT_REPORT_MAX_ITEMS &&
      !automations.some((entry) => entry.id === automation.id)
    ) {
      automations.push({ id: automation.id, name: automation.name });
    }
  }
}

/** Sorts the detached lists by kind, then name (stable for the same input). */
export function sortDetached(report: BaseImportReport): void {
  const byKindAndName = (a: BaseImportDetachedItem, b: BaseImportDetachedItem) =>
    a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
  report.secrets_to_reconnect.sort(byKindAndName);
  report.webhooks_to_recreate.sort(byKindAndName);
}

/** Adds a file a step left out (a cover or an email image). */
export function reportSkippedFile(
  report: BaseImportReport,
  filename: string,
  reason: BaseImportSkippedFileReason,
): void {
  if (report.files_skipped.length < BASE_IMPORT_REPORT_MAX_ITEMS) {
    report.files_skipped.push({ filename, reason });
  }
}

/** Adds an AI field of the new base. */
export function reportAiField(
  report: BaseImportReport,
  field: { readonly tableId: Id<'tbl'>; readonly fieldId: Id<'fld'>; readonly name: string },
): void {
  if (report.ai_fields.length < BASE_IMPORT_REPORT_MAX_ITEMS) {
    report.ai_fields.push({ table_id: field.tableId, field_id: field.fieldId, name: field.name });
  }
}
