import { createReadStream } from 'node:fs';
import { TextDecoder } from 'node:util';

import type { ImportEncoding } from '@cellhive/contracts';

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/** Whether `bytes` starts with the UTF-8 byte order mark. */
export function startsWithUtf8Bom(bytes: Uint8Array): boolean {
  return UTF8_BOM.every((byte, index) => bytes[index] === byte);
}

/**
 * Detects the encoding of a CSV file (SPEC §17), reading it as a stream:
 * a UTF-8 BOM → `utf-8-bom`; otherwise the whole file is checked as UTF-8
 * (a strict decoder, chunk by chunk, so a sequence split between chunks is
 * fine) → `utf-8`; any invalid sequence → `windows-1258`, the legacy
 * Vietnamese Windows code page. Every byte string is valid Windows-1258, so
 * the detection never fails.
 */
export async function detectFileEncoding(path: string): Promise<ImportEncoding> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let first = true;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
      const bytes = chunk as Buffer;
      if (first) {
        first = false;
        if (startsWithUtf8Bom(bytes)) return 'utf-8-bom';
      }
      decoder.decode(bytes, { stream: true });
    }
    decoder.decode();
    return 'utf-8';
  } catch (error) {
    if (error instanceof TypeError) return 'windows-1258';
    throw error;
  }
}

/** Detects the encoding of bytes held in memory (tests, small samples). */
export function detectEncoding(bytes: Uint8Array): ImportEncoding {
  if (startsWithUtf8Bom(bytes)) return 'utf-8-bom';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'windows-1258';
  }
}

/**
 * A streaming decoder for `encoding`. A BOM at the start is dropped. Invalid
 * sequences become U+FFFD (a user may force `utf-8` on another encoding).
 * Windows-1258 writes Vietnamese tones as combining marks; cells are
 * normalised to NFC by the parser, so `Tiềng` and `Tiếng` compare equal.
 */
export function createTextDecoder(encoding: ImportEncoding): TextDecoder {
  return encoding === 'windows-1258'
    ? new TextDecoder('windows-1258')
    : new TextDecoder('utf-8', { ignoreBOM: false });
}
