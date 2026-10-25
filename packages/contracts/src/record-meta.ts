import { z } from 'zod';

import { idOf } from './ids.js';

// Kept apart from `records.ts` so that `realtime.ts` (part of light entries)
// does not pull the record and view schemas in.

/**
 * Colors of a record under the color rules of the view read through (T816,
 * CONTRACTS §1.4): the id of the rule that won the row, and per field id the
 * rule that won the cell. Evaluated by the server for the reader: rules
 * naming a field the reader cannot read never apply to them.
 */
export const recordColorSchema = z
  .strictObject({
    row: idOf('clr').optional().meta({ description: 'The first matching row rule' }),
    cells: z
      .record(idOf('fld'), idOf('clr'))
      .optional()
      .meta({ description: 'Field id → the first matching cell rule of that field' }),
  })
  .meta({ id: 'RecordColor' });
export type RecordColorDto = z.infer<typeof recordColorSchema>;

/** Read-only details of a record that are not cell values (T816). */
export const recordMetaSchema = z
  .strictObject({
    color: recordColorSchema.optional(),
  })
  .meta({
    id: 'RecordMeta',
    description:
      'Present when the record is read through a view (`view_id`) with color rules that apply ' +
      'to the reader (T816); `color: {}` = no rule matches',
  });
export type RecordMetaDto = z.infer<typeof recordMetaSchema>;
