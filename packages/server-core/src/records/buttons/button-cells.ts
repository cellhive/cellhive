import { buttonOptionsSchema, type ButtonOptions } from '@cellhive/field-types';

import { AutomationsRepository } from '../../automation/repository/automations.repository.js';
import {
  buttonAutomationOf,
  buttonGateOf,
  type ButtonAutomation,
} from '../../automation/triggers/button/button-trigger.js';
import { AppError } from '../../errors/app-error.js';
import { resolveMemberBaseAccess, type AccessDefaults } from '../../import/member-access.js';

import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { FieldRow } from '../../db/schema.js';
import type { RecordAccessContext } from '../types.js';
import type { ButtonCell, Id } from '@cellhive/contracts';

/**
 * Button fields in the record pipelines (BACKLOG T517, ADR-32 §2, CONTRACTS
 * §2). A `button` has no column: `RecordQueryService` selects it like a
 * field (field permission ≠ `no_perm`, hidden view fields of a share link
 * left out) and asks {@link ButtonCellResolver} for the cells of a page.
 */
export interface ButtonFieldModel {
  readonly id: Id<'fld'>;
  readonly name: string;
  readonly options: ButtonOptions;
  readonly row: FieldRow;
}

/** The model of an active `button` field row, else `null`. */
export function toButtonFieldModel(row: FieldRow): ButtonFieldModel | null {
  if (row.type !== 'button' || row.deleted_at !== null) return null;
  // Meta is written through the same schema: a parse error falls back to the defaults.
  const parsed = buttonOptionsSchema.safeParse(row.options ?? {});
  return {
    id: row.id,
    name: row.name,
    options: parsed.success ? parsed.data : buttonOptionsSchema.parse({}),
    row,
  };
}

/**
 * The reads the resolver needs from `RecordQueryService` (which passes
 * itself): ids among `ids` that are live, in the reader's read rule (and
 * edit rule with `editable`) and match `filter` (field ids; `null` = any).
 */
export interface ButtonRecordMatcher {
  matchingIds(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    ids: readonly Id<'rec'>[],
    filter: unknown,
    options?: { readonly editable?: boolean },
  ): Promise<ReadonlySet<string>>;
}

/** What a page of button cells is computed for. */
export interface ButtonCellRequest {
  /** Carries the reader's read transaction (cells see the page's snapshot). */
  readonly scope: OrgScope;
  readonly tableId: Id<'tbl'>;
  /** The reader. */
  readonly access: RecordAccessContext;
  /**
   * Read through a share link (or by nobody in particular): buttons never
   * run there, every cell is `disabled` / `permission` and nothing else is
   * looked at.
   */
  readonly anonymous: boolean;
}

const READY: ButtonCell = { state: 'ready', reason: null };
const disabled = (reason: Exclude<ButtonCell['reason'], null>): ButtonCell => ({
  state: 'disabled',
  reason,
});

/**
 * Per-reader cells of button fields (`{ state, reason }`, CONTRACTS §2),
 * first reason that applies:
 *
 * 1. `no_automation`: no automation (not deleted) is attached to the
 *    button; `automation_disabled`: it is off (or its stored definition no
 *    longer parses);
 * 2. `permission`: the reader is below the trigger's `min_permission` on
 *    the record — `edit`: table permission `edit`/`manage` and the record in
 *    their edit rule; `read`: the reader reads it, which every record of the
 *    page already is. Share links: always `permission`;
 * 3. `condition`: `enabled_when` AND the automation's `condition` (`changed*`
 *    false) does not hold for the record read as `run_as` — read rule,
 *    readable fields; `run_as` without access to the base or the table,
 *    or the filter no longer valid for them, disables every record. The
 *    reader learns one bit, never the values (ADR-32 §2).
 *
 * Batched per page: one automation lookup, one edit-rule read and one
 * `run_as` read per button that needs them.
 */
export class ButtonCellResolver {
  private readonly automations: AutomationsRepository;

  constructor(
    private readonly db: Db,
    private readonly records: ButtonRecordMatcher,
    private readonly defaults: AccessDefaults,
  ) {
    this.automations = new AutomationsRepository(db);
  }

  /** Cells by field id, then record id. */
  async cells(
    request: ButtonCellRequest,
    buttons: readonly ButtonFieldModel[],
    recordIds: readonly Id<'rec'>[],
  ): Promise<Map<Id<'fld'>, Map<Id<'rec'>, ButtonCell>>> {
    const out = new Map<Id<'fld'>, Map<Id<'rec'>, ButtonCell>>();
    if (buttons.length === 0 || recordIds.length === 0) return out;
    const fill = (fieldId: Id<'fld'>, cell: (id: Id<'rec'>) => ButtonCell) => {
      out.set(fieldId, new Map(recordIds.map((id) => [id, cell(id)])));
    };
    if (request.anonymous) {
      for (const button of buttons) fill(button.id, () => disabled('permission'));
      return out;
    }
    const rows = await this.automations.listForButtons(
      request.scope,
      buttons.map((button) => button.id),
    );
    let editable: ReadonlySet<string> | undefined;
    const editableIds = async (): Promise<ReadonlySet<string>> => {
      editable ??= await this.editableIds(request, recordIds);
      return editable;
    };
    for (const button of buttons) {
      const row = rows.find((item) => fieldIdOf(item.definition) === button.id);
      if (row === undefined) {
        fill(button.id, () => disabled('no_automation'));
        continue;
      }
      const automation = buttonAutomationOf(row, request.tableId, button.id);
      if (automation === null || !row.enabled) {
        fill(button.id, () => disabled('automation_disabled'));
        continue;
      }
      const permitted =
        automation.trigger.min_permission === 'read'
          ? new Set<string>(recordIds)
          : await editableIds();
      const candidates = recordIds.filter((id) => permitted.has(id));
      const matched =
        candidates.length === 0
          ? new Set<string>()
          : await this.matchingAsRunAs(request, automation, candidates);
      fill(button.id, (id) =>
        !permitted.has(id)
          ? disabled('permission')
          : matched.has(id)
            ? READY
            : disabled('condition'),
      );
    }
    return out;
  }

  /** Records of the page the reader may edit (table permission and edit rule). */
  private async editableIds(
    request: ButtonCellRequest,
    recordIds: readonly Id<'rec'>[],
  ): Promise<ReadonlySet<string>> {
    const perm = request.access.resolved.access.tables[request.tableId]?.perm;
    if (perm !== 'edit' && perm !== 'manage') return new Set();
    return this.records.matchingIds(
      request.scope,
      request.tableId,
      request.access,
      recordIds,
      null,
      {
        editable: true,
      },
    );
  }

  /** Records among `ids` that pass the button's gate, read as `run_as`. */
  private async matchingAsRunAs(
    request: ButtonCellRequest,
    automation: ButtonAutomation,
    ids: readonly Id<'rec'>[],
  ): Promise<ReadonlySet<string>> {
    const gate = buttonGateOf(automation);
    if (gate === false) return new Set();
    const runAs = await resolveMemberBaseAccess(
      this.db,
      request.scope,
      { userId: automation.row.run_as_user_id, baseId: automation.row.base_id },
      this.defaults,
    );
    if (runAs === undefined) return new Set();
    try {
      return await this.records.matchingIds(
        request.scope,
        request.tableId,
        runAs.record,
        ids,
        gate === true ? null : gate,
      );
    } catch (error) {
      // Table or field `run_as` cannot read (any more): the button cannot run.
      if (error instanceof AppError) return new Set();
      throw error;
    }
  }
}

function fieldIdOf(definition: unknown): unknown {
  if (typeof definition !== 'object' || definition === null) return undefined;
  const trigger = (definition as { trigger?: unknown }).trigger;
  if (typeof trigger !== 'object' || trigger === null) return undefined;
  return (trigger as { field_id?: unknown }).field_id;
}
