import { isId, type Id } from '@cellhive/contracts';

/**
 * Entries of a `.chbase` package (ADR-24 §1 and its 2026-11 amendment,
 * CONTRACTS §12.2). A package holds these names and nothing else: the
 * reader refuses any other name (`UNKNOWN_ENTRY`) and never uses a name
 * as a file system path — entries are streamed into parsers or into new
 * storage keys.
 */

export const MANIFEST_ENTRY = 'manifest.json';

/** The schema entries, by name. */
export const SCHEMA_ENTRY_NAMES = [
  'base',
  'tables',
  'views',
  'dashboards',
  'automations',
  'roles',
] as const;
export type SchemaEntryName = (typeof SCHEMA_ENTRY_NAMES)[number];

export const SCHEMA_ENTRIES: Readonly<Record<SchemaEntryName, string>> = {
  base: 'schema/base.json',
  tables: 'schema/tables.json',
  views: 'schema/views.json',
  dashboards: 'schema/dashboards.json',
  automations: 'schema/automations.json',
  roles: 'schema/roles.json',
};

/** Metadata of every file of the package (cells, form covers, email images). */
export const ATTACHMENTS_ENTRY = 'files/attachments.json';

/** Records of a table, one JSON object per line. */
export function dataEntry(tableId: Id<'tbl'>): string {
  return `data/${tableId}.ndjson`;
}

/** Rows of the junction of a link pair (`a` side field), one JSON object per line. */
export function linksEntry(fieldId: Id<'fld'>): string {
  return `links/${fieldId}.ndjson`;
}

/** Content of one file. */
export function fileEntry(attachmentId: Id<'att'>): string {
  return `files/${attachmentId}`;
}

/** What an allowed entry name holds. */
export type PackageEntryKind =
  | { readonly kind: 'manifest' }
  | { readonly kind: 'schema'; readonly name: SchemaEntryName }
  | { readonly kind: 'attachments' }
  | { readonly kind: 'data'; readonly tableId: Id<'tbl'> }
  | { readonly kind: 'links'; readonly fieldId: Id<'fld'> }
  | { readonly kind: 'file'; readonly attachmentId: Id<'att'> };

/** The allowlist: ASCII only, no directory part other than these, ids of CONTRACTS §1.2. */
const ALLOWED_ENTRY =
  /^(?:(manifest\.json)|schema\/(base|tables|views|dashboards|automations|roles)\.json|(files\/attachments\.json)|data\/(tbl_[0-9A-Za-z]{16})\.ndjson|links\/(fld_[0-9A-Za-z]{16})\.ndjson|files\/(att_[0-9A-Za-z]{16}))$/u;

/** The kind of an entry name, or `null` when the allowlist does not have it. */
export function classifyEntry(name: string): PackageEntryKind | null {
  const match = ALLOWED_ENTRY.exec(name);
  if (match === null) return null;
  const [, manifest, schema, attachments, table, field, attachment] = match;
  if (manifest !== undefined) return { kind: 'manifest' };
  if (schema !== undefined) return { kind: 'schema', name: schema as SchemaEntryName };
  if (attachments !== undefined) return { kind: 'attachments' };
  if (isId('tbl', table)) return { kind: 'data', tableId: table };
  if (isId('fld', field)) return { kind: 'links', fieldId: field };
  if (isId('att', attachment)) return { kind: 'file', attachmentId: attachment };
  return null;
}

/** JSON entries (read whole, bounded by `maxJsonEntryBytes`). */
export function isJsonEntry(kind: PackageEntryKind): boolean {
  return kind.kind === 'manifest' || kind.kind === 'schema' || kind.kind === 'attachments';
}

/** NDJSON entries (read line by line, each bounded by `maxNdjsonLineBytes`). */
export function isNdjsonEntry(kind: PackageEntryKind): boolean {
  return kind.kind === 'data' || kind.kind === 'links';
}

/** Media types whose content is already compressed: stored as is (`STORE`), not deflated again. */
const COMPRESSED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/jxl',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/x-bzip2',
  'application/x-xz',
  'application/zstd',
  'application/epub+zip',
  'application/java-archive',
  'font/woff',
  'font/woff2',
]);

const COMPRESSED_PREFIXES = [
  'video/',
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.oasis.opendocument.',
];

/** Whether a file of this media type is stored without compression (it would not shrink). */
export function isAlreadyCompressed(mime: string): boolean {
  const essence = mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (COMPRESSED_TYPES.has(essence)) return true;
  if (essence.startsWith('audio/')) return essence !== 'audio/wav' && essence !== 'audio/x-wav';
  return COMPRESSED_PREFIXES.some((prefix) => essence.startsWith(prefix));
}
