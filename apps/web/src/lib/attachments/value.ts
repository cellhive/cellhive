import { ATTACHMENT_URL_PREFIX } from '@cellhive/field-types';

/**
 * A file of an attachment cell as the API reads it (CONTRACTS §2): the
 * `url` checks permissions on every call, then redirects to storage.
 * History entries hold `{ id, name, size, mime }` only (CONTRACTS §20).
 */
export interface CellFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly url: string;
  readonly thumbnail_url: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One file of a cell or history value, or `null` when malformed. */
export function cellFileOf(entry: unknown): CellFile | null {
  if (!isRecord(entry)) return null;
  const { id, name, size, mime, url, thumbnail_url: thumbnail } = entry;
  if (typeof id !== 'string' || id === '') return null;
  return {
    id,
    name: typeof name === 'string' ? name : '',
    size: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0,
    mime: typeof mime === 'string' ? mime.toLowerCase() : '',
    url: typeof url === 'string' && url !== '' ? url : `${ATTACHMENT_URL_PREFIX}${id}`,
    thumbnail_url: typeof thumbnail === 'string' && thumbnail !== '' ? thumbnail : null,
  };
}

/** The files of an attachment value (json read shape), in order; `[]` for an empty cell. */
export function cellFilesOf(value: unknown): CellFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const file = cellFileOf(entry);
    return file === null ? [] : [file];
  });
}

/** The value to write for `files` (`[{ id }]`, CONTRACTS §2), `null` when there is none. */
export function writeValueOf(files: readonly CellFile[]): { id: string }[] | null {
  return files.length === 0 ? null : files.map((file) => ({ id: file.id }));
}

/** The value a cell shows for `files` (read shape), `null` when there is none. */
export function displayValueOf(files: readonly CellFile[]): CellFile[] | null {
  return files.length === 0 ? null : [...files];
}

/** `files` with the one at `from` moved to `to` (drag and drop, move buttons). */
export function moveFile<T>(files: readonly T[], from: number, to: number): T[] {
  const next = [...files];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}
