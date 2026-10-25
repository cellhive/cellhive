/**
 * What a step returned, read for display (T523; CONTRACTS §21 "Chi tiết":
 * outputs are redacted by the server with the viewer's permissions now — a
 * hidden value is `null`, a `find_records` record outside the read rule has
 * `redacted: true`, a field the viewer cannot read is in `redacted_fields`;
 * other outputs keep ids, codes, numbers and masked addresses only). Pure:
 * no value is ever reconstructed, a `null` the server hid stays hidden.
 */

import { rejectionsOf, type RecipientRejection } from './rejections';

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** One value of a found record: hidden when the viewer may not read it now. */
export interface FoundValue {
  readonly fieldId: string;
  readonly value: unknown;
  readonly hidden: boolean;
}

export interface FoundRecord {
  readonly id: string;
  /** The whole record is out of the viewer's reach (read rule, trash, table). */
  readonly hidden: boolean;
  readonly values: readonly FoundValue[];
}

export interface NotificationSkip {
  readonly userId: string;
  readonly reason: string;
}

export type StepOutputView =
  | { readonly kind: 'record'; readonly recordId: string | null }
  | { readonly kind: 'if'; readonly branch: string | null; readonly result: boolean | null }
  | {
      readonly kind: 'find';
      readonly count: number | null;
      readonly truncated: boolean;
      readonly records: readonly FoundRecord[];
    }
  | {
      readonly kind: 'updateRecords';
      readonly matched: number | null;
      readonly updated: number | null;
      readonly batches: number | null;
      readonly skippedNotEditable: number | null;
      readonly done: boolean;
    }
  | {
      readonly kind: 'delay';
      readonly until: string | null;
      readonly resumedAt: string | null;
      readonly recheck: string | null;
    }
  | {
      readonly kind: 'email';
      readonly mode: string | null;
      readonly accepted: readonly string[];
      readonly rejected: readonly RecipientRejection[];
      readonly attachmentCount: number | null;
      readonly attachmentBytes: number | null;
      readonly inlineImageCount: number | null;
      readonly inlineImageBytes: number | null;
      readonly smtpCode: number | null;
      readonly smtpEnhanced: string | null;
      readonly footer: string | null;
    }
  | {
      readonly kind: 'notification';
      readonly recipients: number | null;
      readonly delivered: number | null;
      readonly turnedOff: number | null;
      readonly summarized: number | null;
      readonly recordId: string | null;
      readonly skipped: readonly NotificationSkip[];
    }
  | { readonly kind: 'other'; readonly entries: readonly (readonly [string, string])[] };

const RECORD_ACTIONS = new Set(['create_record', 'update_record', 'delete_record']);

function foundRecords(value: unknown): FoundRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((record) => {
    const hidden = record['redacted'] === true;
    const redactedFields = new Set(strings(record['redacted_fields']));
    const fields = isObject(record['fields']) ? record['fields'] : {};
    return {
      id: str(record['id']) ?? '',
      hidden,
      values: Object.entries(fields).map(([fieldId, item]) => ({
        fieldId,
        value: item,
        hidden: hidden || (item === null && redactedFields.has(fieldId)),
      })),
    };
  });
}

/** Scalar entries of an output the screen has no dedicated view for (ids, codes, numbers). */
function otherEntries(output: Json): [string, string][] {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(output)) {
    if (key === 'warnings') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      entries.push([key, String(value)]);
    }
  }
  return entries;
}

/**
 * The output of a step of `actionType`, or `null` when there is nothing to
 * show (no output yet, or nothing displayable).
 */
export function stepOutputView(actionType: string | null, output: unknown): StepOutputView | null {
  if (!isObject(output)) return null;
  if (actionType !== null && RECORD_ACTIONS.has(actionType)) {
    return { kind: 'record', recordId: str(output['id']) };
  }
  switch (actionType) {
    case 'if':
      return {
        kind: 'if',
        branch: str(output['branch']),
        result: typeof output['result'] === 'boolean' ? output['result'] : null,
      };
    case 'find_records':
      return {
        kind: 'find',
        count: num(output['count']),
        truncated: output['truncated'] === true,
        records: foundRecords(output['records']),
      };
    case 'update_records':
      return {
        kind: 'updateRecords',
        matched: num(output['matched']),
        updated: num(output['updated']),
        batches: num(output['batches']),
        skippedNotEditable: num(output['skipped_not_editable']),
        done: output['done'] === true,
      };
    case 'delay':
      return {
        kind: 'delay',
        until: str(output['until']),
        resumedAt: str(output['resumed_at']),
        recheck: str(output['recheck']),
      };
    case 'send_email': {
      const recipients = isObject(output['recipients']) ? output['recipients'] : {};
      const smtp = isObject(output['smtp']) ? output['smtp'] : {};
      return {
        kind: 'email',
        mode: str(output['mode']),
        accepted: strings(recipients['accepted']),
        rejected: rejectionsOf(recipients['rejected']),
        attachmentCount: num(output['attachment_count']),
        attachmentBytes: num(output['attachment_bytes']),
        inlineImageCount: num(output['inline_image_count']),
        inlineImageBytes: num(output['inline_image_bytes']),
        smtpCode: num(smtp['code']),
        smtpEnhanced: str(smtp['enhanced']),
        footer: str(output['footer']),
      };
    }
    case 'send_notification': {
      const skipped = Array.isArray(output['skipped']) ? output['skipped'] : [];
      return {
        kind: 'notification',
        recipients: num(output['recipients']),
        delivered: num(output['delivered']),
        turnedOff: num(output['turned_off']),
        summarized: num(output['summarized']),
        recordId: str(output['record_id']),
        skipped: skipped
          .filter(isObject)
          .map((item) => ({
            userId: str(item['user_id']) ?? '',
            reason: str(item['reason']) ?? '',
          }))
          .filter((item) => item.userId !== ''),
      };
    }
    default: {
      const entries = otherEntries(output);
      return entries.length === 0 ? null : { kind: 'other', entries };
    }
  }
}

/** Template warning codes of a step output (`warnings`, CONTRACTS §21 T504). */
export function warningsOf(output: unknown): string[] {
  return isObject(output) ? strings(output['warnings']) : [];
}

/**
 * A found record's value as plain text (`cell_format=json`): text and
 * numbers as they are, lists joined, linked items by their name or id.
 * Formatting by field type is out of scope here (values are a debug view).
 */
export function plainValue(value: unknown, yes: string, no: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? yes : no;
  if (Array.isArray(value)) {
    return value
      .map((item) => plainValue(item, yes, no))
      .filter((item) => item !== '')
      .join(', ');
  }
  if (isObject(value)) {
    const label = str(value['name']) ?? str(value['title']) ?? str(value['id']);
    return label ?? JSON.stringify(value);
  }
  return typeof value === 'bigint' ? value.toString() : '';
}
