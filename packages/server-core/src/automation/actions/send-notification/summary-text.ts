import { AUTOMATION_MESSAGE_TITLE_MAX } from '@cellhive/contracts';

import { escapeHeader, truncateText } from '../../values/escape.js';

/**
 * Text of the summary notification that replaces the messages of one
 * automation past the hourly cap of a recipient (BACKLOG T515, ADR-32 §1),
 * in the recipient's language (`en`, `vi`; others fall back to `en`).
 * Stored like any `automation.message` title/body: rendered for this
 * recipient, no record value (the automation name is configuration).
 */
interface SummaryTexts {
  title(count: string, name: string): string;
  body(limit: string): string;
  numberLocale: string;
}

const TEXTS: Readonly<Record<'en' | 'vi', SummaryTexts>> = {
  en: {
    title: (count, name) => `${count} messages from automation «${name}»`,
    body: (limit) =>
      `You received more than ${limit} messages from automations in the past hour: further messages of this automation are counted here.`,
    numberLocale: 'en-US',
  },
  vi: {
    title: (count, name) => `${count} tin từ automation «${name}»`,
    body: (limit) =>
      `Bạn đã nhận hơn ${limit} tin từ automation trong một giờ qua: các tin tiếp theo của automation này được gộp ở đây.`,
    numberLocale: 'vi-VN',
  },
};

function textsOf(locale: string): SummaryTexts {
  return locale.toLowerCase().startsWith('vi') ? TEXTS.vi : TEXTS.en;
}

export function summaryTitle(locale: string, count: number, automationName: string): string {
  const texts = textsOf(locale);
  const formatted = new Intl.NumberFormat(texts.numberLocale).format(count);
  return truncateText(
    texts.title(formatted, escapeHeader(automationName)),
    AUTOMATION_MESSAGE_TITLE_MAX,
  ).text;
}

export function summaryBody(locale: string, limit: number): string {
  const texts = textsOf(locale);
  return texts.body(new Intl.NumberFormat(texts.numberLocale).format(limit));
}
