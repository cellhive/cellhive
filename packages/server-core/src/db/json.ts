import { sql, type RawBuilder } from 'kysely';

import type { JsonValue } from './schema.js';

/**
 * A `jsonb` parameter for any JSON value. Needed for arrays and primitives:
 * `pg` would send a JS array as a PostgreSQL array literal. The value is
 * always a bound parameter, never inlined into the SQL text.
 */
export function jsonb<T extends JsonValue>(value: T): RawBuilder<T> {
  return sql<T>`cast(${JSON.stringify(value)} as jsonb)`;
}

/**
 * Characters PostgreSQL `jsonb` refuses: NUL (`\u0000`) and a lone UTF-16
 * surrogate (JSON.stringify writes it as an escape `jsonb` rejects). In `u`
 * mode a surrogate range matches only a surrogate that is not in a pair.
 */
// eslint-disable-next-line no-control-regex -- NUL is exactly what jsonb refuses.
const NOT_STORABLE_IN_JSONB = /[\u0000\ud800-\udfff]/gu;

/** `text` with every character `jsonb` refuses replaced by U+FFFD. */
export function storableJsonText(text: string): string {
  return text.replace(NOT_STORABLE_IN_JSONB, '�');
}

type Container = JsonValue[] | Record<string, JsonValue>;

/**
 * A copy of a JSON value from an untrusted source (the response of another
 * server — QA S5c) that `jsonb` accepts: every string and key goes through
 * {@link storableJsonText}. Iterative, so no nesting depth can overflow the
 * stack; a key that collides after the replacement keeps the last value.
 */
export function storableJsonValue(value: JsonValue): JsonValue {
  const copy = (item: JsonValue): JsonValue | Container => {
    if (typeof item === 'string') return storableJsonText(item);
    if (Array.isArray(item)) return [];
    if (item !== null && typeof item === 'object') return {};
    return item;
  };
  const root = copy(value);
  const stack: { source: JsonValue; target: JsonValue | Container }[] = [
    { source: value, target: root },
  ];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const { source, target } = next;
    if (Array.isArray(source) && Array.isArray(target)) {
      for (const child of source) {
        const fixed = copy(child);
        target.push(fixed);
        stack.push({ source: child, target: fixed });
      }
    } else if (
      source !== null &&
      typeof source === 'object' &&
      !Array.isArray(source) &&
      target !== null &&
      typeof target === 'object' &&
      !Array.isArray(target)
    ) {
      for (const [key, child] of Object.entries(source)) {
        const fixed = copy(child);
        // `defineProperty`: a key such as `__proto__` stays a plain own key.
        Object.defineProperty(target, storableJsonText(key), {
          value: fixed,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        stack.push({ source: child, target: fixed });
      }
    }
  }
  return root;
}
