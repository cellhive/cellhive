import {
  fieldConfigSchema,
  linkOptionsSchema,
  type LinkOptions,
  type FieldConfig,
  type LocaleContext,
  type S1FieldType,
  isS1FieldType,
} from '@cellhive/field-types';

import { buttonColumnOf, type ButtonColumn } from '../lib/buttons/model';

import { computedColumnOf, type ComputedColumn } from './display/computed';

import type { GridPalette } from './theme';
import type { FieldDto, RecordDto } from '@cellhive/contracts';

/** Field types the grid renders and edits: S1 and, from T418, `attachment`. */
export type GridFieldType = S1FieldType | 'attachment';

/** The parsed `{ type, options }` of a field the grid knows. */
export type GridFieldConfig = Extract<FieldConfig, { type: GridFieldType }>;

/** Whether the grid has a renderer (and editor) for a field type. */
export function isGridFieldType(type: unknown): type is GridFieldType {
  return type === 'attachment' || isS1FieldType(type);
}

/**
 * A column of the grid: the field as the API returns it (CONTRACTS §13)
 * plus its options parsed and defaulted by `field-types`. `config` is `null`
 * for types without a renderer yet (link, lookup… arrive in S4) or options
 * the client cannot read; such cells show their value as plain text.
 */
export interface GridField {
  readonly field: FieldDto;
  readonly config: GridFieldConfig | null;
  /**
   * Options of a `link` field (T413): its cells draw linked-record chips and
   * open the link picker; `config` stays `null` (a link has no column value).
   */
  readonly link?: LinkOptions | undefined;
  /**
   * Formula and lookup fields (T468): result type, style, compute state,
   * field-level error and `locked`; their cells are read-only and drawn by
   * `cellRenderers/computed.ts`. `config` stays `null`.
   */
  readonly computed?: ComputedColumn | undefined;
  /**
   * Button fields (T525): label, color, confirmation and (field endpoints)
   * the attached automation. Their cells are `{ state, reason }` computed
   * by the server for the reader; drawn by `cellRenderers/button.ts`,
   * never edited. `config` stays `null`.
   */
  readonly button?: ButtonColumn | undefined;
}

/** Options of a link field, or `undefined` for other types (or options the client cannot read). */
function linkOptionsOf(field: FieldDto): LinkOptions | undefined {
  if (field.type !== 'link') return undefined;
  const result = linkOptionsSchema.safeParse(field.options);
  return result.success ? result.data : undefined;
}

const parsed = new WeakMap<FieldDto, GridField>();

/** Parses a field once per object (fields come from the query cache). */
export function toGridField(field: FieldDto): GridField {
  const cached = parsed.get(field);
  if (cached !== undefined) return cached;
  let config: GridFieldConfig | null = null;
  if (isGridFieldType(field.type)) {
    const result = fieldConfigSchema.safeParse({ type: field.type, options: field.options });
    config = result.success ? result.data : null;
  }
  const link = linkOptionsOf(field);
  const computed = computedColumnOf(field);
  const button = buttonColumnOf(field);
  const gridField: GridField = {
    field,
    config,
    ...(link === undefined ? {} : { link }),
    ...(computed === undefined ? {} : { computed }),
    ...(button === undefined ? {} : { button }),
  };
  parsed.set(field, gridField);
  return gridField;
}

/** Display order of the grid: the primary field first, then by `position`. */
export function orderGridFields(fields: readonly FieldDto[]): GridField[] {
  return [...fields]
    .sort((a, b) => {
      if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
      return a.position - b.position;
    })
    .map(toGridField);
}

/**
 * Fields in the view's column order: the primary field first, then the
 * fields of `order`; a field not listed (new, or never moved) goes right
 * after the field before it in the server order, so "insert left/right"
 * lands where it was asked. `fields` is in server order, primary first
 * (`orderGridFields`).
 */
export function orderFields(fields: readonly GridField[], order: readonly string[]): GridField[] {
  if (order.length === 0) return [...fields];
  const primary = fields.filter((field) => field.field.is_primary);
  const others = fields.filter((field) => !field.field.is_primary);
  const byId = new Map<string, GridField>(others.map((field) => [field.field.id, field]));
  const placed: GridField[] = [];
  const listed = new Set<string>();
  for (const id of order) {
    const field = byId.get(id);
    if (field === undefined || listed.has(id)) continue;
    listed.add(id);
    placed.push(field);
  }
  others.forEach((field, index) => {
    if (listed.has(field.field.id)) return;
    let at = 0;
    for (let before = index - 1; before >= 0; before -= 1) {
      const previous = placed.indexOf(others[before] as GridField);
      if (previous !== -1) {
        at = previous + 1;
        break;
      }
    }
    placed.splice(at, 0, field);
  });
  return [...primary, ...placed];
}

/** Translated texts drawn inside cells (the canvas cannot use i18n directly). */
export interface CellLabels {
  /** A user who left the organization: the API sends `{ id }` only (CONTRACTS §1.3). */
  readonly formerMember: string;
  /** A linked record the user cannot read (`title = null`, P20, T413). */
  readonly noAccess?: string;
  /** "N links" of a link cell whose records are all unreadable (T413). */
  readonly linkCount?: (count: number) => string;
  /** Empty attachment cell the user may fill, while selected (T418). */
  readonly uploadHint?: string;
  /** Computed cells (T468): tooltips of a locked cell and of a field-level error. */
  readonly computed?: ComputedCellLabels;
  /** Button cells (T525): "Running…" while a click of the user runs. */
  readonly buttonRunning?: string;
  /** Button cells (T525): the state announced after the label ("unavailable"). */
  readonly buttonStates?: {
    readonly ready: string;
    readonly disabled: string;
    readonly running: string;
  };
}

/** Translated tooltips of computed cells (T468). */
export interface ComputedCellLabels {
  /** A locked cell: the reader cannot read what the value is computed from. */
  readonly locked: string;
  /** A cell of a field in error ("Field-level error, see the column header"). */
  readonly error: string;
  /** A new field still being computed. */
  readonly pending: string;
}

/** Which attachment fields' files the user may load (`file_download_fields`, CONTRACTS §5A). */
export interface CellFileAccess {
  readonly canView: (fieldId: string) => boolean;
}

/** What a cell renderer knows besides the value: locale, zone, colors and texts. */
export interface CellRenderContext {
  readonly locale: LocaleContext;
  readonly palette: GridPalette;
  readonly labels: CellLabels;
  /** Absent: no image is loaded (type badges only). */
  readonly files?: CellFileAccess | undefined;
}

/** One row of the grid; `undefined` while its block is loading. */
export type GridRecord = RecordDto;
