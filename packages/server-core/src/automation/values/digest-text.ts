import { mailLocaleOf, type MailLocale } from '../../mail/templates.js';

/**
 * The line a `digest` adds past `max_rows` (SPEC §11.4): "… and N more
 * records" in the organization locale (`en` source, `vi` complete).
 */
const MORE_RECORDS: Readonly<Record<MailLocale, (count: number, formatted: string) => string>> = {
  en: (count, formatted) => `… and ${formatted} more ${count === 1 ? 'record' : 'records'}`,
  vi: (_count, formatted) => `… và ${formatted} record khác`,
};

export function moreRecordsLine(count: number, locale: string): string {
  const language = mailLocaleOf(locale);
  return MORE_RECORDS[language](count, new Intl.NumberFormat(language).format(count));
}
