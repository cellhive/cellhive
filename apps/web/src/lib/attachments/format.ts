/**
 * File sizes in the user's language (FRONTEND §9.1 numbers through `Intl`):
 * "412 KB", "3,3 MB" in Vietnamese, "3.3 MB" in English; binary units
 * (1 MB = 1 048 576 bytes, the unit of `ATTACHMENT_MAX_FILE_BYTES`).
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

function scaled(bytes: number): { value: number; unit: (typeof UNITS)[number] } {
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  return { value, unit: UNITS[index] ?? 'B' };
}

/** `1536` → "1,5 KB" (`vi`) / "1.5 KB" (`en`); under 10 of a unit keeps one decimal. */
export function formatBytes(bytes: number, locale: string): string {
  const { value, unit } = scaled(bytes);
  const digits = unit === 'B' || value >= 10 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  return `${number} ${unit}`;
}

/**
 * Progress of an upload in the unit of the whole file: "2,1 / 3,3 MB"
 * (board S4), so both numbers read alike.
 */
export function formatProgress(loaded: number, total: number, locale: string): string {
  const { unit } = scaled(total);
  const power = UNITS.indexOf(unit);
  const divisor = 1024 ** power;
  const digits = unit === 'B' || total / divisor >= 10 ? 0 : 1;
  const format = new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
  return `${format.format(Math.min(loaded, total) / divisor)} / ${format.format(total / divisor)} ${unit}`;
}
