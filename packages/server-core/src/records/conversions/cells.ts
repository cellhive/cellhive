import {
  convertCell,
  FIELD_TYPE_REGISTRY,
  FieldValueError,
  sourceKindOf,
  type CellConversion,
  type FieldConversionPlan,
  type FieldDefinitionRef,
  type UserRef,
} from '@cellhive/field-types';

import { storageToJson } from '../storage-values.js';

import type { OrgScope } from '../../db/repository.js';
import type { JsonValue } from '../../db/schema.js';
import type { MemberDirectoryRepository } from '../member-directory.repository.js';

/**
 * Cell conversion of whole batches (T403): the preview, the backfill job
 * and the revert preview read driver values of the source column, turn them
 * into the source's json read value (with member names for user sources),
 * convert them with `convertCell` of `@cellhive/field-types` (the same pure
 * function everywhere) and, for the job, into storage values of the target.
 */

/** Locale and zone of a conversion (base locale, organization zone). */
export interface ConversionLocale {
  readonly locale: string;
  readonly timeZone: string;
}

export interface ConvertedRow {
  /** The source value, `cell_format=json`. */
  readonly source: unknown;
  readonly result: CellConversion;
}

/** Column a field's values are read from: its own, or the system column it points at. */
export function sourceColumnOf(type: string, column: string | null): string | null {
  const definition = (FIELD_TYPE_REGISTRY as Record<string, { systemColumn: string | null }>)[type];
  return definition?.systemColumn ?? column;
}

function userIdsOf(type: string, raws: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const raw of raws) {
    if (type === 'user' && Array.isArray(raw)) {
      for (const id of raw) if (typeof id === 'string') ids.push(id);
    } else if ((type === 'created_by' || type === 'updated_by') && typeof raw === 'string') {
      ids.push(raw);
    }
  }
  return ids;
}

/** Text values a user ← text (`match_email`) conversion looks up. */
function emailsOf(raws: readonly unknown[]): string[] {
  return raws.flatMap((raw) =>
    typeof raw === 'string'
      ? raw
          .split(/[,;]/)
          .map((email) => email.trim().toLowerCase())
          .filter((email) => email !== '')
      : [],
  );
}

/**
 * Converts one batch of driver values of the source column. Member names
 * (user sources) and member emails (user ← text) are looked up once per
 * batch, in the organization of `scope`.
 */
export async function convertBatch(
  members: MemberDirectoryRepository,
  scope: OrgScope,
  plan: FieldConversionPlan,
  locale: ConversionLocale,
  raws: readonly unknown[],
): Promise<ConvertedRow[]> {
  const from = FIELD_TYPE_REGISTRY[plan.from.type];
  const userIds = userIdsOf(plan.from.type, raws);
  const names = new Map<string, UserRef>(
    (await members.findMembers(scope, userIds)).map((member) => [
      member.id,
      { id: member.id, name: member.name, email: member.email },
    ]),
  );
  const byEmail = new Map<string, string>();
  if (plan.to.type === 'user' && sourceKindOf(plan.from.type) === 'text') {
    for (const member of await members.findMembersByEmail(scope, emailsOf(raws))) {
      byEmail.set(member.email.toLowerCase(), member.id);
    }
  }
  const ctx = {
    locale: locale.locale,
    timeZone: locale.timeZone,
    resolveUserEmail: (email: string) => byEmail.get(email.toLowerCase()),
  };
  const readCtx = { resolveUser: (id: string) => names.get(id) };
  return raws.map((raw) => {
    const source = from.fromStorage(raw, plan.from.options as never, readCtx);
    return { source, result: convertCell(plan, source, ctx) };
  });
}

/**
 * Json read values (`cell_format=json`) of driver values of a column of
 * `definition`, member names looked up once (T463: the `from` of the
 * samples of a conversion to a formula/lookup).
 */
export async function sourceJsonBatch(
  members: MemberDirectoryRepository,
  scope: OrgScope,
  definition: FieldDefinitionRef,
  raws: readonly unknown[],
): Promise<unknown[]> {
  const from = FIELD_TYPE_REGISTRY[definition.type];
  const names = new Map<string, UserRef>(
    (await members.findMembers(scope, userIdsOf(definition.type, raws))).map((member) => [
      member.id,
      { id: member.id, name: member.name, email: member.email },
    ]),
  );
  const readCtx = { resolveUser: (id: string) => names.get(id) };
  return raws.map((raw) => from.fromStorage(raw, definition.options as never, readCtx));
}

/**
 * Storage value (as JSON) of a converted cell for the target column, or
 * `undefined` when the target refuses it (a select name without an option,
 * an unknown user): the cell is then lost.
 */
export function targetStorageOf(plan: FieldConversionPlan, value: unknown): JsonValue | undefined {
  try {
    return storageToJson(
      FIELD_TYPE_REGISTRY[plan.to.type].toStorage(value, plan.to.options as never, {}),
    );
  } catch (error) {
    if (error instanceof FieldValueError) return undefined;
    throw error;
  }
}

/** The json read value of a storage value of the target (preview samples). */
export function targetReadOf(plan: FieldConversionPlan, stored: JsonValue): unknown {
  return FIELD_TYPE_REGISTRY[plan.to.type].fromStorage(stored, plan.to.options as never, {});
}
