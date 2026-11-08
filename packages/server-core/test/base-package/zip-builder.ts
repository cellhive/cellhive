import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Builds zip files byte by byte for the reader tests: every field of the
 * local headers, the central directory and the end records can be forged,
 * so each poisoned package of BACKLOG T1016 is made here, in memory — no
 * binary fixture is committed.
 */

export interface RawEntry {
  readonly name: string | Buffer;
  /** Uncompressed content. */
  readonly data: Buffer;
  /** 0 = stored, 8 = deflated; any other number is written as is with `data` stored. */
  readonly method?: number;
  readonly flags?: number;
  readonly versionMadeBy?: number;
  readonly externalAttributes?: number;
  /** Forged CRC-32 (central directory and local header). */
  readonly crc32?: number;
  /** Forged uncompressed size. */
  readonly uncompressedSize?: number;
  /** Bytes written as the entry's data instead of `data` (compressed). */
  readonly rawData?: Buffer;
  /** Forged local header offset (central directory only). */
  readonly localHeaderOffset?: number;
}

export interface BuildOptions {
  /** Writes ZIP64 end records (forced past 65 535 entries). */
  readonly zip64?: boolean;
  /** Forged entry count of the end records. */
  readonly entryCount?: number;
  /** Forged central directory offset of the end records. */
  readonly centralDirectoryOffset?: number;
  /** Forged offset of the ZIP64 end record in the ZIP64 locator. */
  readonly zip64RecordOffset?: bigint;
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

export function buildZip(entries: readonly RawEntry[], options: BuildOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf8') : entry.name;
    const method = entry.method ?? 8;
    const body = entry.rawData ?? (method === 8 ? deflateRawSync(entry.data) : entry.data);
    const crc = entry.crc32 ?? crc32(entry.data);
    const size = entry.uncompressedSize ?? entry.data.length;
    const flags = entry.flags ?? UTF8;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0x21),
      u32(crc),
      u32(body.length),
      u32(size),
      u16(name.length),
      u16(0),
      name,
    ]);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(entry.versionMadeBy ?? MADE_BY_UNIX),
        u16(20),
        u16(flags),
        u16(method),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(body.length),
        u32(size),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(entry.externalAttributes ?? UNIX_FILE),
        u32(entry.localHeaderOffset ?? offset),
        name,
      ]),
    );
    parts.push(local, body);
    offset += local.length + body.length;
  }
  const directory = Buffer.concat(central);
  const directoryOffset = options.centralDirectoryOffset ?? offset;
  const count = options.entryCount ?? entries.length;
  const zip64 = options.zip64 === true || count > 0xffff;
  const tail: Buffer[] = [];
  if (zip64) {
    const recordOffset = offset + directory.length;
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
        u64(BigInt(directoryOffset)),
      ]),
      Buffer.concat([
        u32(0x07064b50),
        u32(0),
        u64(options.zip64RecordOffset ?? BigInt(recordOffset)),
        u32(1),
      ]),
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
      u32(zip64 ? 0xffffffff : directoryOffset),
      u16(0),
    ]),
  );
  return Buffer.concat([...parts, directory, ...tail]);
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export const BASE_ID = 'bse_0123456789abcdef';
export const TABLE_ID = 'tbl_0123456789abcdef';
export const FIELD_ID = 'fld_0123456789abcdef';
export const ATT_ID = 'att_0123456789abcdef';

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

/** A manifest for `entries` (their checksums), with `patch` applied. */
export function manifestFor(
  entries: readonly { readonly name: string; readonly data: Buffer }[],
  patch: Record<string, unknown> = {},
): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: 'cellhive-base',
      format_version: 1,
      app_version: '0.1.0',
      exported_at: '2026-11-08T00:00:00.000Z',
      exported_by_email: 'owner@example.com',
      base: { id: BASE_ID, name: 'Sales' },
      counts: ZERO_COUNTS,
      skipped: { personal_views: 0 },
      checksums: Object.fromEntries(entries.map((entry) => [entry.name, sha256(entry.data)])),
      ...patch,
    }),
  );
}

/** A small valid package: manifest, base, one data entry, one file. */
export function validEntries(): { name: string; data: Buffer }[] {
  return [
    {
      name: 'schema/base.json',
      data: Buffer.from(
        JSON.stringify({
          name: 'Sales',
          description: null,
          icon: null,
          settings: {},
          missing_ids: [],
        }),
      ),
    },
    {
      name: `data/${TABLE_ID}.ndjson`,
      data: Buffer.from(
        `${JSON.stringify({
          id: 'rec_0123456789abcdef',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          created_by_email: null,
          updated_by_email: null,
          auto: 1,
          fields: { [FIELD_ID]: 'hello' },
        })}\n`,
      ),
    },
    { name: `files/${ATT_ID}`, data: Buffer.from('file content') },
  ];
}

/** A whole package from entries: the manifest (last) lists their checksums. */
export function packageOf(
  entries: readonly (RawEntry & { readonly name: string })[],
  options: BuildOptions & { readonly manifest?: Record<string, unknown> } = {},
): Buffer {
  return buildZip(
    [...entries, { name: 'manifest.json', data: manifestFor(entries, options.manifest) }],
    options,
  );
}

/** A temporary directory removed by `cleanup`. */
export async function scratch(): Promise<{
  readonly file: (name: string, data: Buffer) => Promise<string>;
  readonly path: (name: string) => string;
  readonly cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'chbase-test-'));
  return {
    file: async (name, data) => {
      const path = join(dir, name);
      await writeFile(path, data);
      return path;
    },
    path: (name) => join(dir, name),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
