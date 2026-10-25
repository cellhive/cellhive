import {
  BUTTON_DISABLED_REASONS,
  MAX_BUTTON_COLOR,
  type ButtonCell,
  type ButtonConfirm,
  type ButtonDisabledReason,
  type ButtonFieldSummary,
  type FieldDto,
} from '@cellhive/contracts';

/**
 * Button cells on the client (T525, SPEC §5.5, ADR-32 §2, CONTRACTS §2).
 * Pure and small: the grid draws buttons on share pages too (`pnpm size`).
 * Clicks are `clicks.ts`; the builder's reader check is in the builder.
 */

/** Options of a `button` field as the client reads them, plus its automation summary. */
export interface ButtonColumn {
  readonly label: string;
  /** Index of the label palette (light background, FRONTEND §9.3); wraps modulo 8. */
  readonly color: number;
  readonly confirm: ButtonConfirm | null;
  /** From the field endpoints only (T517): the attached automation, `undefined` elsewhere. */
  readonly summary: ButtonFieldSummary | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `confirm` of the options as the server stores it; anything else is no confirmation. */
function confirmOf(value: unknown): ButtonConfirm | null {
  if (typeof value !== 'object' || value === null) return null;
  const confirm = value as Record<string, unknown>;
  const title = text(confirm['title'])?.trim();
  const label = text(confirm['confirm_label'])?.trim();
  if (title === undefined || title === '' || label === undefined || label === '') return null;
  return { title, message: text(confirm['message']) ?? '', confirm_label: label };
}

/**
 * The button options of a field, `undefined` for other types; unreadable
 * keys take the defaults of CONTRACTS §2 (`label` "Run", color 0, no
 * confirmation). Read by hand, not with the zod schema: share pages draw
 * buttons and keep zod out of their first load (T422, FRONTEND §11.1).
 */
export function buttonColumnOf(
  field: Pick<FieldDto, 'type' | 'options' | 'button'>,
): ButtonColumn | undefined {
  if (field.type !== 'button') return undefined;
  const options = field.options as Readonly<Record<string, unknown>>;
  const label = text(options['label'])?.trim();
  const color = options['color'];
  return {
    label: label === undefined || label === '' ? 'Run' : label,
    color:
      typeof color === 'number' &&
      Number.isInteger(color) &&
      color >= 0 &&
      color <= MAX_BUTTON_COLOR
        ? color
        : 0,
    confirm: confirmOf(options['confirm']),
    summary: field.button ?? undefined,
  };
}

/** What a button cell shows: the server's state, or `running` while a click of the user runs. */
export type ButtonView =
  | { readonly state: 'ready' }
  | { readonly state: 'running' }
  | { readonly state: 'disabled'; readonly reason: ButtonDisabledReason };

export const REASONS: ReadonlySet<string> = new Set(BUTTON_DISABLED_REASONS);

/**
 * The cell value (`{ state, reason }`, CONTRACTS §2) as shown. Anything
 * else (no value yet, an old cache) is disabled: a click is never sent for
 * a state the server did not give.
 */
export function buttonViewOf(value: unknown, running = false): ButtonView {
  if (running) return { state: 'running' };
  if (typeof value === 'object' && value !== null) {
    const cell = value as Partial<ButtonCell>;
    if (cell.state === 'ready') return { state: 'ready' };
    if (cell.state === 'disabled' && typeof cell.reason === 'string' && REASONS.has(cell.reason)) {
      return { state: 'disabled', reason: cell.reason };
    }
  }
  return { state: 'disabled', reason: 'permission' };
}

/** Key of a cell in the running set. */
export function buttonKey(recordId: string, fieldId: string): string {
  return `${recordId}|${fieldId}`;
}
