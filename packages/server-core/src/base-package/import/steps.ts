import { importAiOptions } from './ai.js';
import { checkFormCovers, storeEmailAssets, storeFormCovers } from './assets.js';
import { importAutomations } from './automations.js';
import { importComputedFields, importLinkFilters } from './computed.js';
import { importDashboards } from './dashboards.js';
import { phantomIdsOf } from './phantoms.js';
import { importRoles } from './roles.js';
import { importViews } from './views.js';

import type { BaseImportContext, BaseImportExtension } from './pipeline.js';
import type { Id } from '@cellhive/contracts';

/**
 * What a `.chbase` import creates once the records, junction rows and
 * parents are loaded (T1019, S9 research §2.4 steps 6–7; the `computed`
 * phase of the job), in this order — each object after everything it
 * names:
 *
 * 1. formula and lookup fields in the order of their references, then the
 *    backfill of the stored ones (`computed.ts`), then the link
 *    `record_filter`s naming them;
 * 2. AI options of text/select fields, nothing queued (`ai.ts`);
 * 3. shared views in place of the default views, form covers
 *    (`views.ts`, `assets.ts`);
 * 4. dashboards and their widgets (`dashboards.ts`);
 * 5. custom roles, assigned to nobody (`roles.ts`);
 * 6. automations, all off, with their email images (`automations.ts`).
 *
 * Every write goes through the target into the hidden base, in the
 * transactions of the import: a failure anywhere purges the base like any
 * other failure of the job.
 */
export async function importDeferred(context: BaseImportContext): Promise<void> {
  const { plan, target, baseId } = context;
  const deferred = plan.deferred;
  const total =
    deferred.computedFields.length * 2 +
    deferred.linkFilters.length +
    deferred.aiFields.length +
    plan.tables.length +
    deferred.formCovers.length +
    deferred.dashboards.length +
    deferred.roles.length +
    deferred.automations.length +
    deferred.emailAssets.length;
  let done = 0;
  const tick = async () => {
    done += 1;
    await context.progress(Math.min(done, total), Math.max(total, 1));
  };
  const phantoms = await phantomIdsOf(plan, context.reader);

  await importComputedFields(context, phantoms, tick);
  await importLinkFilters(context, phantoms, tick);
  await importAiOptions(context, phantoms, tick);

  const covers = await checkFormCovers(context);
  const rows = await target.schemaRows(baseId);
  const created = await importViews(context, covers, rows, tick);
  await storeFormCovers(context, covers, created, tick);

  const dashboards = await importDashboards(context, rows, phantoms, tick);

  // Shared views of each table the package names (new ids); default views it cannot name.
  const views = new Map<string, Id<'viw'>[]>();
  const viewTables = new Map<string, Id<'tbl'>>();
  for (const [id, view] of created) {
    const list = views.get(view.tableId) ?? [];
    list.push(id as Id<'viw'>);
    views.set(view.tableId, list);
    viewTables.set(id, view.tableId);
  }
  await importRoles(context, rows, views, dashboards, phantoms, tick);

  const automations = await importAutomations(context, viewTables, tick);
  await storeEmailAssets(context, automations, tick);
}

/** The steps of T1019, for `importBasePackage` (`ImportBasePackageOptions.extensions`). */
export const BASE_IMPORT_STEPS: readonly BaseImportExtension[] = [{ afterData: importDeferred }];
