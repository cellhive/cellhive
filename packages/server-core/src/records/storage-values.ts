import { attachmentRefOf, type ImplementedFieldType } from '@cellhive/field-types';

import type { JsonObject, JsonValue } from '../db/schema.js';

/**
 * Storage-form values (CONTRACTS §8 `changes`, ADR-23 audit `before`/`after`):
 * what `toStorage` of `@cellhive/field-types` produces — option ids, user
 * ids, numbers, ISO instants, `YYYY-MM-DD` dates — as plain JSON. Values read
 * back from PostgreSQL (node-pg shapes: `numeric` as text, `timestamptz` as
 * `Date`) are brought to the same form so a pre-image and a new value compare
 * and serialize alike.
 */

/** The storage-form JSON of a value read from the column of a field of `type`. */
export function storedValueToJson(type: ImplementedFieldType, raw: unknown): JsonValue {
  if (raw === null || raw === undefined) return type === 'checkbox' ? false : null;
  switch (type) {
    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(raw);
      return typeof raw === 'string' && raw.trim() === ''
        ? null
        : Number.isFinite(value)
          ? value + 0
          : null;
    }
    case 'checkbox':
      return raw === true;
    case 'select':
    case 'user': {
      if (!Array.isArray(raw)) return null;
      const items = raw.filter((item): item is string => typeof item === 'string');
      return items.length === 0 ? null : items;
    }
    case 'attachment': {
      // `jsonb` array of `{ id, name, size, mime }` (the cell's display cache).
      if (!Array.isArray(raw)) return null;
      const refs = raw.flatMap((entry: unknown) => {
        const ref = attachmentRefOf(entry);
        return ref === null ? [] : [{ id: ref.id, name: ref.name, size: ref.size, mime: ref.mime }];
      });
      return refs.length === 0 ? null : refs;
    }
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
      return typeof raw === 'string' ? raw : null;
    default:
      return typeof raw === 'string' ? raw : null;
  }
}

/**
 * Normalizes an output of `toStorage` to JSON (an empty list is an empty
 * cell, `-0` is `0`).
 */
export function storageToJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.length === 0 ? null : value.map((item) => storageToJson(item));
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value + 0 : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    // Attachment entries (`{ id, name, size, mime }`).
    const object: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) object[key] = storageToJson(item);
    }
    return object;
  }
  throw new TypeError(`Unexpected storage value of type ${typeof value}`);
}

/** Equality of two storage-form values (arrays are ordered, as stored; objects by key). */
export function sameStoredValue(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((item, index) => sameStoredValue(item, b[index] ?? null))
    );
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameStoredValue(a[key] ?? null, b[key] ?? null))
    );
  }
  return false;
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
