import { MAX_VIEW_NAME_LENGTH, MAX_VIEWS_PER_TABLE, type Id } from '@cellhive/contracts';

import { isComputedRow } from '../../computed/definition/definition.js';
import {
  configJson,
  copyViewConfig,
  storedViewConfigOf,
  type ViewConfigContext,
  type ViewLinkTarget,
} from '../../views/view-config.js';
import { SCHEMA_ENTRIES } from '../entries.js';
import { packageProblem } from '../errors.js';
import { packageViewSchema, type PackageView } from '../manifest.js';
import { PackageLocation } from '../references.js';

import { asDefinition, checkDefinition } from './pipeline.js';

import type { AcceptedImage } from './assets.js';
import type { BaseImportContext } from './pipeline.js';
import type { ImportViewInput } from './target.js';
import type { BaseSchemaRows } from '../../computed/definition/schema-rows.js';
import type { FieldRow } from '../../db/schema.js';

/**
 * Shared views of a `.chbase` import (T1019, S9 research §2.4 step 3):
 * personal views are never in a package. A table with views in the package
 * gets them in place of the default grid view `importTable` gave it (one
 * without keeps that one); each config is checked like a copied view's
 * (`copyViewConfig` with every field readable: references to what the new
 * base does not have are left out, then the result is validated like a new
 * view's), names unique per table (case-insensitive), at most
 * `MAX_VIEWS_PER_TABLE`, order and `locked` kept. A form whose cover was
 * left out shows none.
 */

/** A shared view created (new ids), with its cover for a form. */
export interface ImportedView {
  readonly tableId: Id<'tbl'>;
  readonly type: 'grid' | 'kanban' | 'form';
  readonly coverId: string | null;
}

function linkTableOf(options: unknown): string | null {
  if (typeof options !== 'object' || options === null) return null;
  const value = (options as { link_table?: unknown }).link_table;
  return typeof value === 'string' ? value : null;
}

/**
 * What a view config of `tableId` is checked against: the active fields of
 * the table in display order, every one readable (the importer owns the
 * base), the linked tables of its links, nothing locked.
 */
export function viewConfigContextOf(rows: BaseSchemaRows, tableId: string): ViewConfigContext {
  const fieldsOf = (id: string): FieldRow[] =>
    rows.fields
      .filter((field) => field.table_id === id && field.deleted_at === null)
      .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  const fields = fieldsOf(tableId);
  const linkTargets = new Map<string, ViewLinkTarget>();
  for (const field of fields) {
    if (field.type !== 'link') continue;
    const linked = linkTableOf(field.options);
    if (linked === null || !rows.tables.some((table) => table.id === linked)) continue;
    const target = fieldsOf(linked);
    linkTargets.set(field.id, {
      fields: target.map((item) => ({ id: item.id })),
      readable: new Set(target.map((item) => item.id)),
    });
  }
  return {
    fields: fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      options: field.options,
      required: field.required,
      ...(isComputedRow(field) ? { result_type: field.result_type } : {}),
    })),
    readable: new Set(fields.map((field) => field.id)),
    linkTargets,
    locked: new Set(),
  };
}

/**
 * The form settings of a package with every required field of the table
 * on it: a field made required after the form was saved is asked too, as
 * a form saved now must ask it (`REQUIRED_FIELD_MISSING` otherwise).
 */
function withRequiredFields(form: unknown, context: ViewConfigContext): unknown {
  if (typeof form !== 'object' || form === null) return form;
  const value = (form as { fields?: unknown }).fields;
  if (!Array.isArray(value)) return form;
  const fields: readonly unknown[] = value;
  const listed = new Set(
    fields.map((item: unknown) =>
      typeof item === 'object' && item !== null ? (item as { field?: unknown }).field : undefined,
    ),
  );
  const missing = context.fields
    .filter((field) => field.required && !listed.has(field.id))
    .map((field) => ({ field: field.id, required: true, label: null, help: null }));
  return missing.length === 0 ? form : { ...form, fields: [...fields, ...missing] };
}

/** The cover a form config names, if any. */
function coverOf(config: Record<string, unknown>): string | null {
  const form = config['form'];
  if (typeof form !== 'object' || form === null) return null;
  const cover = (form as { cover_attachment_id?: unknown }).cover_attachment_id;
  return typeof cover === 'string' ? cover : null;
}

/**
 * Creates the shared views of every table (see the top of this file).
 * Returns the views created, by id.
 */
export async function importViews(
  context: BaseImportContext,
  covers: ReadonlyMap<string, AcceptedImage>,
  rows: BaseSchemaRows,
  tick: () => Promise<void>,
): Promise<Map<string, ImportedView>> {
  const { plan, baseId, target, report } = context;
  const root = PackageLocation.of(SCHEMA_ENTRIES.views).at('views');
  const byTable = new Map<string, { view: PackageView; index: number }[]>();
  for (const [index, value] of plan.deferred.views.entries()) {
    const parsed = packageViewSchema.safeParse(value);
    if (!parsed.success) {
      throw packageProblem('INVALID_DEFINITION', root.at(index).toString(), 'A view is malformed.');
    }
    const list = byTable.get(parsed.data.table_id) ?? [];
    list.push({ view: parsed.data, index });
    byTable.set(parsed.data.table_id, list);
  }
  const created = new Map<string, ImportedView>();
  for (const table of plan.tables) {
    const views = (byTable.get(table.id) ?? []).sort(
      (a, b) => a.view.position - b.view.position || a.index - b.index,
    );
    if (views.length === 0) continue;
    if (views.length > MAX_VIEWS_PER_TABLE) {
      throw packageProblem(
        'INVALID_DEFINITION',
        root.at(views[MAX_VIEWS_PER_TABLE]?.index ?? 0).toString(),
        'A table has more views than this instance allows.',
        { limit: MAX_VIEWS_PER_TABLE },
      );
    }
    const viewContext = viewConfigContextOf(rows, table.id);
    const names = new Set<string>();
    const inputs: ImportViewInput[] = [];
    for (const [rank, { view, index }] of views.entries()) {
      const at = root.at(index);
      const name = view.name.trim();
      if (
        name.length === 0 ||
        name.length > MAX_VIEW_NAME_LENGTH ||
        names.has(name.toLowerCase())
      ) {
        throw packageProblem(
          'INVALID_DEFINITION',
          at.at('name').toString(),
          'A view name is not valid, or another view of the table has it.',
        );
      }
      names.add(name.toLowerCase());
      const config: Record<string, unknown> = structuredClone(view.config);
      const cover = view.type === 'form' ? coverOf(config) : null;
      if (cover !== null && !covers.has(cover)) {
        config['form'] = { ...(config['form'] as object), cover_attachment_id: null };
      }
      if (view.type === 'form') config['form'] = withRequiredFields(config['form'], viewContext);
      const checked = checkDefinition(at.at('config').toString(), () =>
        copyViewConfig(view.type, storedViewConfigOf(view.type, config as never), viewContext),
      );
      inputs.push({
        id: view.id,
        type: view.type,
        name,
        position: rank,
        locked: view.locked,
        config: configJson(checked),
      });
      created.set(view.id, {
        tableId: table.id,
        type: view.type,
        coverId: view.type === 'form' ? (checked.form?.cover_attachment_id ?? null) : null,
      });
    }
    await target.checkpoint();
    await asDefinition(root.toString(), () => target.createViews(baseId, table.id, inputs));
    report.views += inputs.length;
    await tick();
  }
  return created;
}
