interface Separators {
  readonly group: string;
  readonly decimal: string;
}

const separatorCache = new Map<string, Separators>();

function separators(locale: string): Separators {
  let found = separatorCache.get(locale);
  if (found === undefined) {
    const parts = new Intl.NumberFormat(locale, { numberingSystem: 'latn' }).formatToParts(
      1234567.8,
    );
    found = {
      group: parts.find((part) => part.type === 'group')?.value ?? ',',
      decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    };
    separatorCache.set(locale, found);
  }
  return found;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const patternCache = new Map<string, { grouped: RegExp; ungrouped: RegExp }>();

/** Grouped/ungrouped number patterns of a separator pair (built once: bulk conversions). */
function numberPatterns(group: string, decimal: string): { grouped: RegExp; ungrouped: RegExp } {
  const key = `${group}|${decimal}`;
  let found = patternCache.get(key);
  if (found === undefined) {
    const g = escapeRegExp(group);
    const d = escapeRegExp(decimal);
    found = {
      grouped: new RegExp(`^\\d{1,3}(?:${g}\\d{3})+(?:${d}\\d+)?$`),
      ungrouped: new RegExp(`^(?:\\d+(?:${d}\\d+)?|${d}\\d+)$`),
    };
    patternCache.set(key, found);
  }
  return found;
}

/**
 * Prefixes/suffixes tolerated around a number: `%`, a currency sign (`₫`,
 * `$`, `US$`), an ISO 4217 code (`VND`) or the Vietnamese `đ`/`VNĐ`.
 */
const CURRENCY_AFFIX = /^(?:\p{Sc}|[A-Z]{1,3}\p{Sc}|\p{Sc}[A-Z]{1,3}|[A-Z]{3}|VNĐ|đ|Đ)$/u;
const PREFIX = /^[^\d.,]*/u;
const SUFFIX = /[^\d]*$/u;
const JS_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parses a number typed by a person in `locale` (CONTRACTS §2 typecast):
 * `"1.500.000"` → 1500000 and `"1,5"` → 1.5 for `vi`, `"1,500.25"` for
 * `en-US`, `"20%"` → 0.2, currency signs/codes are ignored. Grouping must be
 * well formed (`1.5` in `vi` is read as the plain decimal 1.5). Returns
 * `null` when the text is not a number.
 */
export function parseLocaleNumber(input: string, locale: string): number | null {
  return parseLocaleNumberExact(input, locale)?.value ?? null;
}

/**
 * Significant digits and decimal exponent of a decimal text (`1.50` and
 * `15e-1` give the same key), `0` for zero.
 */
function decimalKey(text: string): string {
  const [mantissa = '', exponent = '0'] = text.toLowerCase().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const digits = `${whole}${fraction}`;
  const first = digits.search(/[1-9]/);
  if (first === -1) return '0';
  const significant = digits.slice(first).replace(/0+$/, '');
  return `${significant}e${String(Number(exponent) + whole.length - first - 1)}`;
}

/**
 * {@link parseLocaleNumber} that also tells whether the number is the exact
 * value of the text: `false` when the text has more significant digits than a
 * double holds (`12345678901234567890` becomes `12345678901234567000`).
 */
export function parseLocaleNumberExact(
  input: string,
  locale: string,
): { readonly value: number; readonly exact: boolean } | null {
  let text = input.trim();
  let negative = false;
  if (text.startsWith('-') || text.startsWith('+')) {
    negative = text.startsWith('-');
    text = text.slice(1).trimStart();
  }

  const prefix = PREFIX.exec(text)?.[0] ?? '';
  const suffix = SUFFIX.exec(text.slice(prefix.length))?.[0] ?? '';
  let body = text.slice(prefix.length, text.length - suffix.length);
  let percent = false;
  for (const affix of [prefix.trim(), suffix.trim()]) {
    if (affix === '') continue;
    if (affix === '%' && !percent) percent = true;
    else if (!CURRENCY_AFFIX.test(affix)) return null;
  }
  if (body === '') return null;

  const { decimal } = separators(locale);
  let { group } = separators(locale);
  if (/^\s$/u.test(group)) body = body.replace(/\s/gu, '');
  if (/\s/u.test(body)) return null;
  // ICU uses `'` for de-CH grouping while people usually type `’`.
  if (group === "'" || group === '’') {
    group = "'";
    body = body.replace(/’/g, "'");
  }

  const { grouped, ungrouped } = numberPatterns(group, decimal);

  let normalized: string;
  if (grouped.test(body) || ungrouped.test(body)) {
    normalized = body.split(group).join('').replace(decimal, '.');
  } else if (JS_NUMBER.test(body)) {
    normalized = body;
  } else {
    return null;
  }

  // Shift the decimal point in the text so that "20.5%" is exactly 0.205.
  const decimalText = percent ? `${normalized}e-2` : normalized;
  const value = Number(decimalText);
  if (!Number.isFinite(value)) return null;
  // `toExponential()` gives the shortest digits that identify the double.
  const exact = decimalKey(decimalText) === decimalKey(value.toExponential());
  return { value: negative && value !== 0 ? -value : value, exact };
}
