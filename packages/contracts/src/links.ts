import { z } from 'zod';

import { idOf } from './ids.js';

/**
 * Link fields (SPEC §5.6, ADR-28; CONTRACTS §2, §13; BACKLOG T401). The
 * options are validated by `@cellhive/field-types` (`linkOptionsSchema`,
 * which also holds `LINK_MAX_PER_CELL`); the schemas here document the
 * shapes of the API.
 */

/** A linked record in a read (`cell_format=json`). `title` is `null` when the caller cannot read it (P20). */
export const linkRefSchema = z
  .strictObject({
    id: idOf('rec'),
    title: z
      .string()
      .nullable()
      .meta({
        description:
          'Primary field of the linked record as text; `null` when the caller cannot read the ' +
          'linked table, its primary field or the record (CONTRACTS §5 P20)',
      }),
  })
  .meta({ id: 'LinkRef' });
export type LinkRef = z.infer<typeof linkRefSchema>;

/** A link cell in a read: linked records in link order, `null` when empty. */
export const linkCellSchema = z.array(linkRefSchema).nullable().meta({ id: 'LinkCell' });
export type LinkCell = z.infer<typeof linkCellSchema>;

/**
 * A link cell in a write: the full new list of linked records (ids, or
 * titles with `typecast=true`); `null`/`[]` empties the cell.
 */
export const linkCellWriteSchema = z
  .array(z.union([idOf('rec'), z.looseObject({ id: idOf('rec') }), z.string()]))
  .nullable()
  .meta({ id: 'LinkCellWrite' });
export type LinkCellWrite = z.infer<typeof linkCellWriteSchema>;

/** `options` of a `link` field (validated by `@cellhive/field-types`). */
export const linkFieldOptionsSchema = z
  .object({
    link_table: idOf('tbl').meta({ description: 'Linked table (active, same base)' }),
    bidirectional: z
      .boolean()
      .optional()
      .meta({
        description:
          'Default `false`. `true` creates the reverse field in the linked table (same junction); ' +
          'set on create only (changing it is a conversion, ADR-28)',
      }),
    bidirectional_link_field_name: z.string().nullish().meta({
      description: 'Name of the reverse field of a two-way link (default: this table name)',
    }),
    allow_multiple: z.boolean().optional().meta({
      description: 'Default `true`; `false` keeps at most one linked record per cell',
    }),
    record_filter: z.record(z.string(), z.unknown()).nullish().meta({
      description:
        'Filter DSL over fields of the linked table the saver can read; new links must match it',
    }),
    symmetric_field_id: idOf('fld').nullish().meta({
      description: 'Read-only: the reverse field of a two-way link (a written value is ignored)',
    }),
  })
  .meta({ id: 'LinkFieldOptions' });
export type LinkFieldOptions = z.infer<typeof linkFieldOptionsSchema>;

// --- Link picker candidates (BACKLOG T402) -----------------------------------------

/** Default and largest page of `POST /fields/:fieldId/link-candidates`. */
export const DEFAULT_LINK_CANDIDATE_LIMIT = 50;
export const MAX_LINK_CANDIDATE_LIMIT = 100;
/** Most `ids` of a candidate request (the most links of a cell). */
export const MAX_LINK_CANDIDATE_IDS = 500;
/** Most display fields of a candidate besides its title. */
export const MAX_LINK_CANDIDATE_FIELDS = 3;
/** Longest `search` of a candidate request, in characters. */
export const MAX_LINK_CANDIDATE_SEARCH_LENGTH = 10_000;

/** Body of `POST /fields/:fieldId/link-candidates` (CONTRACTS §2, T402). */
export const linkCandidatesRequestSchema = z
  .strictObject({
    search: z.string().max(MAX_LINK_CANDIDATE_SEARCH_LENGTH).nullish().meta({
      description:
        'Unaccented, case-insensitive substring of the primary field of the linked table',
    }),
    offset: z.int().min(0).default(0),
    limit: z.int().min(1).max(MAX_LINK_CANDIDATE_LIMIT).default(DEFAULT_LINK_CANDIDATE_LIMIT),
    record_id: idOf('rec')
      .nullish()
      .meta({
        description:
          'The record whose cell is being edited: marks `linked` items and fills `cell` ' +
          '(a record the caller cannot read is `404`)',
      }),
    ids: z
      .array(idOf('rec'))
      .min(1)
      .max(MAX_LINK_CANDIDATE_IDS)
      .nullish()
      .meta({
        description:
          'Only these records, in this order ("selected only", recent picks): `record_filter` ' +
          'is not applied but reported as `selectable`; ids the caller cannot read are absent',
      }),
  })
  .meta({ id: 'LinkCandidatesRequest' });
export type LinkCandidatesRequest = z.infer<typeof linkCandidatesRequestSchema>;

/** One record of the linked table the picker may offer. */
export const linkCandidateSchema = z
  .strictObject({
    id: idOf('rec'),
    title: z.string().nullable().meta({
      description: 'Primary field as text; `null` when the caller cannot read the primary field',
    }),
    fields: z.record(z.string(), z.unknown()).meta({
      description: 'Values (`cell_format=json`) of the display fields, keyed by field id',
    }),
    linked: z.boolean().meta({ description: 'Already in the cell of `record_id`' }),
    full: z.boolean().meta({
      description:
        'Two-way link: the reverse cell of this record already holds its most links, so ' +
        'linking it fails with `TOO_MANY_VALUES`',
    }),
    selectable: z.boolean().meta({
      description: 'Matches the record_filter of the field (always `true` without `ids`)',
    }),
  })
  .meta({ id: 'LinkCandidate' });
export type LinkCandidate = z.infer<typeof linkCandidateSchema>;

/** Response of `POST /fields/:fieldId/link-candidates`. */
export const linkCandidatesResponseSchema = z
  .strictObject({
    items: z.array(linkCandidateSchema),
    fields: z
      .array(z.strictObject({ id: idOf('fld'), name: z.string(), type: z.string() }))
      .max(MAX_LINK_CANDIDATE_FIELDS)
      .meta({
        description:
          'Display fields: the first non-primary fields of the linked table the caller reads',
      }),
    offset: z.int().min(0),
    limit: z.int().min(1),
    has_more: z.boolean(),
    cell: z
      .strictObject({
        count: z.int().min(0).meta({ description: 'Linked records now in the cell' }),
        limit: z.int().min(1).meta({ description: 'Most links of the cell (500, or 1)' }),
      })
      .nullable()
      .meta({ description: 'The cell of `record_id`; `null` without it' }),
  })
  .meta({ id: 'LinkCandidates' });
export type LinkCandidatesResponse = z.infer<typeof linkCandidatesResponseSchema>;
