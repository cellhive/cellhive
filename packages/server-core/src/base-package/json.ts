import { invalidPackage, packageLimitProblem, packageProblem } from './errors.js';

import type { BasePackageLimits } from './limits.js';
import type { ProblemErrorItem } from '@cellhive/contracts';
import type { z } from 'zod';

/**
 * Bounded JSON of a package (CONTRACTS §12.2): nesting at most
 * `maxJsonDepth` (checked on the text before parsing, so no recursive walk
 * ever meets a deeper value), no `__proto__` key, and problems that name
 * the place in the package — never a value of it.
 */

const OPEN_BRACE = 0x7b;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACE = 0x7d;
const CLOSE_BRACKET = 0x5d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** Whether the arrays/objects of a JSON text nest deeper than `limit` (strings skipped). */
export function jsonNestsDeeperThan(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (code === BACKSLASH) index += 1;
      else if (code === QUOTE) inString = false;
      continue;
    }
    if (code === QUOTE) inString = true;
    else if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      depth += 1;
      if (depth > limit) return true;
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) depth -= 1;
  }
  return false;
}

class ProtoKeyError extends Error {}

function refuseProtoKey(key: string, value: unknown): unknown {
  if (key === '__proto__') throw new ProtoKeyError();
  return value;
}

/** Parses JSON text of the entry at `path`; `INVALID_PACKAGE` when it is not acceptable JSON. */
export function parsePackageJson(text: string, limits: BasePackageLimits, path: string): unknown {
  if (jsonNestsDeeperThan(text, limits.maxJsonDepth)) {
    throw packageLimitProblem(
      path,
      'json_depth',
      limits.maxJsonDepth,
      `The JSON of ${path} nests deeper than allowed.`,
    );
  }
  try {
    return JSON.parse(text, refuseProtoKey);
  } catch (error) {
    if (error instanceof ProtoKeyError) {
      throw packageProblem('INVALID_ENTRY', path, `${path} has a "__proto__" key.`);
    }
    throw packageProblem('INVALID_ENTRY', path, `${path} is not valid JSON.`);
  }
}

/** UTF-8 bytes → text; `INVALID_ENTRY` on an invalid sequence. */
export function decodePackageText(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw packageProblem('INVALID_ENTRY', path, `${path} is not UTF-8 text.`);
  }
}

/** `#/a/0/b` for a zod issue path (RFC 6901 escapes), `""` for the root. */
function pointerOf(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '';
  return `#/${path
    .map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`;
}

/** Most schema problems listed for one entry. */
const MAX_SCHEMA_PROBLEMS = 20;

/**
 * Validates a parsed value of the entry at `path` (`path` may already name
 * a line, `data/tbl_….ndjson:12`). Problems give the pointer and the zod
 * issue code only, never a value.
 */
export function parsePackageShape<S extends z.ZodType>(
  schema: S,
  value: unknown,
  path: string,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const items: ProblemErrorItem[] = [];
  for (const issue of parsed.error.issues.slice(0, MAX_SCHEMA_PROBLEMS)) {
    const paths =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key])
        : [issue.path];
    for (const where of paths) {
      items.push({
        path: `${path}${pointerOf(where)}`,
        code: 'INVALID_ENTRY',
        message: `${path} does not match the package format (${issue.code}).`,
        params: { issue: issue.code },
      });
    }
  }
  throw invalidPackage(items);
}
