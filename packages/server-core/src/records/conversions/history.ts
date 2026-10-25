import { FIELD_TYPE_REGISTRY } from '@cellhive/field-types';

import {
  definitionTypeOf,
  isComputedDefinitionJson,
  storedDefinitionOf,
} from '../../schema/conversion-ddl.js';

import type { OrgScope } from '../../db/repository.js';
import type { FieldConversionRow } from '../../db/schema.js';
import type { FieldConversionsRepository } from '../../schema/field-conversions.repository.js';
import type { FieldModel } from '../table-model.js';
import type { Id } from '@cellhive/contracts';

/**
 * Record history across type conversions (T403, BACKLOG S4 open question
 * #7): audit entries keep values in the storage form of the definition
 * they were written with, so an entry older than a conversion (its swap,
 * `finished_at`) renders with the definition the field had then
 * (`from_definition` of the first conversion after the entry). Reverted and
 * failed conversions are ignored (the field has that definition again, or
 * never changed).
 */
export class HistoryDefinitions {
  private constructor(private readonly byField: ReadonlyMap<string, FieldConversionRow[]>) {}

  static async load(
    conversions: FieldConversionsRepository,
    scope: OrgScope,
    fieldIds: readonly Id<'fld'>[],
  ): Promise<HistoryDefinitions> {
    const byField = new Map<string, FieldConversionRow[]>();
    for (const row of await conversions.listForFields(scope, fieldIds)) {
      const list = byField.get(row.field_id) ?? [];
      list.push(row);
      byField.set(row.field_id, list);
    }
    return new HistoryDefinitions(byField);
  }

  /** The field as it was defined when an entry of `at` was written. */
  at(field: FieldModel, at: Date): FieldModel {
    const conversion = this.byField
      .get(field.id)
      ?.find((row) => (row.finished_at ?? row.created_at).getTime() > at.getTime());
    // A formula/lookup definition has no history entries of its own (T463).
    if (conversion === undefined || isComputedDefinitionJson(conversion.from_definition)) {
      return field;
    }
    const definition = storedDefinitionOf(conversion.from_definition);
    return {
      ...field,
      type: definition.type,
      definition: FIELD_TYPE_REGISTRY[definition.type],
      options: definition.options,
    };
  }

  /** Whether any definition of the field (now or before a conversion) is `type`. */
  hadType(field: FieldModel, type: string): boolean {
    if (field.type === type) return true;
    return (this.byField.get(field.id) ?? []).some(
      (row) => definitionTypeOf(row.from_definition) === type,
    );
  }
}
