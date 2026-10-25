import { isId, type AutomationValue, type EmailRecipientValue, type Id } from '@cellhive/contracts';

import type { TemplateWarning } from '../../values/evaluator.js';

/**
 * Recipients of `send_email` (BACKLOG T514, ADR-32 §3): each value of
 * `to`/`cc`/`bcc` resolves (as `run_as`) to addresses and Cellhive users.
 * Strings are split on `,`, `;` and white space; `usr_…` ids and `{ id }`
 * objects (cells of `user` fields, `clicked_by`) are users, which become
 * their account email only while they are active members of the
 * organization. Addresses are validated one by one later (`Mailer.send`,
 * `normalizeRecipients`); nothing is joined into a header.
 */

/** What one recipient value stands for. */
export interface RecipientParts {
  readonly addresses: string[];
  readonly userIds: Id<'usr'>[];
}

/** Most items read from one value (a list cell, a step output). */
const MAX_ITEMS_PER_VALUE = 1_000;

const SEPARATORS = /[,;\s]+/u;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Addresses and users found in a resolved value (strings, lists, `{ id }` / `{ email }` objects). */
export function recipientPartsOf(value: unknown): RecipientParts {
  const parts: RecipientParts = { addresses: [], userIds: [] };
  let seen = 0;
  const visit = (item: unknown, depth: number): void => {
    if (seen >= MAX_ITEMS_PER_VALUE || item === null || item === undefined) return;
    if (typeof item === 'string') {
      for (const piece of item.split(SEPARATORS)) {
        if (piece === '' || seen >= MAX_ITEMS_PER_VALUE) continue;
        seen += 1;
        if (isId('usr', piece)) parts.userIds.push(piece);
        else parts.addresses.push(piece);
      }
      return;
    }
    if (depth > 2) return;
    if (Array.isArray(item)) {
      for (const element of item as unknown[]) visit(element, depth + 1);
      return;
    }
    if (isObject(item)) {
      const id = item['id'];
      if (typeof id === 'string' && isId('usr', id)) {
        seen += 1;
        parts.userIds.push(id);
      } else if (typeof item['email'] === 'string') {
        visit(item['email'], depth + 1);
      }
    }
  };
  visit(value, 0);
  return parts;
}

/** Resolves one value of the config (the evaluator of the run, or of the preview). */
export type RecipientValueResolver = (
  value: AutomationValue,
) => Promise<{ readonly value: unknown; readonly warnings: readonly TemplateWarning[] }>;

/** The addresses and users of `to`, `cc`, `bcc` (in that order), with the render warnings. */
export async function collectRecipients(
  lists: {
    readonly to: readonly EmailRecipientValue[];
    readonly cc: readonly EmailRecipientValue[];
    readonly bcc: readonly EmailRecipientValue[];
  },
  resolve: RecipientValueResolver,
): Promise<{
  readonly to: RecipientParts;
  readonly cc: RecipientParts;
  readonly bcc: RecipientParts;
  readonly warnings: TemplateWarning[];
}> {
  const warnings: TemplateWarning[] = [];
  const list = async (values: readonly EmailRecipientValue[]): Promise<RecipientParts> => {
    const parts: RecipientParts = { addresses: [], userIds: [] };
    for (const value of values) {
      const resolved =
        'literal' in value ? { value: value.literal, warnings: [] } : await resolve(value);
      warnings.push(...resolved.warnings);
      const found = recipientPartsOf(resolved.value);
      parts.addresses.push(...found.addresses);
      parts.userIds.push(...found.userIds);
    }
    return parts;
  };
  return {
    to: await list(lists.to),
    cc: await list(lists.cc),
    bcc: await list(lists.bcc),
    warnings,
  };
}

/** The user ids a value names (Reply-To from a `user` field or `clicked_by`). */
export function userIdsOf(value: unknown): Id<'usr'>[] {
  return recipientPartsOf(value).userIds;
}
