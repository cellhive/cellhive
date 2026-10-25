import {
  ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS,
  ATTACHMENT_DEFAULT_MAX_FILES,
  ATTACHMENT_EXTENSION_MIME_TYPES,
  attachmentThumbnailUrl,
  isId,
} from '@cellhive/contracts';
import { z } from 'zod';

import {
  FieldValueError,
  type AttachmentRef,
  type FieldTypeDefinition,
  type ValidationResult,
  type ValueIssue,
} from '../core.js';
import { assertValid, cast, describe, invalid, issue, OK } from '../internal/results.js';

/** Most files one cell may hold, whatever `max_files` says (BACKLOG T406). */
export const ATTACHMENT_MAX_FILES_PER_CELL = 100;
/** Most entries of `accept`. */
export const ATTACHMENT_MAX_ACCEPT_ENTRIES = 50;
/** `url` of an attachment in reads: the API checks permissions, then redirects (CONTRACTS §2). */
export const ATTACHMENT_URL_PREFIX = '/api/v1/files/';

const TOKEN = '[a-z0-9][a-z0-9!#$&^_.+-]{0,126}';
/** `type/subtype` (RFC 6838 restricted names, lower case), no parameters. */
export const MIME_TYPE_PATTERN = new RegExp(`^${TOKEN}/${TOKEN}$`);
/** An `accept` entry: a MIME type or `type/*`. */
export const MIME_PATTERN_PATTERN = new RegExp(`^${TOKEN}/(?:\\*|${TOKEN})$`);

/**
 * The essence of a MIME type (`Image/PNG; charset=x` → `image/png`), or
 * `null` when it is not a valid `type/subtype`.
 */
export function normalizeMimeType(value: string): string | null {
  const essence = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return MIME_TYPE_PATTERN.test(essence) ? essence : null;
}

/** Whether `mime` (normalized) matches the field's `accept` list (`null`/empty = any type). */
export function mimeAccepted(mime: string, accept: readonly string[] | null | undefined): boolean {
  if (accept === null || accept === undefined || accept.length === 0) return true;
  const [type] = mime.split('/', 1);
  return accept.some((pattern) =>
    pattern.endsWith('/*') ? pattern === `${type ?? ''}/*` : pattern === mime,
  );
}

/** Most entries of `blocked_extensions`. */
export const ATTACHMENT_MAX_BLOCKED_EXTENSIONS = 100;

/** Extension of a file name, lower case, trailing dots and spaces ignored (`"a.EXE. "` → `exe`). */
export function fileExtensionOf(filename: string): string {
  const name = filename.replace(/[.\s]+$/u, '');
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Whether a file name or (normalized) MIME type is blocked by a field's
 * `blocked_extensions` (BACKLOG S4 decision #6): its extension is listed, or
 * its MIME type belongs to a listed extension (`ATTACHMENT_EXTENSION_MIME_TYPES`).
 */
export function isBlockedFileType(
  filename: string,
  mime: string,
  blocked: readonly string[],
): boolean {
  if (blocked.length === 0) return false;
  if (blocked.includes(fileExtensionOf(filename))) return true;
  return blocked.some((extension) =>
    (ATTACHMENT_EXTENSION_MIME_TYPES[extension] ?? []).includes(mime),
  );
}

export const attachmentOptionsSchema = z.strictObject({
  /** MIME whitelist: `type/subtype` or `type/*`; `null` = every type (SPEC §14.2). */
  accept: z
    .array(z.string().trim().toLowerCase().regex(MIME_PATTERN_PATTERN))
    .max(ATTACHMENT_MAX_ACCEPT_ENTRIES)
    .nullable()
    .default(null)
    .transform((list) => (list === null ? null : [...new Set(list)])),
  max_files: z
    .int()
    .min(1)
    .max(ATTACHMENT_MAX_FILES_PER_CELL)
    .default(ATTACHMENT_DEFAULT_MAX_FILES),
  /**
   * File extensions refused at upload (lower case, without the dot; a
   * leading dot is dropped). Default: executables; `[]` blocks nothing
   * (BACKLOG S4 decision #6).
   */
  blocked_extensions: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^\.?[a-z0-9]{1,16}$/)
        .transform((extension) => extension.replace(/^\./, '')),
    )
    .max(ATTACHMENT_MAX_BLOCKED_EXTENSIONS)
    .default([...ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS])
    .transform((list) => [...new Set(list)]),
});

export type AttachmentOptions = z.output<typeof attachmentOptionsSchema>;

/** One entry of a json write: `{ id }` (other keys, e.g. `name` of a read, are ignored). */
export interface AttachmentInput {
  readonly id: string;
}

/** Json read shape (CONTRACTS §2). */
export interface AttachmentValue extends AttachmentRef {
  readonly url: string;
  readonly thumbnail_url: string | null;
}

function entryIssue(entry: unknown): ValueIssue | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || !('id' in entry)) {
    return issue('EXPECTED_ATTACHMENT', `Expected { id }, got ${describe(entry)}`);
  }
  return isId('att', entry.id)
    ? null
    : issue('EXPECTED_ATTACHMENT', 'Expected an attachment id of the form att_<16 base62>');
}

function validateAttachments(value: unknown, options: AttachmentOptions): ValidationResult {
  if (value === null) return OK;
  if (!Array.isArray(value)) {
    return invalid(
      issue('EXPECTED_ARRAY', `Expected an array of attachments, got ${describe(value)}`),
    );
  }
  const issues = value.map(entryIssue).filter((found): found is ValueIssue => found !== null);
  if (issues.length > 0) return invalid(...issues);
  const distinct = new Set(value.map((entry: AttachmentInput) => entry.id));
  if (distinct.size > options.max_files) {
    return invalid(
      issue('TOO_MANY_VALUES', `At most ${String(options.max_files)} files`, {
        max: options.max_files,
      }),
    );
  }
  return OK;
}

function typecastEntry(item: unknown): unknown {
  return typeof item === 'string' ? { id: item.trim() } : item;
}

/** A stored entry (`{ id, name, size, mime }` in the `jsonb` column), or `null` when malformed. */
export function attachmentRefOf(entry: unknown): AttachmentRef | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const { id, name, size, mime } = entry as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof mime !== 'string') return null;
  const bytes = typeof size === 'number' ? size : Number(size);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  return { id, name, size: bytes, mime };
}

/** Ids of a write value or stored cell, in order, without duplicates. */
export function attachmentIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.flatMap((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string'
      ? [entry.id]
      : [],
  );
  return [...new Set(ids)];
}

/**
 * `attachment` (SPEC §5.5, §16): a `jsonb` array of `{ id, name, size,
 * mime }`, a display cache of `meta.attachments` (the source of truth).
 * Writes take `[{ id: "att_…" }]` from the upload flow; `toStorage` looks the
 * ids up through `StorageContext.resolveAttachment`. Only `is_empty` /
 * `is_not_empty` filter it (SPEC §6.2); it is never sorted or grouped.
 */
export const attachmentFieldType: FieldTypeDefinition<
  AttachmentOptions,
  AttachmentInput[] | null,
  AttachmentRef[] | null,
  AttachmentValue[] | null
> = {
  type: 'attachment',
  readOnly: false,
  supportsDefaultValue: false,
  systemColumn: null,
  optionsSchema: attachmentOptionsSchema,
  pgType: () => 'jsonb',
  validate: (value, options) => validateAttachments(value, options),
  typecast(input, options) {
    if (input === null || input === undefined || input === '') return cast(null);
    let entries: unknown[];
    if (typeof input === 'string') {
      entries = input
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map(typecastEntry);
    } else if (Array.isArray(input)) entries = input.map(typecastEntry);
    else if (typeof input === 'object') entries = [input];
    else {
      return invalid(issue('EXPECTED_ATTACHMENT', `Cannot read ${describe(input)} as attachments`));
    }
    const result = validateAttachments(entries, options);
    if (!result.ok) return result;
    return cast(entries.length === 0 ? null : (entries as AttachmentInput[]));
  },
  toStorage(value, options, ctx) {
    assertValid(validateAttachments(value, options));
    const refs = attachmentIdsOf(value).map((id) => {
      const ref = ctx?.resolveAttachment?.(id);
      if (ref === undefined) {
        throw new FieldValueError([
          issue('ATTACHMENT_NOT_FOUND', 'No usable attachment with this id', { id }),
        ]);
      }
      return { id: ref.id, name: ref.name, size: ref.size, mime: ref.mime };
    });
    return refs.length === 0 ? null : refs;
  },
  fromStorage(stored) {
    if (!Array.isArray(stored)) return null;
    const values = stored
      .map(attachmentRefOf)
      .filter((ref): ref is AttachmentRef => ref !== null)
      .map((ref) => ({
        ...ref,
        url: `${ATTACHMENT_URL_PREFIX}${ref.id}`,
        // Raster images (T407): the endpoint answers once the worker rendered them.
        thumbnail_url: attachmentThumbnailUrl(ref.id, ref.mime, ref.size),
      }));
    return values.length === 0 ? null : values;
  },
  formatText: (value) => (value ?? []).map((file) => file.name).join(', '),
  filterOperators: () => ['is_empty', 'is_not_empty'],
};
