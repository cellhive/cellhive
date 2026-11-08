/**
 * Importing a whole base from a `.chbase` package (ADR-24 amendment §4,
 * CONTRACTS §12.2): pass 1 (`plan.ts`), the writes in order
 * (`pipeline.ts`) into a {@link BaseImportTarget} — the hidden base of a
 * `base.import` job in the database (`db-target.ts`) —, what pass 1
 * deferred (`steps.ts`: computed fields, AI options, views, dashboards,
 * roles, automations, covers and email images) and the purge of a failed
 * import. Exported by the package root only (database code).
 */
export {
  checkImportedFile,
  importedMimeOf,
  type ImportFileCheckInput,
  type ImportFileDecision,
} from './files.js';
export {
  basePackageImportKey,
  DbBaseImportTarget,
  purgeBaseImport,
  type BaseImportSchemaMethods,
  type DbBaseImportJob,
  type DbBaseImportTargetDeps,
} from './db-target.js';
export { checkImportedImage, type AcceptedImage } from './assets.js';
export { triggerTableOf } from './automations.js';
export { brokenRefsOf, computedImportOrder, type ComputedImportStep } from './computed.js';
export { importedDashboard, widgetTablesOf } from './dashboards.js';
export { mentionedIds, mentionsAny, phantomIdsOf } from './phantoms.js';
export { reportDetached, sortDetached } from './report.js';
export { importedRoleConfig, roleSchemaOf } from './roles.js';
export { BASE_IMPORT_STEPS, importDeferred } from './steps.js';
export { viewConfigContextOf, type ImportedView } from './views.js';
export {
  asDefinition,
  checkDefinition,
  importBasePackage,
  type BaseImportContext,
  type BaseImportExtension,
  type ImportBasePackageOptions,
} from './pipeline.js';
export {
  importRecordOf,
  PackageRecordIds,
  planBaseImport,
  type DeferredImport,
  type DeferredLinkFilter,
  type ImportPlan,
  type PlanBaseImportOptions,
  type PlannedField,
  type PlannedFieldKind,
  type PlannedFile,
  type PlannedLink,
  type PlannedTable,
  type RecordRewriteContext,
} from './plan.js';
export {
  BaseImportStopped,
  type BaseImportTarget,
  type ImportAuditCounts,
  type ImportAutomationInput,
  type ImportBaseInput,
  type ImportDashboardInput,
  type ImportRoleInput,
  type ImportStoredCover,
  type ImportStoredEmailAsset,
  type ImportStoredFile,
  type ImportViewInput,
} from './target.js';
