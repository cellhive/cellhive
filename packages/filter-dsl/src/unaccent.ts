import { UNACCENT_RULES } from './unaccent-rules.js';

let table: ReadonlyMap<string, string> | null = null;

/**
 * The rules by character, decoded once from the runs of
 * `unaccent-rules.ts` (format there): `*` repeats the replacement over the
 * run, `+` steps it with the code point.
 */
export function unaccentRules(): ReadonlyMap<string, string> {
  if (table === null) {
    const map = new Map<string, string>();
    let code = 0;
    for (const line of UNACCENT_RULES.split('\n')) {
      const tab = line.indexOf('\t');
      const head = line.slice(0, tab);
      const to = line.slice(tab + 1);
      const kind = head.search(/[*+]/u);
      code += parseInt(kind === -1 ? head : head.slice(0, kind), 36);
      const length = kind === -1 ? 1 : parseInt(head.slice(kind + 1), 36);
      const step = head[kind] === '+' ? (to.codePointAt(0) ?? 0) : null;
      for (let offset = 0; offset < length; offset += 1) {
        map.set(
          String.fromCodePoint(code + offset),
          step === null ? to : String.fromCodePoint(step + offset),
        );
      }
    }
    table = map;
  }
  return table;
}

/**
 * PostgreSQL `unaccent` with the default `unaccent.rules` dictionary, i.e.
 * `meta.f_unaccent` (SPEC §5.2): every code point that has a rule is replaced
 * (combining marks are deleted, `đ` → `d`, `Æ` → `AE`, `％` → `%`…); anything
 * else is copied unchanged. The rules are generated from PostgreSQL 18 and
 * checked against the database by the equivalence harness.
 */
export function unaccent(text: string): string {
  const map = unaccentRules();
  let out = '';
  for (const char of text) out += map.get(char) ?? char;
  return out;
}

/**
 * `meta.f_unaccent(lower(text))`: the form text filters compare
 * (unaccented, case-insensitive; SPEC §6.2). `toLowerCase` is the Unicode
 * default full lowercase mapping, which is what PostgreSQL `lower()` does
 * under an ICU collation (CONTRACTS base collations are ICU).
 */
export function foldText(text: string): string {
  return unaccent(text.toLowerCase());
}
