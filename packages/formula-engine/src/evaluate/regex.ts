/**
 * Regular expressions of REGEXMATCH/REGEXEXTRACT/REGEXREPLACE in the TS
 * evaluator (BACKLOG S4b open question #7, `fx.regex_*` of T454): patterns
 * of at most 500 characters (longer or invalid → `null`), applied to the
 * first 10,000 characters of the text; JavaScript syntax with the `u` flag
 * (character semantics, like PostgreSQL). Stored values always come from
 * PostgreSQL; only the syntax both engines share is portable.
 */
export const MAX_REGEX_PATTERN_LENGTH = 500;
export const MAX_REGEX_INPUT_LENGTH = 10_000;

const CACHE_LIMIT = 100;
const cache = new Map<string, RegExp | null>();

/** Code points; the UTF-16 length is an upper bound, so count only when it matters. */
function length(text: string, limit: number): number {
  return text.length <= limit ? text.length : Array.from(text).length;
}

/** The compiled pattern (`global` for REGEXREPLACE), or `null` when too long or invalid. */
export function compileRegex(pattern: string, global: boolean): RegExp | null {
  const key = `${global ? 'g' : '-'}${pattern}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  if (length(pattern, MAX_REGEX_PATTERN_LENGTH) <= MAX_REGEX_PATTERN_LENGTH) {
    try {
      compiled = new RegExp(pattern, global ? 'gu' : 'u');
    } catch {
      compiled = null;
    }
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

/** The part of a text a pattern runs on: its first 10,000 characters (`left(t, 10000)`). */
export function regexInput(text: string): string {
  if (length(text, MAX_REGEX_INPUT_LENGTH) <= MAX_REGEX_INPUT_LENGTH) return text;
  return Array.from(text).slice(0, MAX_REGEX_INPUT_LENGTH).join('');
}

/**
 * REGEXREPLACE's replacement as PostgreSQL `regexp_replace` reads it:
 * `\1`…`\9` insert a group (empty when it did not match), `\&` the whole
 * match, `\\` a backslash; any other backslash stays as is.
 */
export function replacementOf(replacement: string): (match: string, ...rest: unknown[]) => string {
  return (match, ...rest) => {
    // `rest` is the groups, then the offset (a number), the input and maybe named groups.
    const end = rest.findIndex((item) => typeof item === 'number');
    const groups = end === -1 ? rest : rest.slice(0, end);
    let out = '';
    for (let index = 0; index < replacement.length; index += 1) {
      const char = replacement[index] as string;
      const next = replacement[index + 1];
      if (char !== '\\' || next === undefined) {
        out += char;
        continue;
      }
      if (next >= '1' && next <= '9') {
        const group = groups[Number(next) - 1];
        out += typeof group === 'string' ? group : '';
        index += 1;
      } else if (next === '&') {
        out += match;
        index += 1;
      } else if (next === '\\') {
        out += '\\';
        index += 1;
      } else {
        out += char;
      }
    }
    return out;
  };
}
