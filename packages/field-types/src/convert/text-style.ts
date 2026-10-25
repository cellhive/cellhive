import { isEmail } from '../types/user.js';

import type { TextStyle } from '../types/text.js';

/** Separators people put inside phone numbers: spaces, dots, dashes, brackets. */
const PHONE_SEPARATORS = /[\s().-]/gu;
/** E.164 allows at most 15 digits; shorter than 6 is not a callable number. */
const PHONE = /^\+?\d{6,15}$/;

/** Whether `value` reads as a phone number: optional `+`, 6–15 digits, common separators. */
export function isPhoneNumber(value: string): boolean {
  return PHONE.test(value.trim().replace(PHONE_SEPARATORS, ''));
}

/** Styles whose values are checked for their format (SPEC §5.5 item 5). */
export const VALIDATED_TEXT_STYLES = ['email', 'phone'] as const satisfies readonly TextStyle[];

export type ValidatedTextStyle = (typeof VALIDATED_TEXT_STYLES)[number];

export function isValidatedTextStyle(style: TextStyle): style is ValidatedTextStyle {
  return (VALIDATED_TEXT_STYLES as readonly string[]).includes(style);
}

/**
 * Whether a stored `text` value does not match its style (SPEC §5.5 item 5):
 * `email` and `phone` only; empty cells and other styles never do. The value
 * is kept as it is either way (never rewritten or refused): grid, record
 * panel and `convert-preview` (`invalid`) only flag it.
 */
export function isInvalidForTextStyle(value: string | null, style: TextStyle): boolean {
  if (value === null || value.trim() === '') return false;
  switch (style) {
    case 'email':
      return !isEmail(value.trim());
    case 'phone':
      return !isPhoneNumber(value);
    default:
      return false;
  }
}
