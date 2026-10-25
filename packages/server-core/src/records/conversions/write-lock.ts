import { AppError } from '../../errors/app-error.js';

import type { OrgScope } from '../../db/repository.js';
import type { FieldConversionsRepository } from '../../schema/field-conversions.repository.js';
import type { Id } from '@cellhive/contracts';

/** A cell of a record write: where it is in the request and which field it writes. */
export interface WrittenCell {
  readonly path: string;
  readonly fieldId: Id<'fld'>;
}

/**
 * BACKLOG S4 open question #8: while a field's values are being converted
 * (T403), a record write naming that field answers `409 SCHEMA_LOCKED`
 * (`errors[].code = FIELD_CONVERTING` per cell); writes to other fields go
 * through. Called by `RecordMutationService` after the field checks, inside
 * its transaction (the shared schema lock is held, so a conversion cannot
 * start meanwhile).
 */
export async function assertNotConverting(
  conversions: FieldConversionsRepository,
  scope: OrgScope,
  tableId: Id<'tbl'>,
  cells: Iterable<WrittenCell>,
): Promise<void> {
  const written = [...cells];
  if (written.length === 0) return;
  const running = await conversions.writeLockedFieldIds(scope, tableId);
  if (running.size === 0) return;
  const locked = written.filter((cell) => running.has(cell.fieldId));
  if (locked.length === 0) return;
  throw new AppError('SCHEMA_LOCKED', {
    detail: 'The values of a field are being converted to its new type; try again shortly.',
    errors: locked.map((cell) => ({
      path: cell.path,
      code: 'FIELD_CONVERTING',
      message: 'The field is being converted',
      params: { field_id: cell.fieldId },
    })),
    params: { field_ids: [...new Set(locked.map((cell) => cell.fieldId))] },
  });
}
