import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { sql } from 'kysely';

import type { Db } from '@cellhive/server-core';

/**
 * `.chbase` packages built byte by byte for the import tests (BACKLOG
 * T1018, P125/P127): every field of the local headers, the central
 * directory and the end records can be forged, so each poisoned package is
 * made here, in memory — no binary fixture is committed. The zip writer is
 * the one of `packages/server-core/test/base-package/zip-builder.ts` (tests
 * of one package never import another's test files).
 */

export interface RawEntry {
  readonly name: string | Buffer;
  /** Uncompressed content. */
  readonly data: Buffer;
  /** 0 = stored, 8 = deflated. */
  readonly method?: number;
  readonly externalAttributes?: number;
  /** Forged uncompressed size. */
  readonly uncompressedSize?: number;
}

const UNIX_FILE = (0o100644 << 16) >>> 0;
const MADE_BY_UNIX = 0x0314;
const UTF8 = 0x800;

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function u64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

export function buildZip(entries: readonly RawEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf8') : entry.name;
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const size = entry.uncompressedSize ?? entry.data.length;
    const header = (signature: number[]) => [
      u16(20),
      u16(UTF8),
      u16(method),
      u16(0),
      u16(0x21),
      u32(crc),
      u32(body.length),
      u32(size),
      u16(name.length),
      ...signature.map((value) => u16(value)),
    ];
    const local = Buffer.concat([u32(0x04034b50), ...header([0]), name]);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(MADE_BY_UNIX),
        ...header([0, 0, 0, 0]),
        u32(entry.externalAttributes ?? UNIX_FILE),
        u32(offset),
        name,
      ]),
    );
    parts.push(local, body);
    offset += local.length + body.length;
  }
  const directory = Buffer.concat(central);
  const count = entries.length;
  const zip64 = count > 0xffff;
  const tail: Buffer[] = [];
  if (zip64) {
    tail.push(
      Buffer.concat([
        u32(0x06064b50),
        u64(44n),
        u16(45),
        u16(45),
        u32(0),
        u32(0),
        u64(BigInt(count)),
        u64(BigInt(count)),
        u64(BigInt(directory.length)),
        u64(BigInt(offset)),
      ]),
      Buffer.concat([u32(0x07064b50), u32(0), u64(BigInt(offset + directory.length)), u32(1)]),
    );
  }
  tail.push(
    Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(zip64 ? 0xffff : count),
      u16(zip64 ? 0xffff : count),
      u32(directory.length),
      u32(zip64 ? 0xffffffff : offset),
      u16(0),
    ]),
  );
  return Buffer.concat([...parts, directory, ...tail]);
}

const BOUNDARY = 'cellhive-base-import-boundary';

/** A `multipart/form-data` body with one `file` part (the import route). */
export function multipart(filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: application/zip\r\n\r\n',
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

export const MULTIPART = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

export const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

/** An id of the package (`<prefix>_` + 16 base62). */
export const pid = (prefix: string, label: string): string =>
  `${prefix}_${label
    .replace(/[^0-9A-Za-z]/gu, '')
    .padEnd(16, '0')
    .slice(0, 16)}`;

export const P = {
  base: pid('bse', 'PkgBase'),
  things: pid('tbl', 'Things'),
  name: pid('fld', 'ThingName'),
  files: pid('fld', 'ThingFiles'),
  code: pid('fld', 'ThingCode'),
  note: pid('fld', 'ThingNote'),
} as const;

export const ZERO_COUNTS = {
  tables: 0,
  fields: 0,
  records: 0,
  links: 0,
  attachments: 0,
  views: 0,
  dashboards: 0,
  widgets: 0,
  automations: 0,
  roles: 0,
};

/** A field of `schema/tables.json` with the defaults of a plain field. */
export function field(
  id: string,
  name: string,
  type: string,
  options: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    type,
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    link_side: null,
    result_type: null,
    ...extra,
  };
}

export function record(
  id: string,
  auto: number,
  fields: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-03T03:04:05.000Z',
    created_by_email: null,
    updated_by_email: null,
    auto,
    fields,
    ...extra,
  };
}

/** The content of a package, by entry name (JSON values are serialized, NDJSON as arrays of lines). */
export interface PackageSpec {
  readonly base?: Record<string, unknown>;
  readonly tables: readonly Record<string, unknown>[];
  readonly records?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly links?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly files?: readonly { readonly meta: Record<string, unknown>; readonly data: Buffer }[];
  /** More entries of `files/attachments.json`, their content given in `raw`. */
  readonly fileMetas?: readonly Record<string, unknown>[];
  readonly views?: readonly unknown[];
  readonly automations?: readonly unknown[];
  /** Entries added as they are (unsafe names, unknown entries…). */
  readonly raw?: readonly RawEntry[];
  readonly manifest?: Record<string, unknown>;
  /** Forged checksums, by entry. */
  readonly checksums?: Readonly<Record<string, string>>;
}

/** The entries of a package from its spec, manifest last. */
export function packageEntries(spec: PackageSpec): RawEntry[] {
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  const ndjson = (lines: readonly unknown[]) =>
    Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  const entries: { name: string; data: Buffer; method?: number }[] = [
    {
      name: 'schema/base.json',
      data: json({
        name: 'Imported',
        description: null,
        icon: null,
        settings: {},
        missing_ids: [],
        ...spec.base,
      }),
    },
    { name: 'schema/tables.json', data: json({ tables: spec.tables }) },
    { name: 'schema/views.json', data: json({ views: spec.views ?? [] }) },
    { name: 'schema/dashboards.json', data: json({ dashboards: [] }) },
    { name: 'schema/automations.json', data: json({ automations: spec.automations ?? [] }) },
    { name: 'schema/roles.json', data: json({ roles: [] }) },
    {
      name: 'files/attachments.json',
      data: json({
        files: [...(spec.files ?? []).map((file) => file.meta), ...(spec.fileMetas ?? [])],
      }),
    },
  ];
  for (const table of spec.tables) {
    const id = table['id'] as string;
    entries.push({ name: `data/${id}.ndjson`, data: ndjson(spec.records?.[id] ?? []) });
  }
  for (const [fieldId, rows] of Object.entries(spec.links ?? {})) {
    entries.push({ name: `links/${fieldId}.ndjson`, data: ndjson(rows) });
  }
  for (const file of spec.files ?? []) {
    entries.push({ name: `files/${file.meta['id'] as string}`, data: file.data, method: 0 });
  }
  const raw = spec.raw ?? [];
  const checksums = Object.fromEntries([
    ...entries.map((entry) => [entry.name, sha256(entry.data)]),
    ...raw.flatMap((entry) =>
      typeof entry.name === 'string' ? [[entry.name, sha256(entry.data)]] : [],
    ),
  ]) as Record<string, string>;
  const manifest = {
    format: 'cellhive-base',
    format_version: 1,
    app_version: '0.0.0',
    exported_at: '2026-11-08T00:00:00.000Z',
    exported_by_email: null,
    base: { id: P.base, name: 'Imported' },
    counts: ZERO_COUNTS,
    skipped: { personal_views: 0 },
    checksums: { ...checksums, ...spec.checksums },
    ...spec.manifest,
  };
  return [...entries, ...raw, { name: 'manifest.json', data: json(manifest) }];
}

export function buildPackage(spec: PackageSpec): Buffer {
  return buildZip(packageEntries(spec));
}

/** A table `Things`: `Name` (primary text), `Files` (attachments, no own block list), `Code`. */
export function thingsTable(
  extra: readonly Record<string, unknown>[] = [],
  options: { readonly codeUnique?: boolean } = {},
): Record<string, unknown> {
  return {
    id: P.things,
    name: 'Things',
    description: null,
    position: 0,
    primary_field_id: P.name,
    fields: [
      field(P.name, 'Name', 'text', {}, { is_primary: true }),
      field(P.files, 'Files', 'attachment', { blocked_extensions: [] }, { position: 1 }),
      field(
        P.code,
        'Code',
        'text',
        {},
        { position: 2, unique_values: options.codeUnique ?? false },
      ),
      ...extra,
    ],
  };
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * What an import may leave behind (P125, P126): rows of the meta tables a
 * base fills, the audit log and events, `data.*` tables, stored objects and
 * temporary files — compared before and after a failed import.
 */
export async function leftovers(
  db: Db,
  roots: { readonly storage: string; readonly temp: string },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const table of [
    'meta.bases',
    'meta.tables',
    'meta.fields',
    'meta.views',
    'meta.base_roles',
    'meta.attachments',
    'meta.date_reminder_cursors',
    'meta.audit_logs',
    'meta.events',
  ]) {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ${sql.table(table)}
    `.execute(db.kysely);
    out[table] = Number(rows[0]?.n);
  }
  const { rows } = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'data'
  `.execute(db.kysely);
  out['data.*'] = Number(rows[0]?.n);
  const hidden = await db.kysely
    .selectFrom('meta.bases')
    .select('id')
    .where('import_job_id', 'is not', null)
    .execute();
  out['hidden bases'] = hidden.length;
  out['objects'] = await listFiles(roots.storage);
  out['temporary files'] = await listFiles(roots.temp);
  return out;
}
