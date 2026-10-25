import {
  BasesRepository,
  fieldErrorOf,
  formulaTypeOf,
  isComputedFieldLocked,
  isComputedRow,
  loadBaseSchemaRows,
  publicResultType,
  readabilityOfAccess,
  strictComputedPermissionsOf,
  type Db,
  type FieldRow,
  type OrgScope,
  type RecordAccessContext,
} from '@cellhive/server-core';

import type { ComputedResultTypeDto, ComputeErrorDto, Id } from '@cellhive/contracts';

/**
 * What a share link tells about a formula/lookup field (CONTRACTS §16A,
 * BACKLOG T462): the type of its value, whether the link sees it as
 * `locked` (the rules of T457 with the link as reader: the creator's
 * current access ∩ the link's scope, other tables through `relatedAccess`)
 * and the **code** of a field-level error — never the expression, the
 * source table/field or the `refs` of the error.
 */
export interface SharedComputedPart {
  readonly result_type: ComputedResultTypeDto;
  readonly compute_error: { readonly code: ComputeErrorDto['code'] } | null;
  readonly locked: boolean;
}

/** The {@link SharedComputedPart} of each formula/lookup field of `fields`, by id. */
export async function sharedComputedParts(
  db: Db,
  scope: OrgScope,
  baseId: Id<'bse'>,
  fields: readonly FieldRow[],
  access: RecordAccessContext,
): Promise<Map<string, SharedComputedPart>> {
  const out = new Map<string, SharedComputedPart>();
  const computed = fields.filter(isComputedRow);
  if (computed.length === 0) return out;
  const rows = await loadBaseSchemaRows(db, scope, baseId);
  const base = await new BasesRepository(db).getById(scope, baseId);
  const strict = strictComputedPermissionsOf(base?.settings);
  const readable = readabilityOfAccess(access);
  for (const field of computed) {
    const error = fieldErrorOf(field.compute_error);
    out.set(field.id, {
      result_type: resultTypeOf(field),
      compute_error: error === null ? null : { code: error.code },
      locked: isComputedFieldLocked(field, rows, readable, strict),
    });
  }
  return out;
}

/** The public result type of a formula/lookup row (`{ kind: 'null' }` when unknown). */
function resultTypeOf(field: FieldRow): ComputedResultTypeDto {
  return publicResultTypeOf(field.result_type);
}

/** The public result type of a stored `result_type` (`{ kind: 'null' }` when unknown). */
export function publicResultTypeOf(resultType: unknown): ComputedResultTypeDto {
  const type = formulaTypeOf(resultType);
  return type === null || type.kind === 'any'
    ? { kind: 'null', list: false }
    : publicResultType(type);
}

/**
 * The result kind of a formula/lookup field whose values a link rewrites
 * (T462): `record` (`{ id, title }`: those the creator cannot read become
 * `{ id: null, title: null }` like link cells) or `attachment` (always
 * empty through a link); `null` for anything else.
 */
export function sharedResultKind(field: FieldRow): 'record' | 'attachment' | null {
  if (!isComputedRow(field)) return null;
  const kind = resultTypeOf(field).kind;
  return kind === 'record' || kind === 'attachment' ? kind : null;
}
