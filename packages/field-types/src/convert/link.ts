import { linkOptionsSchema, type LinkOptions } from '../types/link.js';

import type { ConversionKind } from './classify.js';

/**
 * Conversions of a `link` field (ADR-28, CONTRACTS §4.1/§4.2; BACKLOG
 * T404). Pure: the preview, `PUT /fields/:id` and the `field.convert` job
 * decide with the same function.
 *
 * - `to_two_way`: `bidirectional` false → true, the reverse field is
 *   created in the linked table, reading the same junction (no data
 *   changes, kind `keep`);
 * - `to_one_way`: `bidirectional` true → false, the other side is deleted
 *   (soft, restorable); the junction stays (kind `keep`);
 * - `to_single`: `allow_multiple` true → false, each cell keeps its first
 *   link (kind `truncate`, needs `confirm`).
 *
 * `record_filter` and `allow_multiple` false → true change nothing stored:
 * kind `none`, applied like a `PATCH`. Changing `link_table`, or more than
 * one of the changes above in one request, is `forbidden`; so is converting
 * between `link` and any other type (CONTRACTS §4.3: never through the
 * whitelist; T404 keeps it refused).
 */

export const LINK_CONVERSION_CHANGES = ['to_two_way', 'to_one_way', 'to_single'] as const;
export type LinkConversionChange = (typeof LINK_CONVERSION_CHANGES)[number];

/** Why a link conversion is `forbidden`. */
export type LinkConversionRefusal = 'link_table' | 'several_changes' | 'other_type';

export interface LinkConversionPlan {
  readonly kind: ConversionKind;
  /** The change a `keep`/`truncate` conversion makes; `null` otherwise. */
  readonly change: LinkConversionChange | null;
  readonly refusal: LinkConversionRefusal | null;
}

/** The link options as stored (defaults applied). */
export function parseLinkOptions(options: unknown): LinkOptions {
  return linkOptionsSchema.parse(options ?? {});
}

/**
 * The kind of a change between two link definitions. `from` and `to` are
 * options parsed by `linkOptionsSchema`; read-only keys
 * (`symmetric_field_id`, `bidirectional_link_field_name` of a two-way
 * link) are ignored.
 */
export function classifyLinkConversion(from: LinkOptions, to: LinkOptions): LinkConversionPlan {
  if (from.link_table !== to.link_table) {
    return { kind: 'forbidden', change: null, refusal: 'link_table' };
  }
  const changes: LinkConversionChange[] = [];
  if (!from.bidirectional && to.bidirectional) changes.push('to_two_way');
  if (from.bidirectional && !to.bidirectional) changes.push('to_one_way');
  if (from.allow_multiple && !to.allow_multiple) changes.push('to_single');
  if (changes.length > 1) return { kind: 'forbidden', change: null, refusal: 'several_changes' };
  const change = changes[0];
  if (change === undefined) return { kind: 'none', change: null, refusal: null };
  return { kind: change === 'to_single' ? 'truncate' : 'keep', change, refusal: null };
}

/** A conversion between `link` and another type: never allowed (CONTRACTS §4.3). */
export const LINK_OTHER_TYPE_PLAN: LinkConversionPlan = {
  kind: 'forbidden',
  change: null,
  refusal: 'other_type',
};

/**
 * The link a `to_single` conversion keeps of a cell: the first of `links`
 * in cell order (links to records in the trash come after live ones);
 * `null` for an empty cell.
 */
export function keptLink<T extends { readonly live: boolean }>(links: readonly T[]): T | null {
  return links.find((link) => link.live) ?? links[0] ?? null;
}
