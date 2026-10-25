import { isId, shareFileUrl } from '@cellhive/contracts';

import type { RecordOutput } from '@cellhive/server-core';

/**
 * What a share link knows to rewrite cell values (BACKLOG T409): its token
 * (attachment URLs) and the type of each field of the table, by id and by
 * name (records come keyed either way, `field_key_type`). Formula/lookup
 * fields whose values are linked records (T462) carry the type
 * {@link COMPUTED_RECORDS}.
 */
export interface ShareValueContext {
  readonly token: string;
  readonly types: ReadonlyMap<string, string>;
}

type Json = Record<string, unknown>;

/** Value type of a formula/lookup field with record results (`{ id, title }`, T462). */
export const COMPUTED_RECORDS = 'computed:record';
/** Value type of a formula/lookup field with attachment results: always empty through a link (T462). */
export const COMPUTED_ATTACHMENTS = 'computed:attachment';

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A user object in a cell (`user`, `created_by`, `updated_by`): `{ id: 'usr_…', … }`. */
function isUserValue(value: unknown): value is Json {
  return isObject(value) && isId('usr', value['id']);
}

function withoutEmail(value: Json): Json {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'email'));
}

/** A value with user objects reduced to `{ id, name }` (never an email, CONTRACTS §16A). */
export function redactUsers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => (isUserValue(item) ? withoutEmail(item) : item));
  }
  return isUserValue(value) ? withoutEmail(value) : value;
}

/**
 * A linked record (`link` entry, `parent` value) through a link: its title
 * when the link's creator reads it, else `{ id: null, title: null }` — the
 * id of a record outside the link's reach is never shown (T409).
 */
function lockedRef(value: unknown): unknown {
  if (!isObject(value) || !Object.hasOwn(value, 'title')) return value;
  return value['title'] === null ? { id: null, title: null } : value;
}

/** Attachments through a link: `url` / `thumbnail_url` are the share file routes (T409). */
function sharedFile(token: string, value: unknown): unknown {
  if (!isObject(value) || !isId('att', value['id'])) return value;
  const id = value['id'];
  return {
    ...value,
    url: shareFileUrl(token, id),
    thumbnail_url:
      typeof value['thumbnail_url'] === 'string' ? shareFileUrl(token, id, true) : null,
  };
}

export function sharedValue(
  type: string | undefined,
  value: unknown,
  context: ShareValueContext,
): unknown {
  switch (type) {
    case 'link':
      return Array.isArray(value) ? (value as unknown[]).map(lockedRef) : value;
    case 'parent':
      return lockedRef(value);
    // Formula/lookup records (T462): like link cells, never the id of a record out of reach.
    case COMPUTED_RECORDS:
      return Array.isArray(value) ? (value as unknown[]).map(lockedRef) : lockedRef(value);
    // Files of another table never reach a link (S4b open question #4): empty, as text too.
    case COMPUTED_ATTACHMENTS:
      return typeof value === 'string' ? '' : null;
    case 'attachment':
      return Array.isArray(value)
        ? (value as unknown[]).map((item) => sharedFile(context.token, item))
        : value;
    default:
      return redactUsers(value);
  }
}

/**
 * A record as a share link returns it (CONTRACTS §16A): user values carry
 * `{ id, name }` only; with a context (T409) linked records the creator
 * cannot read are `{ id: null, title: null }` and attachment URLs point at
 * the link's file routes.
 */
export function redactSharedRecord<T extends RecordOutput>(
  record: T,
  context?: ShareValueContext,
): T {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    fields[key] =
      context === undefined
        ? redactUsers(value)
        : sharedValue(context.types.get(key), value, context);
  }
  return { ...record, fields };
}
