import {
  automationDefinitionSchema,
  localeSchema,
  newId,
  timeZoneSchema,
  type Id,
} from '@cellhive/contracts';
import {
  buttonOptionsSchema,
  FieldValueError,
  getFieldType,
  linkOptionsSchema,
  parentOptionsSchema,
} from '@cellhive/field-types';
import { collectFieldIds, filterNodeSchema } from '@cellhive/filter-dsl';

import { SNIFF_BYTES } from '../../records/attachments/content-sniff.js';
import { packageWriteValue } from '../../records/package-values.js';
import { UNIQUE_CAPABLE_TYPES } from '../../schema/physical.js';
import { IMPORT_TABLE_FIELD_TYPES, normalizeSchemaName } from '../../schema/schema.service.js';
import { dataEntry, fileEntry, linksEntry, MANIFEST_ENTRY, SCHEMA_ENTRIES } from '../entries.js';
import { packageLinePath, packagePath, PackageProblems } from '../errors.js';
import {
  packageAutomationsSchema,
  packageBaseSchema,
  packageDashboardsSchema,
  packageLinkSchema,
  packageRecordSchema,
  packageRolesSchema,
  packageTablesSchema,
  packageViewsSchema,
  type PackageField,
  type PackageFile,
  type PackageManifest,
  type PackageRecord,
  type PackageTable,
} from '../manifest.js';
import {
  assignPackageIds,
  PackageIdMap,
  PackageLocation,
  PackageRewriter,
  PackageSchemaCatalog,
  type PackageIdResolver,
  type RewrittenAutomation,
} from '../references.js';
import { PackageUserMatcher, type PackageMember } from '../users.js';

import { checkImportedFile, importedMimeOf, type ImportFileDecision } from './files.js';

import type { PackageLoadRecord } from '../../records/record-mutation.service.js';
import type { ImportFieldInput, ImportLinkFieldInput } from '../../schema/schema.service.js';
import type { BasePackageReader, PackageEntryInfo } from '../reader.js';

/**
 * Pass 1 of a `.chbase` import (ADR-24 amendment §4, S9 research §2.4):
 * the whole package is checked before anything is written — every entry
 * read to its end once (CRC-32 and SHA-256 of the manifest), every JSON
 * entry against its strict schema, a new id for every object and record
 * (`PackageIdMap`), every reference rewritten "dry" (an id the package does
 * not define is `DANGLING_REFERENCE`), users matched by email to members of
 * the target organization only, every table, field and link pair checked
 * the way the target would check it, every record value checked by its
 * field type's parser, every junction row and parent against the records,
 * every file against the default block list. Problems are collected (at
 * most 100) and thrown together as one `INVALID_PACKAGE`.
 *
 * The plan then drives the writes (`pipeline.ts`). What this task does not
 * create yet — formula and lookup fields, AI options, shared views,
 * dashboards, custom roles, automations, form covers and email images —
 * is checked here as far as references go and handed over in
 * `ImportPlan.deferred` (T1019).
 */

export interface PlanBaseImportOptions {
  /** Members of the target organization (emails map to these only). */
  readonly members: Iterable<PackageMember>;
  /** `MAX_FIELDS_PER_TABLE` of the instance. */
  readonly maxFieldsPerTable: number;
  /** `ATTACHMENT_MAX_FILE_BYTES` of the instance. */
  readonly maxFileBytes: number;
  /** Bytes read so far out of the uncompressed bytes of the package. */
  readonly onProgress?: (done: number, total: number) => Promise<void> | void;
  /** Called between entries: throws to stop (a cancelled job). */
  readonly checkpoint?: () => Promise<void>;
}

/** Record ids of a package → their new ids and tables (records stay out of `PackageIdMap`). */
export class PackageRecordIds implements PackageIdResolver {
  private readonly slots = new Map<string, readonly [Id<'rec'>, number]>();

  /** Gives `id` (a record of table `table`) a new id; `false` when it has one already. */
  assign(id: string, table: number, newId: Id<'rec'>): boolean {
    if (this.slots.has(id)) return false;
    this.slots.set(id, [newId, table]);
    return true;
  }

  resolve(id: string): string | null {
    return this.slots.get(id)?.[0] ?? null;
  }

  /** Index (in `ImportPlan.tables`) of the table of a record of the package. */
  tableOf(id: string): number | undefined {
    return this.slots.get(id)?.[1];
  }

  get size(): number {
    return this.slots.size;
  }
}

/** How a field of the package is created. */
export type PlannedFieldKind =
  /** With its table (`SchemaService.importTable`). */
  | 'table'
  /** As a link pair (`SchemaService.importLinkField`). */
  | 'link'
  /** Later (T1019): formula and lookup fields. */
  | 'deferred';

export interface PlannedField {
  readonly source: PackageField;
  /** `schema/tables.json#/tables/<i>/fields/<j>`. */
  readonly location: PackageLocation;
  readonly kind: PlannedFieldKind;
  readonly id: Id<'fld'>;
  readonly name: string;
  /** Rank among the fields of its table, by the package's `position`. */
  readonly position: number;
  /** Options with the ids of the new base, users as members (or new ids for references); no `ai`. */
  readonly options: Record<string, unknown>;
  /** `options.ai` rewritten (prompt with the new ids), set later (T1019); `null` for other fields. */
  readonly ai: Record<string, unknown> | null;
}

export interface PlannedTable {
  /** Index in `ImportPlan.tables`. */
  readonly index: number;
  readonly source: PackageTable;
  readonly location: PackageLocation;
  readonly id: Id<'tbl'>;
  readonly name: string;
  readonly position: number;
  readonly primary: PlannedField;
  /** Every field, the primary one included, by rank. */
  readonly fields: readonly PlannedField[];
  readonly parent: PlannedField | null;
  /** `data/<tbl>.ndjson` of the package. */
  readonly entry: string;
  /** Records of the table in the package. */
  records: number;
}

/** A link pair to create, and the entry holding its junction rows. */
export interface PlannedLink {
  readonly table: PlannedTable;
  readonly target: PlannedTable;
  readonly field: PlannedField;
  readonly reverse: PlannedField | null;
  /** `links/<fld>.ndjson` of side `a`; `null` for a reverse field whose side `a` is not in the package. */
  readonly entry: string | null;
  readonly input: ImportLinkFieldInput;
}

/** A `record_filter` naming a field created later (T1019 sets it once that field exists). */
export interface DeferredLinkFilter {
  readonly fieldId: Id<'fld'>;
  readonly filter: Record<string, unknown>;
}

/** A file of `files/attachments.json`. */
export interface PlannedFile {
  readonly source: PackageFile;
  readonly location: PackageLocation;
  readonly entry: string;
  readonly id: Id<'att'>;
  readonly size: number;
  readonly sha256: string;
  /** Cell files: what the import does with it. */
  readonly decision: ImportFileDecision | null;
  /** Cell files: the cell, with the ids of the new base (set once the records are read). */
  cell: {
    readonly tableId: Id<'tbl'>;
    readonly fieldId: Id<'fld'>;
    readonly recordId: Id<'rec'>;
  } | null;
}

/** What T1019 creates, checked and rewritten by this pass. */
export interface DeferredImport {
  readonly computedFields: readonly {
    readonly table: PlannedTable;
    readonly field: PlannedField;
  }[];
  readonly aiFields: readonly { readonly table: PlannedTable; readonly field: PlannedField }[];
  readonly linkFilters: readonly DeferredLinkFilter[];
  readonly views: readonly unknown[];
  readonly dashboards: readonly unknown[];
  readonly automations: readonly RewrittenAutomation[];
  readonly roles: readonly unknown[];
  readonly formCovers: readonly PlannedFile[];
  readonly emailAssets: readonly PlannedFile[];
}

export interface ImportPlan {
  readonly manifest: PackageManifest;
  readonly base: {
    readonly name: string;
    readonly description: string | null;
    readonly icon: string | null;
    readonly settings: Record<string, unknown>;
  };
  readonly tables: readonly PlannedTable[];
  readonly links: readonly PlannedLink[];
  /** Cell files, in package order. */
  readonly files: readonly PlannedFile[];
  readonly records: PackageRecordIds;
  readonly ids: PackageIdMap;
  readonly users: PackageUserMatcher;
  readonly catalog: PackageSchemaCatalog;
  /** The import walk (new ids, members): T1019 rewrites what it creates with it. */
  readonly rewriter: PackageRewriter;
  readonly deferred: DeferredImport;
  /** Parents of the package that are not in it (a race of the export): imported as roots. */
  readonly droppedParents: number;
}

const BASE_ENTRY = SCHEMA_ENTRIES.base;
const TABLES_ENTRY = SCHEMA_ENTRIES.tables;
const TYPE_PRIMARY = new Set([
  'text',
  'number',
  'checkbox',
  'datetime',
  'select',
  'user',
  'attachment',
  'auto_number',
]);
const COMPUTED_TYPES = new Set(['formula', 'lookup']);
const PROGRESS_LINES = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rank of each item by `(position, index)`. */
function ranks<T extends { readonly position: number }>(items: readonly T[]): Map<T, number> {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.position - b.item.position || a.index - b.index);
  return new Map(order.map(({ item }, rank) => [item, rank]));
}

/** Zod issues of a failed parse, as the `params.issue` of an `INVALID_DEFINITION`. */
function issueOf(error: { readonly issues: readonly { readonly code: string }[] }): string {
  return error.issues[0]?.code ?? 'invalid';
}

/** Settings of `meta.bases` an import keeps (other keys are left out). */
function importedSettings(
  settings: Record<string, unknown>,
  problems: PackageProblems,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const at = (key: string) => packagePath(BASE_ENTRY, ['settings', key]);
  const invalid = (key: string) => {
    problems.add('INVALID_DEFINITION', at(key), 'A setting of the base is not valid here.');
  };
  for (const [key, value] of Object.entries(settings)) {
    switch (key) {
      case 'strict_computed_permissions':
        if (typeof value === 'boolean') out[key] = value;
        else invalid(key);
        break;
      case 'collation':
        // Checked against the collations of the target when the first table is created.
        if (typeof value === 'string' && value.length > 0 && value.length <= 128) out[key] = value;
        else invalid(key);
        break;
      case 'timezone': {
        const parsed = timeZoneSchema.safeParse(value);
        if (parsed.success) out[key] = parsed.data;
        else invalid(key);
        break;
      }
      case 'locale': {
        const parsed = localeSchema.safeParse(value);
        if (parsed.success) out[key] = parsed.data;
        else invalid(key);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** A rewritten field's options without `ai` (and that `ai`). */
function splitAi(options: unknown): { options: Record<string, unknown>; ai: unknown } {
  if (!isRecord(options)) return { options: {}, ai: undefined };
  const { ai, ...rest } = options;
  return { options: rest, ai };
}

/** The options check of a field created by this task (`null` = valid). */
function optionsProblem(type: string, options: Record<string, unknown>): string | null {
  switch (type) {
    case 'button': {
      const parsed = buttonOptionsSchema.safeParse(options);
      return parsed.success ? null : issueOf(parsed.error);
    }
    case 'parent': {
      const parsed = parentOptionsSchema.safeParse(options);
      return parsed.success ? null : issueOf(parsed.error);
    }
    case 'link': {
      const parsed = linkOptionsSchema.safeParse(options);
      return parsed.success ? null : issueOf(parsed.error);
    }
    default: {
      const definition = getFieldType(type as Parameters<typeof getFieldType>[0]);
      if (definition === undefined) return 'unsupported_type';
      const parsed = definition.optionsSchema.safeParse(options);
      return parsed.success ? null : issueOf(parsed.error);
    }
  }
}

interface FieldFlags {
  readonly unique_values: boolean;
  readonly required: boolean;
}

/** Whether `required`/`unique_values` suit the type (like `addField`). */
function flagsProblem(type: string, flags: FieldFlags): string | null {
  if (flags.unique_values && !UNIQUE_CAPABLE_TYPES.has(type as never)) return 'unique_values';
  if (flags.required && (type === 'button' || type === 'parent')) return 'required';
  return null;
}

/** Reads an entry to its end (CRC-32, SHA-256), keeping its first bytes. */
async function readHead(reader: BasePackageReader, name: string): Promise<Buffer> {
  const stream = await reader.open(name);
  const head: Buffer[] = [];
  let kept = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (kept < SNIFF_BYTES) {
      const part = chunk.subarray(0, SNIFF_BYTES - kept);
      head.push(part);
      kept += part.length;
    }
  }
  return Buffer.concat(head);
}

/** Parsed options of the fields of a plan, computed once per field. */
const parsedOptions = new WeakMap<PlannedField, unknown>();

function optionsOf(field: PlannedField): unknown {
  if (!parsedOptions.has(field)) {
    const definition = getFieldType(field.source.type as Parameters<typeof getFieldType>[0]);
    const parsed = definition?.optionsSchema.safeParse(field.options);
    parsedOptions.set(field, parsed?.success === true ? parsed.data : null);
  }
  return parsedOptions.get(field);
}

/** What `importRecordOf` needs of a plan. */
export interface RecordRewriteContext {
  readonly rewriter: PackageRewriter;
  readonly records: PackageRecordIds;
  /** Fields by their id in the package. */
  readonly fieldsById: ReadonlyMap<string, PlannedField>;
  /** Fields by their id in the new base. */
  readonly fieldsByNewId: ReadonlyMap<string, PlannedField>;
  /** Cell files imported, by their id in the package. */
  readonly keptFiles: ReadonlyMap<string, { readonly name: string; readonly mime: string }>;
}

/**
 * Rewrites one record of table `table` for the new base and checks its
 * values (pass 1 and the load share it): field ids and values through the
 * import walk, files left out of the import removed from their cell, users
 * matched, every value parsed by its field type. Problems go to the
 * rewriter's `PackageProblems`; the record is returned even when it has some.
 */
export function importRecordOf(
  plan: RecordRewriteContext,
  table: PlannedTable,
  line: number,
  record: PackageRecord,
): { readonly record: PackageLoadRecord; readonly parent: string | null } {
  const { rewriter } = plan;
  const location = PackageLocation.of(table.entry, line);
  // Files of the package left out of the import (blocked, too large…) leave their cell.
  const cells: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    const field = plan.fieldsById.get(key);
    if (field?.source.type === 'attachment' && Array.isArray(value)) {
      const kept = value.filter(
        (entry: unknown) =>
          !isRecord(entry) || typeof entry['id'] !== 'string' || plan.keptFiles.has(entry['id']),
      );
      cells[key] = kept.length === 0 ? null : kept;
    } else {
      cells[key] = value;
    }
  }
  const fields = rewriter.recordFields(cells, table.source.id, location.at('fields'));
  for (const [key, value] of Object.entries(fields)) {
    const field = plan.fieldsByNewId.get(key);
    if (field === undefined || value === null) continue;
    const at = location.at('fields', field.source.id).toString();
    if (field.source.type === 'auto_number') {
      if (typeof value !== 'string' || value.length > 1000) {
        rewriter.problems.add('INVALID_ENTRY', at, 'An auto number is not a text.');
      }
      continue;
    }
    const definition = getFieldType(field.source.type as Parameters<typeof getFieldType>[0]);
    const options = optionsOf(field);
    if (definition === undefined || options === null) continue;
    try {
      definition.toStorage(packageWriteValue(field.source, value), options, {
        resolveAttachment: (fileId) => ({
          id: fileId,
          name: 'file',
          size: 0,
          mime: 'application/octet-stream',
        }),
      });
    } catch (error) {
      if (!(error instanceof FieldValueError)) throw error;
      rewriter.problems.add('INVALID_ENTRY', at, 'A value does not fit its field.', {
        issue: error.issues[0]?.code ?? 'invalid',
      });
    }
  }
  const user = (value: string | null, key: string) =>
    rewriter.userOrNull(value, location.at(key)) as Id<'usr'> | null;
  return {
    record: {
      id: (plan.records.resolve(record.id) ?? record.id) as Id<'rec'>,
      auto: record.auto,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
      createdBy: user(record.created_by_email, 'created_by_email'),
      updatedBy: user(record.updated_by_email, 'updated_by_email'),
      fields,
    },
    parent: record.parent_id ?? null,
  };
}

/**
 * Pass 1: checks the whole package (see the top of this file) and returns
 * the plan of the import; throws `INVALID_PACKAGE` with every problem found
 * (at most 100, `params.more_problems` for the rest). Writes nothing.
 */
export async function planBaseImport(
  reader: BasePackageReader,
  options: PlanBaseImportOptions,
): Promise<ImportPlan & RecordRewriteContext> {
  const problems = new PackageProblems();
  const manifest = reader.manifest;
  const entries = reader.entries().filter((entry) => entry.name !== MANIFEST_ENTRY);
  const total = Math.max(
    1,
    entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0),
  );
  let done = 0;
  const advance = async (entry: PackageEntryInfo) => {
    done += entry.uncompressedSize;
    await options.onProgress?.(done, total);
    await options.checkpoint?.();
  };
  const info = (name: string) => reader.entry(name);

  // --- JSON entries ------------------------------------------------------------------
  const base = await reader.readJson(BASE_ENTRY, packageBaseSchema);
  const tablesEntry = await reader.readJson(TABLES_ENTRY, packageTablesSchema);
  const viewsEntry = await reader.readJson(SCHEMA_ENTRIES.views, packageViewsSchema);
  const dashboardsEntry = await reader.readJson(SCHEMA_ENTRIES.dashboards, packageDashboardsSchema);
  const automationsEntry = await reader.readJson(
    SCHEMA_ENTRIES.automations,
    packageAutomationsSchema,
  );
  const rolesEntry = await reader.readJson(SCHEMA_ENTRIES.roles, packageRolesSchema);
  const attachments = await reader.readAttachments();
  for (const name of [...Object.values(SCHEMA_ENTRIES), 'files/attachments.json']) {
    const found = info(name);
    if (found !== undefined) await advance(found);
  }

  // --- Ids ---------------------------------------------------------------------------
  const records = new PackageRecordIds();
  const ids = new PackageIdMap(records);
  assignPackageIds(
    ids,
    {
      tables: tablesEntry.tables,
      views: viewsEntry.views,
      dashboards: dashboardsEntry.dashboards,
      automations: automationsEntry.automations,
      roles: rolesEntry.roles,
      files: attachments.files,
      missingIds: base.missing_ids,
    },
    problems,
  );
  // Two objects with one id make every later problem misleading.
  problems.throwIfAny();
  const users = new PackageUserMatcher(options.members);
  const catalog = new PackageSchemaCatalog({ tables: tablesEntry.tables });
  const rewriter = new PackageRewriter({ direction: 'import', ids, users, catalog, problems });
  const settings = importedSettings(base.settings, problems);

  // --- Tables and fields --------------------------------------------------------------
  const tableRanks = ranks(tablesEntry.tables);
  const tableNames = new Set<string>();
  const planned: PlannedTable[] = [];
  const fieldsById = new Map<string, PlannedField>();
  const byOldTable = new Map<string, PlannedTable>();
  const computedFields: { table: PlannedTable; field: PlannedField }[] = [];
  const aiFields: { table: PlannedTable; field: PlannedField }[] = [];
  for (const [index, source] of tablesEntry.tables.entries()) {
    const location = PackageLocation.of(TABLES_ENTRY).at('tables', index);
    const rewritten = rewriter.table(source, location) as Record<string, unknown>;
    const name = checkedName(source.name, location.at('name'), problems);
    if (name !== null) {
      if (tableNames.has(name)) {
        problems.add(
          'INVALID_DEFINITION',
          location.at('name').toString(),
          'Two tables have one name.',
        );
      }
      tableNames.add(name);
    }
    if (source.fields.length > options.maxFieldsPerTable) {
      problems.add(
        'INVALID_DEFINITION',
        location.at('fields').toString(),
        'A table has more fields than this instance allows.',
        { limit: options.maxFieldsPerTable },
      );
    }
    const fieldRanks = ranks(source.fields);
    const rewrittenFields = Array.isArray(rewritten['fields']) ? rewritten['fields'] : [];
    const fields: PlannedField[] = [];
    const fieldNames = new Set<string>();
    const primaries = source.fields.filter((field) => field.is_primary);
    for (const [position, field] of source.fields.entries()) {
      const at = location.at('fields', position);
      const out = rewrittenFields[position] as Record<string, unknown> | undefined;
      const fieldName = checkedName(field.name, at.at('name'), problems);
      if (fieldName !== null) {
        if (fieldNames.has(fieldName)) {
          problems.add(
            'INVALID_DEFINITION',
            at.at('name').toString(),
            'Two fields of a table have one name.',
          );
        }
        fieldNames.add(fieldName);
      }
      const kind: PlannedFieldKind | null = IMPORT_TABLE_FIELD_TYPES.has(field.type)
        ? 'table'
        : field.type === 'link'
          ? 'link'
          : COMPUTED_TYPES.has(field.type)
            ? 'deferred'
            : null;
      if (kind === null) {
        problems.add(
          'INVALID_DEFINITION',
          at.at('type').toString(),
          'A field has a type this version does not know.',
        );
        continue;
      }
      const { options: fieldOptions, ai } = splitAi(out?.['options']);
      if (kind !== 'deferred') {
        const issue = optionsProblem(field.type, fieldOptions);
        if (issue !== null) {
          problems.add(
            'INVALID_DEFINITION',
            at.at('options').toString(),
            'The options of a field are not valid.',
            {
              issue,
            },
          );
        }
        const flags = flagsProblem(field.type, field);
        if (flags !== null) {
          problems.add(
            'INVALID_DEFINITION',
            at.at(flags).toString(),
            'A field cannot have this setting.',
          );
        }
      }
      if (field.type === 'link' && field.link_side === null) {
        problems.add(
          'INVALID_DEFINITION',
          at.at('link_side').toString(),
          'A link field has no side.',
        );
      }
      const plannedField: PlannedField = {
        source: field,
        location: at,
        kind,
        id: (ids.resolve(field.id) ?? field.id) as Id<'fld'>,
        name: fieldName ?? field.name,
        position: fieldRanks.get(field) ?? position,
        options: fieldOptions,
        ai: isRecord(ai) ? ai : null,
      };
      fields.push(plannedField);
      fieldsById.set(field.id, plannedField);
    }
    const primary = fields.find((field) => field.source.id === source.primary_field_id);
    if (
      primaries.length !== 1 ||
      primary === undefined ||
      !primary.source.is_primary ||
      !TYPE_PRIMARY.has(primary.source.type)
    ) {
      problems.add(
        'INVALID_DEFINITION',
        location.at('primary_field_id').toString(),
        'A table has no valid primary field.',
      );
    }
    const parents = fields.filter((field) => field.source.type === 'parent');
    if (parents.length > 1) {
      problems.add(
        'INVALID_DEFINITION',
        location.at('fields').toString(),
        'A table has two parent fields.',
      );
    }
    const table: PlannedTable = {
      index,
      source,
      location,
      id: (ids.resolve(source.id) ?? source.id) as Id<'tbl'>,
      name: name ?? source.name,
      position: tableRanks.get(source) ?? index,
      primary: primary ?? (fields[0] as PlannedField),
      fields: [...fields].sort((a, b) => a.position - b.position),
      parent: parents[0] ?? null,
      entry: dataEntry(source.id),
      records: 0,
    };
    planned.push(table);
    byOldTable.set(source.id, table);
    for (const field of fields) {
      if (field.kind === 'deferred') computedFields.push({ table, field });
      if (field.ai !== null) aiFields.push({ table, field });
    }
  }
  const created = new Set(
    [...fieldsById.values()].filter((field) => field.kind !== 'deferred').map((field) => field.id),
  );

  // --- Link pairs ---------------------------------------------------------------------
  const links: PlannedLink[] = [];
  const linkFilters: DeferredLinkFilter[] = [];
  const paired = new Set<string>();
  const linkOf = (field: PlannedField) => linkOptionsSchema.safeParse(field.options).data ?? null;
  for (const table of planned) {
    for (const field of table.fields) {
      if (field.kind !== 'link' || paired.has(field.source.id)) continue;
      const options = linkOf(field);
      if (options === null) continue;
      const target = planned.find((candidate) => candidate.id === options.link_table);
      if (target === undefined) continue;
      const partnerId = field.source.options['symmetric_field_id'];
      const partner = typeof partnerId === 'string' ? fieldsById.get(partnerId) : undefined;
      const partnerOptions = partner === undefined ? null : linkOf(partner);
      const reciprocal =
        partner !== undefined &&
        partnerOptions !== null &&
        partner.source.type === 'link' &&
        partner.source.options['symmetric_field_id'] === field.source.id &&
        partnerOptions.link_table === table.id &&
        target.fields.includes(partner) &&
        partner !== field;
      if (partner !== undefined && !reciprocal) {
        problems.add(
          'INVALID_DEFINITION',
          field.location.at('options').toString(),
          'The two sides of a link do not point at each other.',
        );
        continue;
      }
      let a = field;
      let aTable = table;
      let b: PlannedField | null = partner ?? null;
      let bTable = target;
      if (b !== null && field.source.link_side === 'b') {
        [a, b] = [b, a];
        [aTable, bTable] = [bTable, aTable];
      }
      if (b !== null && (a.source.link_side !== 'a' || b.source.link_side !== 'b')) {
        problems.add(
          'INVALID_DEFINITION',
          a.location.at('link_side').toString(),
          'The two sides of a link have the same side.',
        );
        continue;
      }
      paired.add(a.source.id);
      if (b !== null) paired.add(b.source.id);
      const sideOf = (
        side: PlannedField,
        own: PlannedTable,
        other: PlannedTable,
        reverse: PlannedField | null,
      ) => {
        const raw = linkOf(side);
        let filter = raw?.record_filter ?? null;
        if (filter !== null) {
          const structure = filterNodeSchema.safeParse(filter);
          if (!structure.success) {
            problems.add(
              'INVALID_DEFINITION',
              side.location.at('options', 'record_filter').toString(),
              'A record filter is not valid.',
            );
          } else if (collectFieldIds(structure.data).some((id) => !created.has(id))) {
            // It names a field created later (a formula, a lookup): T1019 sets it then.
            linkFilters.push({ fieldId: side.id, filter });
            filter = null;
          }
        }
        return {
          id: side.id,
          name: side.name,
          type: 'link',
          options: {
            ...side.options,
            link_table: other.id,
            record_filter: filter,
            ...(reverse === null
              ? {
                  bidirectional: false,
                  symmetric_field_id: null,
                  bidirectional_link_field_name: null,
                }
              : { bidirectional: true, symmetric_field_id: reverse.id }),
          },
          description: side.source.description,
          required: side.source.required,
          uniqueValues: false,
          position: side.position,
        } satisfies ImportFieldInput;
      };
      const entry = a.source.link_side === 'a' ? linksEntry(a.source.id) : null;
      if (entry !== null && !reader.has(entry)) {
        problems.add('MISSING_ENTRY', entry, 'The junction of a link is missing.');
      }
      links.push({
        table: aTable,
        target: bTable,
        field: a,
        reverse: b,
        entry,
        input: {
          tableId: aTable.id,
          field: sideOf(a, aTable, bTable, b),
          reverse: b === null ? null : sideOf(b, bTable, aTable, a),
        },
      });
    }
  }
  const linkEntries = new Set(links.flatMap((link) => (link.entry === null ? [] : [link.entry])));

  // --- Entries of the archive ----------------------------------------------------------
  const tableEntries = new Set(planned.map((table) => table.entry));
  for (const entry of entries) {
    if (
      (entry.kind.kind === 'data' && !tableEntries.has(entry.name)) ||
      (entry.kind.kind === 'links' && !linkEntries.has(entry.name))
    ) {
      problems.add('INVALID_ENTRY', entry.name, 'The entry belongs to nothing the schema defines.');
    }
  }
  for (const table of planned) {
    if (!reader.has(table.entry)) {
      problems.add('MISSING_ENTRY', table.entry, 'The records of a table are missing.');
    }
  }
  problems.throwIfAny();

  // --- Files (read once: checksums, first bytes) ----------------------------------------
  const filesByOld = new Map<string, PlannedFile>();
  const fileEntries = new Set<string>();
  const cellFiles: PlannedFile[] = [];
  const formCovers: PlannedFile[] = [];
  const emailAssets: PlannedFile[] = [];
  for (const [index, file] of attachments.files.entries()) {
    const location = PackageLocation.of('files/attachments.json').at('files', index);
    const entry = fileEntry(file.id);
    fileEntries.add(entry);
    const found = info(entry);
    if (found === undefined) {
      problems.add('MISSING_ENTRY', entry, 'The content of a file is missing.');
      continue;
    }
    if (manifest.checksums[entry] !== file.sha256) {
      problems.add(
        'CHECKSUM_MISMATCH',
        location.at('sha256').toString(),
        'The SHA-256 of a file differs from the manifest.',
      );
    }
    if (found.uncompressedSize !== file.size) {
      problems.add(
        'INVALID_ENTRY',
        location.at('size').toString(),
        'The size of a file differs from its content.',
      );
    }
    if (importedMimeOf(file.mime) === null) {
      problems.add(
        'INVALID_ENTRY',
        location.at('mime').toString(),
        'A file has no valid media type.',
      );
    }
    const head = await readHead(reader, entry);
    await advance(found);
    let decision: ImportFileDecision | null = null;
    if (file.kind === 'cell') {
      const field = fieldsById.get(file.field_id);
      const table = byOldTable.get(file.table_id);
      if (
        field === undefined ||
        table === undefined ||
        field.source.type !== 'attachment' ||
        !table.fields.includes(field)
      ) {
        problems.add(
          'INVALID_ENTRY',
          location.toString(),
          'A file names no attachment field of its table.',
        );
      } else {
        decision = checkImportedFile({
          filename: file.filename,
          mime: file.mime,
          size: found.uncompressedSize,
          head,
          fieldOptions: field.options,
          maxFileBytes: options.maxFileBytes,
        });
      }
    }
    const plannedFile: PlannedFile = {
      source: file,
      location,
      entry,
      id: (ids.resolve(file.id) ?? file.id) as Id<'att'>,
      size: found.uncompressedSize,
      sha256: file.sha256,
      decision,
      cell: null,
    };
    filesByOld.set(file.id, plannedFile);
    if (file.kind === 'cell') cellFiles.push(plannedFile);
    else if (file.kind === 'form_cover') formCovers.push(plannedFile);
    else emailAssets.push(plannedFile);
  }
  for (const entry of entries) {
    if (entry.kind.kind === 'file' && !fileEntries.has(entry.name)) {
      problems.add('INVALID_ENTRY', entry.name, 'A file is not listed in files/attachments.json.');
    }
  }
  const keptFiles = new Map<string, { name: string; mime: string }>();
  for (const file of cellFiles) {
    if (file.decision?.ok === true) {
      keptFiles.set(file.source.id, { name: file.decision.filename, mime: file.decision.mime });
    }
  }

  // --- Records ------------------------------------------------------------------------
  const fieldsByNewId = new Map(
    [...fieldsById.values()].map((field) => [field.id as string, field]),
  );
  const plan: RecordRewriteContext = { rewriter, records, fieldsById, fieldsByNewId, keptFiles };
  const parentsOf = new Map<PlannedTable, [string, string][]>();
  for (const table of planned) {
    let previous = 0;
    let lines = 0;
    const pending: [string, string][] = [];
    for await (const { line, value } of reader.readNdjson(table.entry, packageRecordSchema)) {
      lines += 1;
      if (!records.assign(value.id, table.index, newId('rec'))) {
        problems.add(
          'DUPLICATE_ID',
          packageLinePath(table.entry, line, ['id']),
          'Two records of the package have one id.',
          {
            id: value.id,
            reason: 'package',
          },
        );
        continue;
      }
      if (value.auto <= previous) {
        problems.add(
          'INVALID_ENTRY',
          packageLinePath(table.entry, line, ['auto']),
          'Records are not in creation order.',
        );
      }
      previous = value.auto;
      if (value.parent_id !== undefined && value.parent_id !== null) {
        if (table.parent === null) {
          problems.add(
            'INVALID_ENTRY',
            packageLinePath(table.entry, line, ['parent_id']),
            'A record of a table without sub-records has a parent.',
          );
        } else {
          pending.push([value.id, value.parent_id]);
        }
      }
      // Files named by the cells: files of that very cell only.
      for (const field of table.fields) {
        if (field.source.type !== 'attachment') continue;
        const cell = value.fields[field.source.id];
        if (!Array.isArray(cell)) continue;
        for (const entry of cell as unknown[]) {
          const fileId = isRecord(entry) ? entry['id'] : undefined;
          if (typeof fileId !== 'string') continue;
          const file = filesByOld.get(fileId)?.source;
          if (
            file !== undefined &&
            (file.kind !== 'cell' ||
              file.record_id !== value.id ||
              file.field_id !== field.source.id)
          ) {
            problems.add(
              'INVALID_ENTRY',
              packageLinePath(table.entry, line, ['fields', field.source.id]),
              'A cell names a file of another cell.',
            );
          }
        }
      }
      importRecordOf(plan, table, line, value);
      if (lines % PROGRESS_LINES === 0) await options.checkpoint?.();
    }
    table.records = lines;
    parentsOf.set(table, pending);
    const found = info(table.entry);
    if (found !== undefined) await advance(found);
  }

  // Parents: a record of the same table, or none (it left the base while the export ran).
  let droppedParents = 0;
  for (const [table, pending] of parentsOf) {
    for (const [child, parent] of pending) {
      const of = records.tableOf(parent);
      if (of === undefined) droppedParents += 1;
      else if (of !== table.index) {
        problems.add(
          'INVALID_ENTRY',
          packagePath(table.entry),
          'A parent is a record of another table.',
          {
            id: child,
          },
        );
      }
    }
  }

  // Cells of files: the record exists in the file's table.
  for (const file of cellFiles) {
    const rewritten = rewriter.file(file.source, file.location) as Record<string, unknown>;
    const source = file.source;
    if (source.kind !== 'cell') continue;
    const table = byOldTable.get(source.table_id);
    if (table === undefined || records.tableOf(source.record_id) !== table.index) {
      problems.add(
        'INVALID_ENTRY',
        file.location.at('record_id').toString(),
        'A file names a record its table does not have.',
      );
      continue;
    }
    file.cell = {
      tableId: rewritten['table_id'] as Id<'tbl'>,
      fieldId: rewritten['field_id'] as Id<'fld'>,
      recordId: rewritten['record_id'] as Id<'rec'>,
    };
  }
  for (const file of [...formCovers, ...emailAssets]) rewriter.file(file.source, file.location);

  // --- Junction rows ------------------------------------------------------------------
  for (const link of links) {
    if (link.entry === null) continue;
    const aSingle = linkOf(link.field)?.allow_multiple === false;
    const bSingle = link.reverse !== null && linkOf(link.reverse)?.allow_multiple === false;
    const seenA = new Set<string>();
    const seenB = new Set<string>();
    for await (const { line, value } of reader.readNdjson(link.entry, packageLinkSchema)) {
      const at = (key: string) => packageLinePath(link.entry ?? '', line, [key]);
      if (records.tableOf(value.a) !== link.table.index) {
        problems.add(
          records.resolve(value.a) === null ? 'DANGLING_REFERENCE' : 'INVALID_ENTRY',
          at('a'),
          'A link names a record its table does not have.',
          { id: value.a },
        );
      }
      if (records.tableOf(value.b) !== link.target.index) {
        problems.add(
          records.resolve(value.b) === null ? 'DANGLING_REFERENCE' : 'INVALID_ENTRY',
          at('b'),
          'A link names a record its table does not have.',
          { id: value.b },
        );
      }
      if (aSingle) {
        if (seenA.has(value.a))
          problems.add('INVALID_ENTRY', at('a'), 'A single-record link has two records.');
        seenA.add(value.a);
      }
      if (bSingle) {
        if (seenB.has(value.b))
          problems.add('INVALID_ENTRY', at('b'), 'A single-record link has two records.');
        seenB.add(value.b);
      }
      if (value.position > 2 ** 31 - 1)
        problems.add('INVALID_ENTRY', at('position'), 'A link position is too large.');
      if (line % PROGRESS_LINES === 0) await options.checkpoint?.();
    }
    const found = info(link.entry);
    if (found !== undefined) await advance(found);
  }

  // --- What T1019 creates: references and structure ----------------------------------------
  const views = viewsEntry.views.map((view, index) =>
    rewriter.view(view, PackageLocation.of(SCHEMA_ENTRIES.views).at('views', index)),
  );
  for (const [index, view] of viewsEntry.views.entries()) {
    if (byOldTable.get(view.table_id) === undefined) {
      problems.add(
        'DANGLING_REFERENCE',
        PackageLocation.of(SCHEMA_ENTRIES.views).at('views', index, 'table_id').toString(),
        'The package names an id it does not define.',
        { id: view.table_id },
      );
    }
    const filter = view.config['filter'];
    if (filter !== null && filter !== undefined && !filterNodeSchema.safeParse(filter).success) {
      problems.add(
        'INVALID_DEFINITION',
        PackageLocation.of(SCHEMA_ENTRIES.views).at('views', index, 'config', 'filter').toString(),
        'A filter is not valid.',
      );
    }
  }
  const dashboards = dashboardsEntry.dashboards.map((dashboard, index) =>
    rewriter.dashboard(
      dashboard,
      PackageLocation.of(SCHEMA_ENTRIES.dashboards).at('dashboards', index),
    ),
  );
  const automations = automationsEntry.automations.map((automation, index) => {
    const at = PackageLocation.of(SCHEMA_ENTRIES.automations).at('automations', index);
    const rewritten = rewriter.automation(structuredClone(automation), at);
    if (!automationDefinitionSchema.safeParse(rewritten.automation['definition']).success) {
      problems.add(
        'INVALID_DEFINITION',
        at.at('definition').toString(),
        'An automation is not valid.',
      );
    }
    return rewritten;
  });
  const roles = rolesEntry.roles.map((role, index) =>
    rewriter.role(role, PackageLocation.of(SCHEMA_ENTRIES.roles).at('roles', index)),
  );

  problems.throwIfAny();
  await options.onProgress?.(total, total);
  return {
    manifest,
    base: { name: base.name, description: base.description, icon: base.icon, settings },
    tables: planned,
    links,
    files: cellFiles,
    records,
    ids,
    users,
    catalog,
    rewriter,
    deferred: {
      computedFields,
      aiFields,
      linkFilters,
      views,
      dashboards,
      automations,
      roles,
      formCovers,
      emailAssets,
    },
    droppedParents,
    fieldsById,
    fieldsByNewId,
    keptFiles,
  };
}

/** A schema name of the package, normalized; `null` (and a problem) when it is not one. */
function checkedName(
  value: string,
  location: PackageLocation,
  problems: PackageProblems,
): string | null {
  try {
    return normalizeSchemaName(value);
  } catch {
    problems.add('INVALID_DEFINITION', location.toString(), 'A name is not valid.');
    return null;
  }
}
