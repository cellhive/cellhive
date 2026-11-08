import { createHash } from 'node:crypto';
import { close, fstat, open, read } from 'node:fs';
import { PassThrough, Readable, Transform, type TransformCallback } from 'node:stream';
import { finished } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { AppError } from '../errors/app-error.js';

import {
  ATTACHMENTS_ENTRY,
  classifyEntry,
  isJsonEntry,
  MANIFEST_ENTRY,
  type PackageEntryKind,
} from './entries.js';
import { packageLimitProblem, packageLinePath, packageProblem, PackageProblems } from './errors.js';
import { decodePackageText, parsePackageJson, parsePackageShape } from './json.js';
import {
  DEFAULT_BASE_PACKAGE_LIMITS,
  exceedsEntryRatio,
  maxEntryRatioOf,
  maxUncompressedBytes,
  type BasePackageLimits,
} from './limits.js';
import {
  BASE_PACKAGE_FORMAT,
  BASE_PACKAGE_FORMAT_VERSION,
  packageAttachmentsSchema,
  packageFormatSchema,
  packageManifestSchema,
  type PackageAttachments,
  type PackageManifest,
} from './manifest.js';

import type { z } from 'zod';

/**
 * Reader of an untrusted `.chbase` package (ADR-24, CONTRACTS §12.2,
 * threat model of BACKLOG T1016):
 *
 * - opened from a file (random access to the central directory) through a
 *   bounded reader: every read is checked against the file size before it
 *   reaches `fs`, so a forged offset or size fails the read instead of
 *   throwing inside a yauzl callback, where nothing could catch it;
 * - every yauzl call is wrapped, every emitter has an `error` listener for
 *   its whole life: no package can throw out of the reader or crash the
 *   process — problems are `422 INVALID_PACKAGE` with a detail code and the
 *   entry as `path`;
 * - names are checked before anything is read: `validateFileName` (no `..`,
 *   absolute or drive path, backslash), no control character, no
 *   directory, symlink or other non-file, no encryption, only stored or
 *   deflated data, no two names equal once NFC-normalized; then only the
 *   allowlist of `entries.ts` is accepted and the manifest must list
 *   exactly the other entries;
 * - caps of `limits.ts` on the central directory (entries, declared sizes,
 *   the compression ratio of each entry — 200× for NDJSON, 20× for JSON
 *   and files — and the total) and again while inflating (an entry never
 *   yields more bytes than it declared, CRC-32 and SHA-256 are checked
 *   before its end);
 * - entries are never written to disk by name: callers get parsed values
 *   or a byte stream of one allowed entry.
 */

/** An allowed entry of the package, as the central directory describes it. */
export interface PackageEntryInfo {
  readonly name: string;
  readonly kind: PackageEntryKind;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface OpenBasePackageOptions {
  readonly limits?: BasePackageLimits;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
/** `versionMadeBy` high byte of a Unix host: `externalFileAttributes >>> 16` is a `st_mode`. */
const HOST_UNIX = 3;
const MSDOS_DIRECTORY = 0x10;
const FLAG_ENCRYPTED = 0x1;
const FLAG_STRONG_ENCRYPTION = 0x40;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

function readFailed(message: string): Error {
  return new Error(message);
}

/**
 * Bytes `[start, end)` of an open file, read with positional reads. Unlike
 * `fs.createReadStream`, destroying it never closes the descriptor (yauzl
 * destroys each entry stream after its end; the file stays open for the
 * next entry).
 */
class FileRangeStream extends Readable {
  private position: number;

  constructor(
    private readonly fd: number,
    start: number,
    private readonly end: number,
  ) {
    super();
    this.position = start;
  }

  override _read(size: number): void {
    const length = Math.min(size, this.end - this.position, 64 * 1024);
    if (length <= 0) {
      this.push(null);
      return;
    }
    const buffer = Buffer.allocUnsafe(length);
    try {
      read(this.fd, buffer, 0, length, this.position, (error, bytesRead) => {
        if (error !== null) {
          this.destroy(error);
        } else if (bytesRead === 0) {
          this.destroy(readFailed('unexpected end of file'));
        } else {
          this.position += bytesRead;
          this.push(buffer.subarray(0, bytesRead));
        }
      });
    } catch (error) {
      this.destroy(error instanceof Error ? error : readFailed('read failed'));
    }
  }
}

/**
 * Random access to an open file for yauzl, bounded by the file size: an
 * offset, length or range that is not a safe integer inside the file fails
 * through the callback (asynchronously), never by a throw.
 */
class BoundedFileReader extends yauzl.RandomAccessReader {
  constructor(
    private readonly fd: number,
    private readonly size: number,
  ) {
    super();
  }

  private inBounds(start: number, end: number): boolean {
    return (
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      end >= start &&
      end <= this.size
    );
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null, bytesRead?: number) => void,
  ): void {
    if (
      !this.inBounds(position, position + length) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + length > buffer.length
    ) {
      setImmediate(() => {
        callback(readFailed('read outside the file'));
      });
      return;
    }
    try {
      read(this.fd, buffer, offset, length, position, (error, bytesRead) => {
        callback(error, bytesRead);
      });
    } catch (error) {
      setImmediate(() => {
        callback(error instanceof Error ? error : readFailed('read failed'));
      });
    }
  }

  override _readStreamForRange(start: number, end: number): Readable {
    if (!this.inBounds(start, end) || end === start) {
      const stream = new PassThrough();
      if (end === start && this.inBounds(start, end)) {
        setImmediate(() => stream.end());
      } else {
        setImmediate(() => stream.destroy(readFailed('read outside the file')));
      }
      return stream;
    }
    return new FileRangeStream(this.fd, start, end);
  }

  override close(callback: (err: Error | null) => void): void {
    close(this.fd, (error) => {
      callback(error ?? null);
    });
  }
}

/** `path` of a problem of the whole archive (end of central directory, central directory). */
const ARCHIVE = '';

/**
 * The problem a yauzl or zlib error stands for; its message is never passed
 * on. `declared` is the declared size of the entry being inflated.
 */
function archiveProblem(error: unknown, path: string, declared?: number): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : '';
  const what = path === ARCHIVE ? 'The package' : path;
  if (/strong encryption/u.test(message)) {
    return packageProblem('UNSAFE_ENTRY', path, `${what} is encrypted.`);
  }
  if (/too many bytes in the stream/u.test(message)) {
    return packageLimitProblem(
      path,
      'uncompressed_bytes',
      declared ?? 0,
      `${what} inflates to more bytes than it declares.`,
    );
  }
  return packageProblem('INVALID_ARCHIVE', path, `${what} is not a readable zip.`);
}

function openFd(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      open(path, 'r', (error, fd) => {
        if (error === null) resolve(fd);
        else reject(error);
      });
    } catch (error) {
      reject(error instanceof Error ? error : readFailed('open failed'));
    }
  });
}

function sizeOf(fd: number): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      fstat(fd, (error, stats) => {
        if (error === null) resolve(stats.size);
        else reject(error);
      });
    } catch (error) {
      reject(error instanceof Error ? error : readFailed('stat failed'));
    }
  });
}

function closeFd(fd: number): void {
  try {
    close(fd, () => undefined);
  } catch {
    // Already closed.
  }
}

function openZip(reader: BoundedFileReader, size: number): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    try {
      yauzl.fromRandomAccessReader(
        reader,
        size,
        {
          lazyEntries: true,
          autoClose: false,
          // Names are decoded and checked here, not by yauzl.
          decodeStrings: false,
          validateEntrySizes: true,
          strictFileNames: true,
        },
        (error, zip) => {
          if (error === null) resolve(zip);
          else reject(archiveProblem(error, ARCHIVE));
        },
      );
    } catch (error) {
      reject(archiveProblem(error, ARCHIVE));
    }
  });
}

/** The next entry of the central directory, or `null` after the last one. */
function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(archiveProblem(error, ARCHIVE));
    };
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', onError);
    try {
      zip.readEntry();
    } catch (error) {
      cleanup();
      reject(archiveProblem(error, ARCHIVE));
    }
  });
}

/** The name of an entry, decoded as yauzl would (UTF-8 flag, Unicode path extra field). */
function entryName(entry: Entry): string | null {
  try {
    const raw = entry.fileNameRaw;
    return yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, true);
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

/** Why an entry must not be read, or `null`. */
function unsafeReason(entry: Entry, name: string): string | null {
  if (name === '' || name.length > 255) return 'has an empty or overlong name';
  if (yauzl.validateFileName(name) !== null) return 'has an unsafe path';
  if (CONTROL_CHARACTER.test(name)) return 'has a control character in its name';
  if (name.endsWith('/')) return 'is a directory';
  if ((entry.externalFileAttributes & MSDOS_DIRECTORY) !== 0) return 'is a directory';
  if (entry.versionMadeBy >>> 8 === HOST_UNIX) {
    const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
    if (mode !== 0 && mode !== S_IFREG) return 'is not a regular file';
  }
  if ((entry.generalPurposeBitFlag & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) {
    return 'is encrypted';
  }
  if (entry.compressionMethod !== METHOD_STORED && entry.compressionMethod !== METHOD_DEFLATED) {
    return 'uses an unsupported compression method';
  }
  return null;
}

interface EntryCheck {
  readonly name: string;
  readonly crc32: number;
  readonly size: number;
  readonly sha256: string | null;
}

/**
 * Pass-through of one entry's inflated bytes that stops at the declared
 * size and, before the end, checks the byte count, the CRC-32 of the
 * central directory and the SHA-256 of the manifest.
 */
class EntryVerifier extends Transform {
  private bytes = 0;
  private crc = 0;
  private readonly hash = createHash('sha256');

  constructor(private readonly check: EntryCheck) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.check.size) {
      callback(
        packageLimitProblem(
          this.check.name,
          'uncompressed_bytes',
          this.check.size,
          `${this.check.name} inflates to more bytes than it declares.`,
        ),
      );
      return;
    }
    this.crc = crc32(chunk, this.crc);
    this.hash.update(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    const { name } = this.check;
    if (this.bytes !== this.check.size || this.crc !== this.check.crc32) {
      callback(packageProblem('INVALID_ARCHIVE', name, `${name} is damaged (size or CRC).`));
      return;
    }
    if (this.check.sha256 !== null && this.hash.digest('hex') !== this.check.sha256) {
      callback(packageProblem('CHECKSUM_MISMATCH', name, `${name} does not match its checksum.`));
      return;
    }
    callback();
  }
}

interface ScannedEntry {
  readonly entry: Entry;
  readonly info: PackageEntryInfo;
}

/**
 * Opens and checks a package: central directory, names, caps and the
 * manifest. Throws `INVALID_PACKAGE`; never anything else for a bad
 * package (errors of the file system — the file is missing — pass through).
 */
export async function openBasePackage(
  path: string,
  options: OpenBasePackageOptions = {},
): Promise<BasePackageReader> {
  const limits = options.limits ?? DEFAULT_BASE_PACKAGE_LIMITS;
  const fd = await openFd(path);
  let zip: ZipFile | null = null;
  try {
    const size = await sizeOf(fd);
    if (size > limits.maxPackageBytes) {
      throw packageLimitProblem(
        ARCHIVE,
        'package_bytes',
        limits.maxPackageBytes,
        'The package is larger than allowed.',
      );
    }
    const reader = new BoundedFileReader(fd, size);
    // An emitter without an `error` listener throws; these live as long as the reader.
    reader.on('error', () => undefined);
    zip = await openZip(reader, size);
    zip.on('error', () => undefined);
    const entries = await scanEntries(zip, limits);
    const opened = new BasePackageReader(zip, entries, limits);
    await opened.loadManifest();
    return opened;
  } catch (error) {
    if (zip === null) closeFd(fd);
    else closeZip(zip);
    throw error;
  }
}

function closeZip(zip: ZipFile): void {
  try {
    zip.close();
  } catch {
    // Closing twice or a reader already gone: nothing left to release.
  }
}

async function scanEntries(
  zip: ZipFile,
  limits: BasePackageLimits,
): Promise<ReadonlyMap<string, ScannedEntry>> {
  if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount > limits.maxEntries) {
    throw packageLimitProblem(
      ARCHIVE,
      'entries',
      limits.maxEntries,
      'The package has more entries than allowed.',
    );
  }
  const maxTotal = maxUncompressedBytes(limits);
  const scanned: { name: string; entry: Entry; kind: PackageEntryKind | null }[] = [];
  const normalized = new Set<string>();
  const offsets = new Set<number>();
  let total = 0;
  for (;;) {
    const entry = await nextEntry(zip);
    if (entry === null) break;
    if (scanned.length >= limits.maxEntries) {
      throw packageLimitProblem(
        ARCHIVE,
        'entries',
        limits.maxEntries,
        'The package has more entries than allowed.',
      );
    }
    const name = entryName(entry);
    // Name-level problems point at the entry's place, never echo a hostile name.
    const at = `entries[${String(scanned.length)}]`;
    if (name === null) {
      throw packageProblem('UNSAFE_ENTRY', at, 'An entry has an unreadable name.');
    }
    const unsafe = unsafeReason(entry, name);
    if (unsafe !== null) throw packageProblem('UNSAFE_ENTRY', at, `An entry ${unsafe}.`);
    const key = name.normalize('NFC');
    if (normalized.has(key)) {
      throw packageProblem('DUPLICATE_ENTRY', at, 'Two entries have the same name.');
    }
    normalized.add(key);
    if (offsets.has(entry.relativeOffsetOfLocalHeader)) {
      throw packageProblem('INVALID_ARCHIVE', at, 'Two entries share their data.');
    }
    offsets.add(entry.relativeOffsetOfLocalHeader);
    total += entry.uncompressedSize;
    if (!Number.isSafeInteger(total) || total > maxTotal) {
      throw packageLimitProblem(
        at,
        'uncompressed_bytes',
        maxTotal,
        'The package decompresses to more than allowed.',
      );
    }
    const kind = classifyEntry(name);
    if (exceedsEntryRatio(limits, kind, entry.compressedSize, entry.uncompressedSize)) {
      const ratio = maxEntryRatioOf(limits, kind);
      throw packageLimitProblem(
        kind === null ? at : name,
        'entry_ratio',
        ratio,
        `${kind === null ? 'An entry' : name} compresses more than ${String(ratio)}×.`,
      );
    }
    if (kind !== null && isJsonEntry(kind) && entry.uncompressedSize > limits.maxJsonEntryBytes) {
      throw packageLimitProblem(
        name,
        'json_entry_bytes',
        limits.maxJsonEntryBytes,
        `${name} is larger than a JSON entry may be.`,
      );
    }
    scanned.push({ name, entry, kind });
  }
  const problems = new PackageProblems();
  const entries = new Map<string, ScannedEntry>();
  for (const [index, { name, entry, kind }] of scanned.entries()) {
    if (kind === null) {
      // The name passed the safety checks; it is shown only when plain ASCII.
      const at = /^[\x21-\x7e]{1,100}$/u.test(name) ? name : `entries[${String(index)}]`;
      problems.add('UNKNOWN_ENTRY', at, 'The package has an entry it may not have.');
      continue;
    }
    entries.set(name, {
      entry,
      info: {
        name,
        kind,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
      },
    });
  }
  problems.throwIfAny();
  return entries;
}

/** An opened package; {@link openBasePackage} has checked its structure and manifest. */
export class BasePackageReader {
  private manifestValue: PackageManifest | null = null;
  private closed = false;

  constructor(
    private readonly zip: ZipFile,
    private readonly scanned: ReadonlyMap<string, ScannedEntry>,
    readonly limits: BasePackageLimits,
  ) {}

  /** `manifest.json`, checked against the entries. */
  get manifest(): PackageManifest {
    if (this.manifestValue === null) throw new Error('The manifest is not loaded');
    return this.manifestValue;
  }

  /** Every allowed entry, `manifest.json` included. */
  entries(): PackageEntryInfo[] {
    return [...this.scanned.values()].map((item) => item.info);
  }

  has(name: string): boolean {
    return this.scanned.has(name);
  }

  entry(name: string): PackageEntryInfo | undefined {
    return this.scanned.get(name)?.info;
  }

  /** Reads `manifest.json` (no checksum: it holds them) and checks it against the entries. */
  async loadManifest(): Promise<void> {
    if (!this.scanned.has(MANIFEST_ENTRY)) {
      throw packageProblem('MISSING_ENTRY', MANIFEST_ENTRY, 'The package has no manifest.json.');
    }
    const value = await this.readJsonValue(MANIFEST_ENTRY, null);
    const head = packageFormatSchema.safeParse(value);
    if (
      !head.success ||
      head.data.format !== BASE_PACKAGE_FORMAT ||
      head.data.format_version !== BASE_PACKAGE_FORMAT_VERSION
    ) {
      const version = head.success ? head.data.format_version : undefined;
      throw packageProblem(
        'UNSUPPORTED_FORMAT_VERSION',
        `${MANIFEST_ENTRY}#/format_version`,
        'The package is not a Cellhive base package of a supported format version.',
        {
          supported: BASE_PACKAGE_FORMAT_VERSION,
          ...(Number.isSafeInteger(version) ? { format_version: version } : {}),
        },
      );
    }
    const manifest = parsePackageShape(packageManifestSchema, value, MANIFEST_ENTRY);
    const problems = new PackageProblems();
    for (const name of Object.keys(manifest.checksums)) {
      const pointer = `${MANIFEST_ENTRY}#/checksums/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (name === MANIFEST_ENTRY) {
        problems.add('INVALID_ENTRY', pointer, 'The manifest cannot hold its own checksum.');
      } else if (!this.scanned.has(name)) {
        problems.add('MISSING_ENTRY', pointer, 'An entry the manifest lists is missing.');
      }
    }
    for (const name of this.scanned.keys()) {
      if (name !== MANIFEST_ENTRY && !Object.hasOwn(manifest.checksums, name)) {
        problems.add('UNKNOWN_ENTRY', name, 'The package has an entry its manifest does not list.');
      }
    }
    problems.throwIfAny();
    this.manifestValue = manifest;
  }

  private scannedEntry(name: string): ScannedEntry {
    const found = this.scanned.get(name);
    if (found === undefined) {
      throw packageProblem('MISSING_ENTRY', name, `The package has no ${name}.`);
    }
    return found;
  }

  private openRaw(entry: Entry, name: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(packageProblem('INVALID_ARCHIVE', name, 'The package is closed.'));
        return;
      }
      try {
        this.zip.openReadStream(entry, (error, stream) => {
          if (error === null) resolve(stream);
          else reject(archiveProblem(error, name));
        });
      } catch (error) {
        reject(archiveProblem(error, name));
      }
    });
  }

  /**
   * The inflated bytes of an entry. The stream fails (`INVALID_PACKAGE`)
   * before its end when the bytes exceed or miss the declared size, or the
   * CRC-32 or the manifest's SHA-256 differs: a consumer that saw the end
   * saw the entry the manifest describes.
   */
  async open(name: string): Promise<Readable> {
    return this.openVerified(name, this.manifestValue?.checksums[name] ?? null);
  }

  private async openVerified(name: string, sha256: string | null): Promise<Readable> {
    const { entry } = this.scannedEntry(name);
    const raw = await this.openRaw(entry, name);
    const verifier = new EntryVerifier({
      name,
      crc32: entry.crc32,
      size: entry.uncompressedSize,
      sha256,
    });
    raw.on('error', (error: unknown) => {
      verifier.destroy(archiveProblem(error, name, entry.uncompressedSize));
    });
    verifier.on('close', () => {
      if (!raw.destroyed) raw.destroy();
    });
    raw.pipe(verifier);
    return verifier;
  }

  private async readJsonValue(name: string, sha256: string | null): Promise<unknown> {
    const { info } = this.scannedEntry(name);
    if (info.uncompressedSize > this.limits.maxJsonEntryBytes) {
      throw packageLimitProblem(
        name,
        'json_entry_bytes',
        this.limits.maxJsonEntryBytes,
        `${name} is larger than a JSON entry may be.`,
      );
    }
    const stream = await this.openVerified(name, sha256);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    return parsePackageJson(decodePackageText(Buffer.concat(chunks), name), this.limits, name);
  }

  /** A JSON entry, parsed and checked against `schema` (`INVALID_ENTRY` with pointers). */
  async readJson<S extends z.ZodType>(name: string, schema: S): Promise<z.output<S>> {
    const value = await this.readJsonValue(name, this.manifest.checksums[name] ?? null);
    return parsePackageShape(schema, value, name);
  }

  /** `files/attachments.json`, or no file when the package has none. */
  async readAttachments(): Promise<PackageAttachments> {
    if (!this.has(ATTACHMENTS_ENTRY)) return { files: [] };
    return this.readJson(ATTACHMENTS_ENTRY, packageAttachmentsSchema);
  }

  /**
   * The lines of an NDJSON entry, parsed and checked against `schema`, with
   * their 1-based number. A line is at most `maxNdjsonLineBytes`; blank
   * lines are refused, a final newline is optional.
   */
  async *readNdjson<S extends z.ZodType>(
    name: string,
    schema: S,
  ): AsyncGenerator<{ readonly line: number; readonly value: z.output<S> }, void, undefined> {
    const stream = await this.open(name);
    const max = this.limits.maxNdjsonLineBytes;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let line = 0;
    const parseLine = (bytes: Buffer): z.output<S> => {
      line += 1;
      const at = packageLinePath(name, line);
      if (bytes.length === 0) throw packageProblem('INVALID_ENTRY', at, 'A line is blank.');
      const value = parsePackageJson(decodePackageText(bytes, at), this.limits, at);
      return parsePackageShape(schema, value, at);
    };
    const tooLong = () =>
      packageLimitProblem(
        packageLinePath(name, line + 1),
        'ndjson_line_bytes',
        max,
        `A line of ${name} is longer than allowed.`,
      );
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let start = 0;
        for (;;) {
          const end = chunk.indexOf(0x0a, start);
          if (end === -1) {
            const rest = chunk.subarray(start);
            pendingBytes += rest.length;
            if (pendingBytes > max) throw tooLong();
            if (rest.length > 0) pending.push(rest);
            break;
          }
          const piece = chunk.subarray(start, end);
          if (pendingBytes + piece.length > max) throw tooLong();
          const bytes = pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
          pending = [];
          pendingBytes = 0;
          start = end + 1;
          const value = parseLine(bytes);
          yield { line, value };
        }
      }
      if (pendingBytes > 0) {
        const value = parseLine(Buffer.concat(pending));
        yield { line, value };
      }
    } finally {
      stream.destroy();
    }
  }

  /**
   * Reads every entry once to its end (CRC-32, sizes and SHA-256 of the
   * manifest): the integrity pass of an import, before anything is written.
   */
  async verifyAll(onEntry?: (info: PackageEntryInfo) => void): Promise<void> {
    for (const { info } of this.scanned.values()) {
      if (info.name === MANIFEST_ENTRY) continue;
      const stream = await this.open(info.name);
      stream.resume();
      await finished(stream);
      onEntry?.(info);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeZip(this.zip);
  }
}
