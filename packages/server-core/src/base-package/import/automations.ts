import {
  createAutomationRequestSchema,
  type AutomationDefinition,
  type Id,
} from '@cellhive/contracts';

import { SCHEMA_ENTRIES } from '../entries.js';
import { packageProblem } from '../errors.js';
import { PackageLocation } from '../references.js';

import { asDefinition } from './pipeline.js';
import { reportDetached, sortDetached } from './report.js';

import type { BaseImportContext } from './pipeline.js';
import type { ImportAutomationInput } from './target.js';
import type { JsonObject } from '../../db/schema.js';

/**
 * Automations of a `.chbase` import (T1019, ADR-24 amendment §3, CONTRACTS
 * §12.2): every one is created **off**, `run_as` = `created_by` = the
 * importer, its definition parsed as when saved (shape, defaults) with the
 * ids of the new base. The secrets, sending identities, groups and incoming
 * webhooks it named are `null` (`detached`) whatever the package holds —
 * never an id of the target organization — and listed by name in
 * `secrets_to_reconnect` / `webhooks_to_recreate` with the automations
 * using them. Turning one on runs every check of a save with the person's
 * access: a slot still `null` is `422 AUTOMATION_INVALID`. Nothing runs
 * before that: an automation that is off has no trigger, schedule or
 * cursor.
 */

/**
 * The table of a trigger (who manages the automation, what dispatch
 * matches): `table_id`, the table of the form view of `form.submitted`
 * (`viewTables`), `null` for `schedule` and `webhook.received`.
 */
export function triggerTableOf(
  definition: AutomationDefinition,
  viewTables: ReadonlyMap<string, Id<'tbl'>>,
): Id<'tbl'> | null {
  const trigger = definition.trigger;
  switch (trigger.type) {
    case 'schedule':
    case 'webhook.received':
      return null;
    case 'form.submitted':
      return viewTables.get(trigger.view_id) ?? null;
    default:
      return trigger.table_id;
  }
}

/** Creates the automations of the package; returns their ids (new base). */
export async function importAutomations(
  context: BaseImportContext,
  viewTables: ReadonlyMap<string, Id<'tbl'>>,
  tick: () => Promise<void>,
): Promise<Set<string>> {
  const { plan, baseId, target, report } = context;
  const root = PackageLocation.of(SCHEMA_ENTRIES.automations).at('automations');
  const created = new Set<string>();
  for (const [index, { automation, detached }] of plan.deferred.automations.entries()) {
    const at = root.at(index);
    const parsed = createAutomationRequestSchema.safeParse({
      name: automation['name'],
      description: automation['description'],
      definition: automation['definition'],
      enabled: false,
    });
    if (!parsed.success) {
      throw packageProblem('INVALID_DEFINITION', at.toString(), 'An automation is not valid.', {
        code: 'VALIDATION_FAILED',
      });
    }
    const id = automation['id'] as Id<'aut'>;
    const definition = parsed.data.definition;
    const input: ImportAutomationInput = {
      id,
      name: parsed.data.name,
      description: parsed.data.description,
      definition: definition as unknown as JsonObject,
      triggerType: definition.trigger.type,
      triggerTableId: triggerTableOf(definition, viewTables),
    };
    await target.checkpoint();
    await asDefinition(at.toString(), () => target.createAutomation(baseId, input));
    created.add(id);
    report.automations += 1;
    report.automations_disabled += 1;
    reportDetached(report, { id, name: input.name }, detached);
    await tick();
  }
  sortDetached(report);
  return created;
}
