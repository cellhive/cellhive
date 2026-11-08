/**
 * The part of `yazl` (MIT, a zip writer by the author of `yauzl`) the
 * package writer uses. Declared here rather than adding `@types/yazl`, so
 * `yazl` stays the only new dependency (BACKLOG S9).
 */
declare module 'yazl' {
  import type { EventEmitter } from 'node:events';
  import type { Readable } from 'node:stream';

  export interface EntryOptions {
    mtime?: Date;
    mode?: number;
    compress?: boolean;
    compressionLevel?: number;
    forceZip64Format?: boolean;
    forceDosTimestamp?: boolean;
    fileComment?: string | Buffer;
    size?: number;
  }

  export interface EndOptions {
    forceZip64Format?: boolean;
    comment?: string | Buffer;
  }

  /** An entry of the archive; its sizes are known once its data is written. */
  export interface Entry {
    readonly utf8FileName: Buffer;
    readonly compressedSize: number | null;
    readonly uncompressedSize: number | null;
  }

  export class ZipFile extends EventEmitter {
    readonly outputStream: Readable;
    /** Every entry added, in order. */
    readonly entries: readonly Entry[];
    addReadStream(readStream: Readable, metadataPath: string, options?: EntryOptions): void;
    addBuffer(buffer: Buffer, metadataPath: string, options?: EntryOptions): void;
    addEmptyDirectory(metadataPath: string, options?: Pick<EntryOptions, 'mtime' | 'mode'>): void;
    end(options?: EndOptions, calculatedTotalSizeCallback?: (totalSize: number) => void): void;
  }
}
