import { placedActions } from './draft';

import type { AutomationDefinition } from '@cellhive/contracts';

/**
 * Problems of a draft, from the client check before saving or from `422
 * AUTOMATION_INVALID` (CONTRACTS §21: `errors[].path` under `definition.`),
 * tied to the card they belong to (board "S5 · Automation builder - action":
 * summary on top, red border on the step, "go to the first error").
 */

/** Card of the flow an issue belongs to: the trigger, the condition, an action id, or the whole. */
export type StepKey = 'trigger' | 'condition' | 'general' | `act_${string}`;

export interface BuilderIssue {
  readonly step: StepKey;
  /** Path below the step (`config.fields.fld_…`, `table_id`, `items[0].field`); `''` = the step. */
  readonly path: string;
  readonly code: string;
  readonly params?: Readonly<Record<string, unknown>> | undefined;
  /** English message of the server, used when the code has no translation. */
  readonly message?: string | undefined;
}

/** `definition.actions[2].config.then[0].config.table_id` → `["actions", 2, "config", …]`. */
export function splitPath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/u.exec(part);
    if (match === null) {
      out.push(part);
      continue;
    }
    if (match[1] !== undefined && match[1] !== '') out.push(match[1]);
    for (const index of (match[2] ?? '').matchAll(/\[(\d+)\]/gu)) out.push(Number(index[1]));
  }
  return out;
}

function joinPath(parts: readonly (string | number)[]): string {
  let out = '';
  for (const part of parts) {
    if (typeof part === 'number') out += `[${String(part)}]`;
    else out += out === '' ? part : `.${part}`;
  }
  return out;
}

/**
 * The card and inner path of a server path. Indices are those of the
 * definition that was sent (the draft, unchanged since).
 */
export function locateIssue(
  definition: Pick<AutomationDefinition, 'actions'>,
  path: string,
): { step: StepKey; path: string } {
  const parts = splitPath(path);
  if (parts[0] === 'definition') parts.shift();
  const [head, index] = parts;
  if (head === 'trigger') return { step: 'trigger', path: joinPath(parts.slice(1)) };
  if (head === 'condition') return { step: 'condition', path: joinPath(parts.slice(1)) };
  if (head !== 'actions' || typeof index !== 'number') return { step: 'general', path };
  const top = definition.actions[index];
  if (top === undefined) return { step: 'general', path };
  const rest = parts.slice(2);
  if (
    top.type === 'if' &&
    rest[0] === 'config' &&
    (rest[1] === 'then' || rest[1] === 'else') &&
    typeof rest[2] === 'number'
  ) {
    const child = top.config[rest[1]][rest[2]];
    if (child !== undefined) return { step: child.id as StepKey, path: joinPath(rest.slice(3)) };
  }
  return { step: top.id as StepKey, path: joinPath(rest) };
}

export interface ProblemItem {
  readonly path: string;
  readonly code: string;
  readonly message?: string | undefined;
  readonly params?: Readonly<Record<string, unknown>> | undefined;
}

/** `errors[]` of `422 AUTOMATION_INVALID` / `VALIDATION_FAILED` as builder issues. */
export function issuesFromProblem(
  definition: Pick<AutomationDefinition, 'actions'>,
  errors: readonly ProblemItem[],
): BuilderIssue[] {
  return errors.map((error) => {
    const located =
      error.path === 'name'
        ? { step: 'general' as const, path: 'name' }
        : locateIssue(definition, error.path);
    return { ...located, code: error.code, params: error.params, message: error.message };
  });
}

/** Issues of one card. */
export function issuesOf(issues: readonly BuilderIssue[], step: StepKey): BuilderIssue[] {
  return issues.filter((issue) => issue.step === step);
}

/** Issues of a card at or below `path` (`config.fields.fld_x` matches `config.fields.fld_x.literal`). */
export function issuesAt(
  issues: readonly BuilderIssue[],
  step: StepKey,
  path: string,
): BuilderIssue[] {
  return issues.filter(
    (issue) =>
      issue.step === step &&
      (issue.path === path ||
        issue.path.startsWith(`${path}.`) ||
        issue.path.startsWith(`${path}[`)),
  );
}

/** Flow order of the cards, for "go to the first error". */
export function stepOrder(definition: Pick<AutomationDefinition, 'actions'>): StepKey[] {
  return [
    'general',
    'trigger',
    'condition',
    ...placedActions(definition).map(({ action }) => action.id as StepKey),
  ];
}

/** The first card (in flow order) with an issue. */
export function firstIssueStep(
  definition: Pick<AutomationDefinition, 'actions'>,
  issues: readonly BuilderIssue[],
): StepKey | null {
  const steps = new Set(issues.map((issue) => issue.step));
  return stepOrder(definition).find((step) => steps.has(step)) ?? null;
}
