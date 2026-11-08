import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { deflateRawSync } from 'node:zlib';

import { ZipFile } from 'yazl';

import { classifyEntry, isJsonEntry, isNdjsonEntry, MANIFEST_ENTRY } from './entries.js';
import { packageLimitProblem, packageTooLarge } from './errors.js';
import { jsonNestsDeeperThan } from './json.js';
import {
  DEFAULT_BASE_PACKAGE_LIMITS,
  deflateStaysWithinRatio,
  exceedsEntryRatio,
  maxEntryRatioOf,
  maxUncompressedBytes,
  type BasePackageLimits,
} from './limits.js';
import {
  BASE_PACKAGE_FORMAT,
  BASE_PACKAGE_FORMAT_VERSION,
  type PackageManifest,
} from './manifest.js';

/**
 * Streaming writer of a `.chbase` package (ADR-24 §1, CONTRACTS §12.2):
 * entries go out one after another through `yazl` (ZIP64 when needed) into
 * a file — the export spools it to a temporary file, then stores it with
 * its exact length. JSON and NDJSON entries are deflated (a JSON entry that
 * would deflate past its ratio is stored); files already compressed
 * (images, PDF, archives, Office documents…) are stored. The
 * SHA-256 of every entry is computed while it is written and
 * `manifest.json`, holding them all, is written last.
 *
 * The caps of the reader apply here too (`BASE_PACKAGE_MAX_BYTES`, a JSON
 * entry, an NDJSON line, JSON nesting, the compression ratio of each entry
 * and the uncompressed total), so an export never produces a package an
 * import refuses: over `BASE_PACKAGE_MAX_BYTES` the writer fails with
 * `VALIDATION_FAILED` `PACKAGE_TOO_LARGE`, over another cap with
 * `INVALID_PACKAGE` `ARCHIVE_LIMIT_EXCEEDED`.
 */

export interface BasePackageWriterOptions {
  readonly limits?: BasePackageLimits;
  /** Modification time of every entry (default: now); the export uses `exported_at`. */
  readonly mtime?: Date;
}

/** `manifest.json` without its `checksums` (the writer adds them) or format keys. */
export type BasePackageManifestInput = Omit<
  PackageManifest,
  'format' | 'format_version' | 'checksums'
>;

export interface WrittenEntry {
  readonly name: string;
  readonly sha256: string;
  /** Uncompressed bytes. */
  readonly size: number;
}

export interface FinishedPackage {
  /** Bytes of the package file. */
  readonly bytes: number;
  readonly checksums: Readonly<Record<string, string>>;
  readonly manifest: PackageManifest;
}

/** Regular file, `rw-r--r--`. */
const FILE_MODE = 0o100644;

class PackageWriteError extends Error {}

/** Hashes and counts the bytes of one entry on their way into yazl. */
class EntryHasher extends Transform {
  bytes = 0;
  private readonly hash = createHash('sha256');

  constructor(private readonly onChunk?: (chunk: Buffer) => Error | null) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const problem = this.onChunk?.(chunk) ?? null;
    if (problem !== null) {
      callback(problem);
      return;
    }
    this.bytes += chunk.length;
    this.hash.update(chunk);
    callback(null, chunk);
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}

/** Counts the bytes of the package on their way to the file and stops past the cap. */
class SizeLimiter extends Transform {
  bytes = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(packageTooLarge(this.limit));
      return;
    }
    callback(null, chunk);
  }
}

export class BasePackageWriter {
  private readonly zip = new ZipFile();
  private readonly limiter: SizeLimiter;
  private readonly file: WriteStream;
  private readonly checksums = new Map<string, string>();
  private readonly closed: Promise<void>;
  private failure: Error | null = null;
  private failed!: (error: Error) => void;
  private readonly failedPromise: Promise<never>;
  private busy = false;
  private finished = false;
  private uncompressed = 0;
  /** Entries of `zip.entries` whose ratio was checked. */
  private ratiosChecked = 0;

  private constructor(
    path: string,
    readonly limits: BasePackageLimits,
    private readonly mtime: Date,
  ) {
    this.limiter = new SizeLimiter(limits.maxPackageBytes);
    this.failedPromise = new Promise<never>((_resolve, reject) => {
      this.failed = reject;
    });
    // Each step races with this promise; nobody may be waiting when it rejects.
    this.failedPromise.catch(() => undefined);
    // `wx`: the caller's temporary path must be new — never overwrite a file.
    this.file = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    this.closed = new Promise<void>((resolve, reject) => {
      this.file.on('close', resolve);
      this.file.on('error', reject);
    });
    this.closed.catch(() => undefined);
    const fail = (error: unknown) => {
      this.fail(error);
    };
    this.zip.on('error', fail);
    this.zip.outputStream.on('error', fail);
    this.limiter.on('error', fail);
    this.file.on('error', fail);
    this.zip.outputStream.pipe(this.limiter).pipe(this.file);
  }

  /** A writer into a new file at `path` (created with `wx`, mode `0600`). */
  static async create(
    path: string,
    options: BasePackageWriterOptions = {},
  ): Promise<BasePackageWriter> {
    const writer = new BasePackageWriter(
      path,
      options.limits ?? DEFAULT_BASE_PACKAGE_LIMITS,
      options.mtime ?? new Date(),
    );
    await Promise.race([once(writer.file, 'open'), writer.failedPromise]);
    return writer;
  }

  private fail(error: unknown): void {
    if (this.failure !== null) return;
    this.failure =
      error instanceof Error ? error : new PackageWriteError('The package could not be written');
    this.failed(this.failure);
    this.zip.outputStream.destroy();
    this.limiter.destroy();
    this.file.destroy();
  }

  /**
   * The reader's ratio per entry (200× NDJSON, 20× JSON and files) for the
   * entries whose compressed data is complete; yazl knows a compressed
   * size once the entry's data is written.
   */
  private checkRatios(): void {
    const entries = this.zip.entries;
    while (this.ratiosChecked < entries.length) {
      const entry = entries[this.ratiosChecked];
      if (entry?.compressedSize == null || entry.uncompressedSize == null) return;
      this.ratiosChecked += 1;
      const name = entry.utf8FileName.toString('utf8');
      const kind = classifyEntry(name);
      if (exceedsEntryRatio(this.limits, kind, entry.compressedSize, entry.uncompressedSize)) {
        const ratio = maxEntryRatioOf(this.limits, kind);
        throw packageLimitProblem(
          name,
          'entry_ratio',
          ratio,
          `${name} compresses more than ${String(ratio)}×.`,
        );
      }
    }
  }

  private begin(name: string): void {
    if (this.failure !== null) throw this.failure;
    this.checkRatios();
    if (this.finished) throw new PackageWriteError('The package is finished');
    if (this.busy) throw new PackageWriteError('One entry at a time');
    if (this.checksums.has(name)) throw new PackageWriteError(`Entry written twice: ${name}`);
    const kind = classifyEntry(name);
    if (kind === null) throw new PackageWriteError(`Not an entry of a package: ${name}`);
    // `manifest.json` comes last and counts too.
    const entries = this.checksums.size + (name === MANIFEST_ENTRY ? 1 : 2);
    if (entries > this.limits.maxEntries) {
      throw packageLimitProblem(
        '',
        'entries',
        this.limits.maxEntries,
        'The base has more objects than a package may hold.',
      );
    }
    this.busy = true;
  }

  private async pump(name: string, source: Readable, compress: boolean, hasher: EntryHasher) {
    source.on('error', (error: unknown) => {
      hasher.destroy(error instanceof Error ? error : new PackageWriteError('Source failed'));
    });
    hasher.on('error', (error: unknown) => {
      this.fail(error);
    });
    const done = new Promise<void>((resolve) => {
      hasher.on('end', resolve);
    });
    this.zip.addReadStream(source.pipe(hasher), name, {
      mtime: this.mtime,
      mode: FILE_MODE,
      compress,
    });
    try {
      await Promise.race([done, this.failedPromise]);
    } finally {
      this.busy = false;
    }
    const written: WrittenEntry = { name, sha256: hasher.digest(), size: hasher.bytes };
    this.checksums.set(name, written.sha256);
    this.uncompressed += written.size;
    this.checkTotal();
    return written;
  }

  private jsonText(name: string, value: unknown): string {
    const text = JSON.stringify(value);
    if (jsonNestsDeeperThan(text, this.limits.maxJsonDepth)) {
      throw packageLimitProblem(
        name,
        'json_depth',
        this.limits.maxJsonDepth,
        `${name} nests deeper than allowed.`,
      );
    }
    return text;
  }

  /** A JSON entry (`schema/*.json`, `files/attachments.json`), deflated. */
  async addJson(name: string, value: unknown): Promise<WrittenEntry> {
    const kind = classifyEntry(name);
    if (kind === null || !isJsonEntry(kind) || kind.kind === 'manifest') {
      throw new PackageWriteError(`Not a JSON entry: ${name}`);
    }
    return this.writeJson(name, value);
  }

  private async writeJson(name: string, value: unknown): Promise<WrittenEntry> {
    this.begin(name);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(this.jsonText(name, value), 'utf8');
      if (bytes.length > this.limits.maxJsonEntryBytes) {
        throw packageLimitProblem(
          name,
          'json_entry_bytes',
          this.limits.maxJsonEntryBytes,
          `${name} is larger than a JSON entry may be.`,
        );
      }
    } catch (error) {
      this.busy = false;
      throw error;
    }
    // Deflated unless that would pass the ratio a reader allows (repetitive
    // schema): then stored, which any reader takes.
    const compress = deflateStaysWithinRatio(
      this.limits,
      classifyEntry(name),
      deflateRawSync(bytes, { level: 6 }).length,
      bytes.length,
    );
    return this.pump(name, Readable.from([bytes]), compress, new EntryHasher());
  }

  /**
   * An NDJSON entry (`data/<tbl>.ndjson`, `links/<fld>.ndjson`): one JSON
   * value per line, deflated, read from `rows` as they come.
   */
  async addNdjson(
    name: string,
    rows: Iterable<unknown> | AsyncIterable<unknown>,
  ): Promise<WrittenEntry & { readonly lines: number }> {
    const kind = classifyEntry(name);
    if (kind === null || !isNdjsonEntry(kind)) {
      throw new PackageWriteError(`Not an NDJSON entry: ${name}`);
    }
    this.begin(name);
    let lines = 0;
    const lineOf = (row: unknown): Buffer => {
      const line = Buffer.from(`${this.jsonText(name, row)}\n`, 'utf8');
      if (line.length - 1 > this.limits.maxNdjsonLineBytes) {
        throw packageLimitProblem(
          `${name}:${String(lines + 1)}`,
          'ndjson_line_bytes',
          this.limits.maxNdjsonLineBytes,
          `A line of ${name} is longer than allowed.`,
        );
      }
      lines += 1;
      return line;
    };
    async function* encode(): AsyncGenerator<Buffer> {
      for await (const row of rows) yield lineOf(row);
    }
    const written = await this.pump(name, Readable.from(encode()), true, new EntryHasher());
    return { ...written, lines };
  }

  /**
   * A file (`files/<att>`), streamed from `source`: stored when `compress`
   * is `false` (already compressed media, `isAlreadyCompressed`), else
   * deflated. `size`, when given, must be the exact byte count.
   */
  async addFile(
    name: string,
    source: Readable,
    options: { readonly compress: boolean; readonly size?: number },
  ): Promise<WrittenEntry> {
    const kind = classifyEntry(name);
    if (kind?.kind !== 'file') throw new PackageWriteError(`Not a file entry: ${name}`);
    this.begin(name);
    const written = await this.pump(name, source, options.compress, new EntryHasher());
    if (options.size !== undefined && written.size !== options.size) {
      const error = new PackageWriteError(`File size differs from its metadata: ${name}`);
      this.fail(error);
      throw error;
    }
    return written;
  }

  /** Entries written so far → SHA-256. */
  checksumsSoFar(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.checksums);
  }

  /**
   * Writes `manifest.json` with the checksums of every entry, the central
   * directory, and closes the file. Resolves once the file is complete.
   */
  async finish(input: BasePackageManifestInput): Promise<FinishedPackage> {
    const manifest: PackageManifest = {
      format: BASE_PACKAGE_FORMAT,
      format_version: BASE_PACKAGE_FORMAT_VERSION,
      ...input,
      checksums: Object.fromEntries([...this.checksums].sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    await this.writeJson(MANIFEST_ENTRY, manifest);
    this.checksums.delete(MANIFEST_ENTRY);
    this.finished = true;
    this.zip.end();
    await Promise.race([this.closed, this.failedPromise]);
    if (this.failure !== null) throw this.failure;
    // The reader's caps on each entry and on the whole package: never hand
    // out a package an import refuses.
    this.checkRatios();
    this.checkTotal();
    return { bytes: this.limiter.bytes, checksums: manifest.checksums, manifest };
  }

  /** All entries together inflate to at most 4 × `BASE_PACKAGE_MAX_BYTES`. */
  private checkTotal(): void {
    const limit = maxUncompressedBytes(this.limits);
    if (this.uncompressed > limit) {
      throw packageLimitProblem(
        '',
        'uncompressed_bytes',
        limit,
        'The base inflates to more than a package may.',
      );
    }
  }

  /** Stops writing (the caller removes the file); later calls fail. */
  abort(): void {
    this.fail(new PackageWriteError('The package was aborted'));
  }
}
