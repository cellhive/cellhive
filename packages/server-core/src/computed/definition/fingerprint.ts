import { createHash } from 'node:crypto';

import type { FieldRow } from '../../db/schema.js';

/**
 * A digest of what a computed field's values depend on in its own row of
 * meta (options, result type, mode, column). A backfill job carries the
 * fingerprint of the definition it computes and stops once the field has
 * another (a newer job computes the new definition).
 */
export function computedFingerprint(
  field: Pick<FieldRow, 'options' | 'result_type' | 'compute_mode' | 'db_column_name'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([field.options, field.result_type, field.compute_mode, field.db_column_name]),
    )
    .digest('hex')
    .slice(0, 32);
}
