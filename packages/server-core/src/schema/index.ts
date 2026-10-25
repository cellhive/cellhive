export { autoNumberCells, reserveAutoValues, type AutoNumberCellInput } from './auto-number.js';
export {
  checkConstraintNamesOf,
  collationExists,
  dataTableExists,
  foreignKeysReferencing,
  indexNamesOf,
  liveColumns,
  usedColumnSlots,
  type CatalogColumn,
  type IncomingForeignKey,
} from './catalog.js';
export { checkSchemaConsistency, planStoredField } from './consistency.js';
export {
  canonicalOfOldColumn,
  computedDefinitionOf,
  isComputedDefinitionJson,
  definitionJson,
  definitionRefOf,
  definitionTypeOf,
  conversionColumnsOf,
  storedDefinitionOf,
  type ComputedStoredDefinition,
  type ConversionColumn,
  type StoredDefinition,
} from './conversion-ddl.js';
export {
  FieldConversionsRepository,
  LIVE_CONVERSION_STATUSES,
  type InsertFieldConversionInput,
} from './field-conversions.repository.js';
export {
  fieldDependents,
  roleUsesField,
  viewUsesField,
  type FieldDependent,
} from './field-dependents.js';
export { mergeFieldOptions, withNewOptionIds } from './field-options.js';
export {
  FieldsRepository,
  type GetFieldOptions,
  type InsertFieldInput,
  type UpdateFieldInput,
} from './fields.repository.js';
export {
  assertDataTableName,
  assertFieldColumnName,
  canonicalColumnOf,
  DATA_SCHEMA,
  DATA_TABLE_NAME_PATTERN,
  dataTableName,
  DELETED_COLUMN_NAME_PATTERN,
  deletedColumnName,
  FIELD_COLUMN_NAME_PATTERN,
  fieldColumnName,
  indexName,
  junctionTableName,
  OLD_COLUMN_NAME_PATTERN,
  oldColumnName,
  renamePrefixed,
} from './names.js';
export {
  expectedColumnOf,
  planColumn,
  SYSTEM_COLUMN_NAMES,
  SYSTEM_COLUMNS,
  UNIQUE_CAPABLE_TYPES,
  type ColumnPlan,
  type ExpectedColumn,
  type IndexPlan,
  type PhysicalField,
} from './physical.js';
export {
  COMPACTION_SLOT_THRESHOLD,
  DDL_LOCK_TIMEOUT_MS,
  DDL_MAX_ATTEMPTS,
  ddlRetryDelayMs,
  DEFAULT_SLOT_THRESHOLDS,
  effectiveMaxFields,
  HARD_MAX_FIELDS_PER_TABLE,
  isRetryableDdlError,
  LOCKED_SLOT_THRESHOLD,
  PG_MAX_COLUMNS,
  schemaLockKey,
  slotDecision,
  type SlotDecision,
  type SlotThresholds,
} from './policy.js';
export {
  DEFAULT_COLLATION,
  FIELD_CONVERSION_WINDOW_MS,
  FIELD_CONVERT_JOB,
  ConcurrentFieldEditsError,
  FIELD_RESTORE_WINDOW_MS,
  fieldConvertingError,
  MAX_SCHEMA_NAME_LENGTH,
  normalizeSchemaName,
  REMOVE_SELECT_OPTIONS_JOB_TYPE,
  SchemaService,
  type AddFieldInput,
  type CompactionResult,
  type ConversionOutcome,
  type RevertConversionOptions,
  type RevertMode,
  type StartConversionInput,
  type StartLinkConversionInput,
  type StartedConversion,
  type CreatedTable,
  type CreateTableInput,
  type FieldPatch,
  type ComputedFieldContext,
  type LinkFieldContext,
  type SchemaServiceOptions,
  type TablePatch,
  type UpdateFieldOptionsInput,
} from './schema.service.js';
export {
  noopSchemaChangePublisher,
  type SchemaChange,
  type SchemaChangeAction,
  type SchemaChangePublisher,
} from './schema-change-publisher.js';
export {
  noopTablePurgeHooks,
  TABLE_TRASH_RETENTION_MS,
  type PurgedTable,
  type PurgeTableOptions,
  type TablePurgeHookInput,
  type TablePurgeHooks,
  type TablePurgeReason,
} from './table-purge.js';
export {
  TablesRepository,
  type TrashedTable,
  type GetTableOptions,
  type InsertTableInput,
  type UpdateTableInput,
} from './tables.repository.js';
