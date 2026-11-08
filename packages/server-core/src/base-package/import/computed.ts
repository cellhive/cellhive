import { definitionReferenceIds, type FieldErrorRef } from '../../computed/errors/field-errors.js';
import { PackageProblems } from '../errors.js';

import { mentionedIds, mentionsAny } from './phantoms.js';
import { asDefinition } from './pipeline.js';

import type { BaseImportContext } from './pipeline.js';
import type { DeferredImport, PlannedField, PlannedTable } from './plan.js';
import type { Id } from '@cellhive/contracts';

/**
 * Formula and lookup fields of a `.chbase` import (T1019, S9 research
 * §2.4 step 6, §2.6): created once the records are loaded, in the order of
 * their references — a field after every formula/lookup it reads — so each
 * definition (stored form, ids of the new base) is checked like a new
 * field's against what exists; then each `stored` one is computed on every
 * record (the backfill) in that same order, a field read by another first.
 * Afterwards, the link `record_filter`s that name such fields are set.
 *
 * A definition naming an id of `missing_ids` (a field the source had in its
 * trash…), or reading a field imported that way, is created broken as at
 * the source (`REF`, no column) instead of refusing the package. A cycle
 * among the fields of the package is `INVALID_DEFINITION`.
 */

/** One formula/lookup field to create, with the formula/lookup fields of the package it reads. */
export interface ComputedImportStep {
  readonly table: PlannedTable;
  readonly field: PlannedField;
  /** Ids (new base) of the deferred fields it reads. */
  readonly reads: readonly string[];
}

/** Field and table ids (new base) a planned formula/lookup names. */
function referencesOf(field: PlannedField): {
  readonly fields: ReadonlySet<string>;
  readonly tables: ReadonlySet<string>;
} {
  return definitionReferenceIds({
    type: field.source.type,
    options: field.options as never,
  });
}

/**
 * The creation order of the formula/lookup fields: every field after the
 * deferred fields it reads, otherwise in package order. Fields in a cycle
 * are `INVALID_DEFINITION` (thrown together).
 */
export function computedImportOrder(
  fields: DeferredImport['computedFields'],
): ComputedImportStep[] {
  const deferred = new Set(fields.map(({ field }) => field.id as string));
  const pending: ComputedImportStep[] = fields.map(({ table, field }) => ({
    table,
    field,
    reads: [...referencesOf(field).fields].filter((id) => deferred.has(id) && id !== field.id),
  }));
  const selfReading = fields.filter(({ field }) => referencesOf(field).fields.has(field.id));
  const order: ComputedImportStep[] = [];
  const done = new Set<string>();
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let index = 0; index < pending.length; index += 1) {
      const step = pending[index] as ComputedImportStep;
      if (!step.reads.every((id) => done.has(id))) continue;
      order.push(step);
      done.add(step.field.id);
      pending.splice(index, 1);
      progress = true;
      break;
    }
  }
  const cycle = [...pending.map((step) => step.field), ...selfReading.map(({ field }) => field)];
  if (cycle.length > 0) {
    const problems = new PackageProblems();
    for (const field of new Set(cycle)) {
      problems.add(
        'INVALID_DEFINITION',
        field.location.at('options').toString(),
        'Formula and lookup fields of the package read each other in a cycle.',
        { code: 'FORMULA_CYCLE' },
      );
    }
    problems.throwIfAny();
  }
  return order;
}

/**
 * Why a field is imported broken: the phantoms (`missing_ids`) its
 * definition names and the broken fields it reads; `null` when none.
 */
export function brokenRefsOf(
  field: PlannedField,
  phantoms: ReadonlySet<string>,
  broken: ReadonlySet<string>,
): FieldErrorRef[] | null {
  const references = referencesOf(field);
  const refs: FieldErrorRef[] = [];
  for (const id of [...references.tables].sort()) {
    if (phantoms.has(id)) refs.push({ kind: 'table', id });
  }
  for (const id of [...references.fields].sort()) {
    if (phantoms.has(id) || broken.has(id)) refs.push({ kind: 'field', id });
  }
  // A phantom the references above do not list (a nested place of a lookup).
  if (refs.length === 0 && mentionsAny(field.options, phantoms)) {
    for (const id of mentionedIds(field.options, phantoms)) {
      refs.push({ kind: id.startsWith('tbl_') ? 'table' : 'field', id });
    }
  }
  return refs.length === 0 ? null : refs;
}

/** The zone of the compile checks: the base's own, else UTC. */
function zoneOf(settings: Record<string, unknown>): string {
  const zone = settings['timezone'];
  return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
}

/**
 * Creates the formula and lookup fields, then backfills the stored ones
 * (see the top of this file). `tick` reports one unit of progress.
 */
export async function importComputedFields(
  context: BaseImportContext,
  phantoms: ReadonlySet<string>,
  tick: () => Promise<void>,
): Promise<void> {
  const { plan, baseId, target, report } = context;
  const order = computedImportOrder(plan.deferred.computedFields);
  const broken = new Set<string>();
  const stored: Id<'fld'>[] = [];
  const timeZone = zoneOf(plan.base.settings);
  for (const { table, field } of order) {
    await target.checkpoint();
    const refs = brokenRefsOf(field, phantoms, broken);
    if (refs !== null) broken.add(field.id);
    const isStored = await asDefinition(field.location.toString(), () =>
      target.createComputedField(baseId, {
        tableId: table.id,
        field: {
          id: field.id,
          name: field.name,
          type: field.source.type,
          options: field.options,
          description: field.source.description,
          required: field.source.required,
          uniqueValues: field.source.unique_values,
          position: field.position,
        },
        timeZone,
        broken: refs === null ? null : { refs, resultType: field.source.result_type },
      }),
    );
    if (isStored) stored.push(field.id);
    report.fields += 1;
    await tick();
  }
  for (const fieldId of stored) {
    await target.checkpoint();
    await target.backfillComputed(baseId, fieldId);
    await tick();
  }
}

/**
 * The link `record_filter`s pass 1 left out because they name a field
 * created above (a formula, a lookup): each set and checked against its
 * linked table now; one naming an id of `missing_ids` is kept as at the
 * source (its structure checked by pass 1), never dropped.
 */
export async function importLinkFilters(
  context: BaseImportContext,
  phantoms: ReadonlySet<string>,
  tick: () => Promise<void>,
): Promise<void> {
  const { plan, baseId, target } = context;
  const owners = new Map<string, { table: PlannedTable; field: PlannedField }>();
  for (const table of plan.tables) {
    for (const field of table.fields) owners.set(field.id, { table, field });
  }
  for (const item of plan.deferred.linkFilters) {
    const owner = owners.get(item.fieldId);
    if (owner === undefined) continue;
    await target.checkpoint();
    await asDefinition(owner.field.location.at('options', 'record_filter').toString(), () =>
      target.setLinkFilter(baseId, {
        tableId: owner.table.id,
        fieldId: item.fieldId,
        filter: item.filter,
        broken: mentionsAny(item.filter, phantoms),
      }),
    );
    await tick();
  }
}
