import { UNACCENT_RULES } from './unaccent-rules.js';

let table: ReadonlyMap<string, string> | null = null;

function rules(): ReadonlyMap<string, string> {
  if (table === null) {
    const map = new Map<string, string>();
    for (const line of UNACCENT_RULES.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab === -1) map.set(line, '');
      else map.set(line.slice(0, tab), line.slice(tab + 1));
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
  const map = rules();
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
