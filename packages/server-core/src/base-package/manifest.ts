import {
  BASE_PACKAGE_DETACHED_KINDS,
  BASE_PACKAGE_FORMAT,
  BASE_PACKAGE_FORMAT_VERSION,
  basePackageCountsSchema,
  emailSchema,
  idOf,
  isId,
  isoDateTimeSchema,
  viewTypeSchema,
  widgetTypeSchema,
  type IdPrefix,
} from '@cellhive/contracts';
import { z } from 'zod';

/**
 * Shapes of the JSON entries of a `.chbase` package, format version 1
 * (ADR-24 §1 and its 2026-11 amendment, CONTRACTS §12.2). Every object is
 * strict: a key this version does not know is refused (`INVALID_ENTRY`).
 * Options, view configs, widget configs, definitions and role configs are
 * the stored forms of the source base — ids of the package, users as
 * emails — checked by their own schemas once their references are
 * rewritten (`references.ts`).
 */

export { BASE_PACKAGE_FORMAT, BASE_PACKAGE_FORMAT_VERSION };

/** Prefixes of the ids a package defines and an import replaces (ADR-24 §2.2). */
export const PACKAGE_ID_PREFIXES = [
  'tbl',
  'fld',
  'opt',
  'viw',
  'clr',
  'dsh',
  'wgt',
  'aut',
  'rol',
  'rec',
  'att',
] as const satisfies readonly IdPrefix[];
export type PackageIdPrefix = (typeof PACKAGE_ID_PREFIXES)[number];

/** Whether `value` is an id of a kind a package defines. */
export function isPackageId(value: unknown): value is string {
  return PACKAGE_ID_PREFIXES.some((prefix) => isId(prefix, value));
}

/** The prefix of a package id, or `null`. */
export function packageIdPrefixOf(value: string): PackageIdPrefix | null {
  return PACKAGE_ID_PREFIXES.find((prefix) => isId(prefix, value)) ?? null;
}

const MAX_SCHEMA_ITEMS = 100_000;
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u, { message: 'Expected a SHA-256 in hex' });
const name = z.string().min(1).max(1000);
const text = z.string().max(100_000).nullable();
const position = z.int().min(0);
const record = z.record(z.string(), z.unknown());
const packageEmail = emailSchema;

/** The first two keys, read before anything else: a newer format is refused by name. */
export const packageFormatSchema = z.object({
  format: z.unknown(),
  format_version: z.unknown(),
});

export const packageManifestSchema = z.strictObject({
  format: z.literal(BASE_PACKAGE_FORMAT),
  format_version: z.literal(BASE_PACKAGE_FORMAT_VERSION),
  app_version: z.string().min(1).max(64),
  exported_at: isoDateTimeSchema,
  exported_by_email: packageEmail.nullable(),
  base: z.strictObject({ id: idOf('bse'), name }),
  counts: basePackageCountsSchema,
  skipped: z.strictObject({ personal_views: z.int().min(0) }),
  /** Every entry but `manifest.json` → SHA-256 of its uncompressed bytes. */
  checksums: z.record(z.string().min(1).max(64), sha256Hex),
});
export type PackageManifest = z.infer<typeof packageManifestSchema>;

export const packageBaseSchema = z.strictObject({
  name,
  description: text,
  icon: z.string().max(100).nullable(),
  /** `meta.bases.settings` (collation, time zone, `strict_computed_permissions`…). */
  settings: record,
  /**
   * Ids the schema names but the package does not hold (a field or table in
   * the trash, a deleted option…): an import maps each to a new id that
   * names nothing, so the reference stays broken as it was.
   */
  missing_ids: z.array(z.string().refine(isPackageId)).max(MAX_SCHEMA_ITEMS),
});
export type PackageBase = z.infer<typeof packageBaseSchema>;

export const packageFieldSchema = z.strictObject({
  id: idOf('fld'),
  name,
  type: z.string().min(1).max(32),
  /** Stored options: ids of the package, users as emails (`references.ts`). */
  options: record,
  is_primary: z.boolean(),
  required: z.boolean(),
  unique_values: z.boolean(),
  description: text,
  position,
  /** `link` fields: the junction side; `links/<fld>.ndjson` exists for side `a`. */
  link_side: z.enum(['a', 'b']).nullable(),
  /** `formula`/`lookup` fields: type of the value (`meta.fields.result_type`), a hint only. */
  result_type: z.unknown().nullable(),
});
export type PackageField = z.infer<typeof packageFieldSchema>;

export const packageTableSchema = z.strictObject({
  id: idOf('tbl'),
  name,
  description: text,
  position,
  primary_field_id: idOf('fld'),
  fields: z.array(packageFieldSchema).min(1).max(1000),
});
export type PackageTable = z.infer<typeof packageTableSchema>;

export const packageTablesSchema = z.strictObject({
  tables: z.array(packageTableSchema).max(1000),
});
export type PackageTables = z.infer<typeof packageTablesSchema>;

export const packageViewSchema = z.strictObject({
  id: idOf('viw'),
  table_id: idOf('tbl'),
  type: viewTypeSchema,
  name,
  position,
  locked: z.boolean(),
  /** `StoredViewConfig` of the view. Shared views only: personal views are never exported. */
  config: record,
});
export type PackageView = z.infer<typeof packageViewSchema>;

export const packageViewsSchema = z.strictObject({
  views: z.array(packageViewSchema).max(MAX_SCHEMA_ITEMS),
});

export const packageWidgetSchema = z.strictObject({
  id: idOf('wgt'),
  type: widgetTypeSchema,
  title: z.string().max(1000),
  config: record,
  layout: record,
});
export type PackageWidget = z.infer<typeof packageWidgetSchema>;

export const packageDashboardSchema = z.strictObject({
  id: idOf('dsh'),
  name,
  icon: z.string().max(100).nullable(),
  description: text,
  theme: record,
  global_filters: z.array(z.unknown()).max(1000),
  position,
  widgets: z.array(packageWidgetSchema).max(1000),
});
export type PackageDashboard = z.infer<typeof packageDashboardSchema>;

export const packageDashboardsSchema = z.strictObject({
  dashboards: z.array(packageDashboardSchema).max(MAX_SCHEMA_ITEMS),
});

/** A slot of a definition the package left empty (`null`), and what it named. */
export const packageDetachedSchema = z.strictObject({
  /** Dotted path in the definition, e.g. `actions[0].config.secret_id`. */
  path: z.string().min(1).max(500),
  kind: z.enum(BASE_PACKAGE_DETACHED_KINDS),
  name: z.string().max(1000),
});
export type PackageDetached = z.infer<typeof packageDetachedSchema>;

export const packageAutomationSchema = z.strictObject({
  id: idOf('aut'),
  name,
  description: z.string().max(100_000),
  /** Stored definition; every slot listed in `detached` holds `null`. */
  definition: record,
  detached: z.array(packageDetachedSchema).max(1000),
});
export type PackageAutomation = z.infer<typeof packageAutomationSchema>;

export const packageAutomationsSchema = z.strictObject({
  automations: z.array(packageAutomationSchema).max(MAX_SCHEMA_ITEMS),
});

export const packageRoleSchema = z.strictObject({
  id: idOf('rol'),
  name,
  position,
  /** `RoleConfig` of a custom role. Assignments are never exported. */
  config: record,
});
export type PackageRole = z.infer<typeof packageRoleSchema>;

export const packageRolesSchema = z.strictObject({
  roles: z.array(packageRoleSchema).max(MAX_SCHEMA_ITEMS),
});

const fileShape = {
  id: idOf('att'),
  filename: z.string().min(1).max(1000),
  mime: z.string().min(1).max(255),
  size: z.int().min(0),
  sha256: sha256Hex,
};

/** One file of `files/attachments.json`; its content is `files/<id>`. */
export const packageFileSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...fileShape,
    kind: z.literal('cell'),
    table_id: idOf('tbl'),
    field_id: idOf('fld'),
    record_id: idOf('rec'),
  }),
  z.strictObject({
    ...fileShape,
    kind: z.literal('form_cover'),
    table_id: idOf('tbl'),
    view_id: idOf('viw'),
  }),
  z.strictObject({
    ...fileShape,
    kind: z.literal('email_asset'),
    automation_id: idOf('aut'),
    width: z.int().min(1).nullable(),
    height: z.int().min(1).nullable(),
  }),
]);
export type PackageFile = z.infer<typeof packageFileSchema>;

export const packageAttachmentsSchema = z.strictObject({
  files: z.array(packageFileSchema).max(MAX_SCHEMA_ITEMS),
});
export type PackageAttachments = z.infer<typeof packageAttachmentsSchema>;

/** One line of `data/<tbl>.ndjson`. */
export const packageRecordSchema = z.strictObject({
  id: idOf('rec'),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  created_by_email: packageEmail.nullable(),
  updated_by_email: packageEmail.nullable(),
  /** `__auto`: creation order; kept relative on import. */
  auto: z.int().min(1),
  /** `__parent_id` (tables with a `parent` field). */
  parent_id: idOf('rec').nullable().optional(),
  /** Stored values of the fields with a value of their own (not computed, link, button). */
  fields: z.record(idOf('fld'), z.unknown()),
});
export type PackageRecord = z.infer<typeof packageRecordSchema>;

/** One line of `links/<fld>.ndjson`: a row of the junction of the link pair. */
export const packageLinkSchema = z.strictObject({
  a: idOf('rec'),
  b: idOf('rec'),
  position: z.int().min(0),
});
export type PackageLink = z.infer<typeof packageLinkSchema>;

/** The schema of each schema entry, by name. */
export const PACKAGE_SCHEMA_ENTRY_SCHEMAS = {
  base: packageBaseSchema,
  tables: packageTablesSchema,
  views: packageViewsSchema,
  dashboards: packageDashboardsSchema,
  automations: packageAutomationsSchema,
  roles: packageRolesSchema,
} as const;
