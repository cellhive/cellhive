import { isId } from '@cellhive/contracts';
import {
  AiGenerationQueueRepository,
  AutomationsRepository,
  buttonAutomationOf,
  definitionTypeOf,
  FieldConversionsRepository,
  FieldsRepository,
  isAiField,
  isComputedRow,
  loadBaseSchemaRows,
  strictComputedPermissionsOf,
  TablesRepository,
  type BaseSchemaRows,
  type Db,
  type FieldConversionRow,
  type FieldRow,
  type OrgScope,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { fieldDtoOf } from '../../common/schema/schema-dto.js';
import { DB } from '../../common/tokens.js';

import {
  aiConfigVisibleTo,
  aiDtoPart,
  computedDtoPart,
  loadErrorRefs,
  type ErrorRefRows,
} from './computed-fields.js';

import type { BaseAccess } from '../../common/access/access.service.js';
import type {
  AiFieldStateDto,
  ButtonFieldSummary,
  FieldConversionState,
  FieldDto,
  FieldTypeName,
  Id,
} from '@cellhive/contracts';

/** The meta of the base a reader's DTOs need, with the inactive objects their errors name. */
interface LoadedRows {
  readonly rows: BaseSchemaRows;
  readonly inactive: ErrorRefRows;
}

/**
 * The field DTO of the field API for one reader (CONTRACTS §13) — the one
 * serializer of every response that returns a field: list (with the
 * trash), get, create, `PATCH`, the `202` of `PUT`, revert and restore.
 * What depends on the reader: a formula/lookup definition (`{ style }`
 * unless they may see it), the AI configuration (`options.ai` whole, with
 * `ai_state`, only to table managers who read every field flowing into the
 * prompt; `{ task }` otherwise — T1006), `locked`, `compute_error.refs`.
 */
@Injectable()
export class FieldDtoService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(TablesRepository) private readonly tables: TablesRepository,
    @Inject(FieldConversionsRepository) private readonly conversions: FieldConversionsRepository,
  ) {}

  /** Conversion state of the fields of a table (CONTRACTS §13 `conversion`). */
  async conversionStates(
    scope: OrgScope,
    tableId: Id<'tbl'>,
  ): Promise<Map<string, FieldConversionState>> {
    const states = new Map<string, FieldConversionState>();
    const now = Date.now();
    for (const row of await this.conversions.listLiveByTable(scope, tableId)) {
      if (row.status === 'succeeded' && row.expires_at.getTime() <= now) continue;
      states.set(row.field_id, conversionStateOf(row));
    }
    return states;
  }

  /**
   * The DTO of each of `rows` (fields of one base, the trash included) for
   * the reader of `base`, with what they share loaded once.
   */
  async serializer(
    base: BaseAccess,
    rows: readonly FieldRow[],
  ): Promise<(field: FieldRow) => FieldDto> {
    const scope = base.org.scope;
    const states = new Map<string, FieldConversionState>();
    for (const tableId of new Set(rows.map((row) => row.table_id))) {
      for (const [id, state] of await this.conversionStates(scope, tableId)) states.set(id, state);
    }
    const deletedTargets = await this.deletedLinkTargets(scope, rows);
    const loaded = await this.rowsFor(base, rows);
    const buttons = await this.buttonsOf(scope, rows);
    const aiStates = await this.aiStatesOf(base, loaded, rows);
    const strict = strictComputedPermissionsOf(base.base.settings);
    return (field) =>
      fieldDtoOf(
        field,
        deletedTargets,
        states.get(field.id) ?? null,
        loaded === undefined
          ? undefined
          : isAiField(field)
            ? aiDtoPart(field, loaded.rows, base.access, aiStates.get(field.id))
            : computedDtoPart(field, loaded.rows, base.access, strict, loaded.inactive),
        buttons.get(field.id),
      );
  }

  /** The DTO of one field for the reader of `base`. */
  async one(base: BaseAccess, field: FieldRow): Promise<FieldDto> {
    return (await this.serializer(base, [field]))(field);
  }

  /**
   * Meta of the base, loaded only when some field is computed or an AI
   * field, with the inactive fields/tables their errors name (T460).
   */
  private async rowsFor(
    base: BaseAccess,
    fields: readonly FieldRow[],
  ): Promise<LoadedRows | undefined> {
    if (!fields.some((field) => isComputedRow(field) || isAiField(field))) return undefined;
    const rows = await loadBaseSchemaRows(this.db, base.org.scope, base.base.id);
    const inactive = await loadErrorRefs(base.org.scope, rows, fields, {
      fields: this.fields,
      tables: this.tables,
    });
    return { rows, inactive };
  }

  /**
   * Queue counts of the live AI fields among `fields` whose whole
   * configuration the reader gets (no count is read for anyone else).
   */
  private async aiStatesOf(
    base: BaseAccess,
    loaded: LoadedRows | undefined,
    fields: readonly FieldRow[],
  ): Promise<Map<Id<'fld'>, AiFieldStateDto>> {
    if (loaded === undefined) return new Map();
    const ids = fields
      .filter(
        (field) => field.deleted_at === null && aiConfigVisibleTo(field, loaded.rows, base.access),
      )
      .map((field) => field.id);
    return new AiGenerationQueueRepository(this.db).statesOf(base.org.scope, ids);
  }

  /**
   * The automation attached to each button field (T517): id, on/off and
   * `min_permission` of its `button.clicked` trigger.
   */
  private async buttonsOf(
    scope: OrgScope,
    fields: readonly FieldRow[],
  ): Promise<Map<string, ButtonFieldSummary>> {
    const buttons = fields.filter((field) => field.type === 'button');
    const out = new Map<string, ButtonFieldSummary>();
    if (buttons.length === 0) return out;
    const rows = await new AutomationsRepository(this.db).listForButtons(
      scope,
      buttons.map((field) => field.id),
    );
    for (const field of buttons) {
      let summary: ButtonFieldSummary = {
        automation_id: null,
        automation_enabled: false,
        min_permission: null,
      };
      for (const row of rows) {
        const automation = buttonAutomationOf(row, field.table_id, field.id);
        if (automation === null) continue;
        summary = {
          automation_id: row.id,
          automation_enabled: row.enabled,
          min_permission: automation.trigger.min_permission,
        };
      }
      out.set(field.id, summary);
    }
    return out;
  }

  /** Linked tables of `rows`' link fields that are in the trash or gone (CONTRACTS §13). */
  private async deletedLinkTargets(
    scope: OrgScope,
    rows: readonly FieldRow[],
  ): Promise<Set<string>> {
    const targets = new Set(
      rows.flatMap((row) => {
        const target = row.type === 'link' ? linkTableOf(row.options) : null;
        return target === null ? [] : [target];
      }),
    );
    const deleted = new Set<string>();
    for (const target of targets) {
      if ((await this.tables.getById(scope, target)) === undefined) deleted.add(target);
    }
    return deleted;
  }
}

/** `options.link_table` when it is a table id, else `null`. */
export function linkTableOf(options: unknown): Id<'tbl'> | null {
  if (typeof options !== 'object' || options === null || !('link_table' in options)) return null;
  return isId('tbl', options.link_table) ? options.link_table : null;
}

/** `conversion` of a field DTO from its live conversion row (T403, T404). */
function conversionStateOf(row: FieldConversionRow): FieldConversionState {
  return {
    job_id: row.job_id,
    status: row.status === 'running' ? 'running' : 'succeeded',
    from_type: definitionTypeOf(row.from_definition) as FieldTypeName,
    to_type: definitionTypeOf(row.to_definition) as FieldTypeName,
    revertible_until: row.expires_at.toISOString(),
    // T404: a link conversion keeps the type.
    ...(row.kind === 'column' ? {} : { link_change: row.kind }),
  };
}
