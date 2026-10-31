import { splitTemplate } from '@cellhive/formula-engine/template/split';

import { webhookReferenceExpression, webhookReferenceOf } from '../triggers/webhook/model';

import type { AutomationValue } from '@cellhive/contracts';

/**
 * Values of action configs (SPEC §11.4, CONTRACTS §21) as the builder edits
 * them (T521): a literal, one source shown as a chip (a field of the trigger
 * record, trigger data, the output of an earlier step), or a template —
 * text with `{{ … }}` placeholders stored with ids (`{{ [fld_…] }}`) and
 * shown as chips with current names (board "S5 · Automation builder").
 */

export type ValueKind = 'literal' | 'field' | 'step' | 'trigger' | 'template' | 'digest';

export function valueKind(value: AutomationValue): ValueKind {
  if ('literal' in value) return 'literal';
  if ('field' in value) return 'field';
  if ('step' in value) return 'step';
  if ('trigger' in value) return 'trigger';
  if ('template' in value) return 'template';
  return 'digest';
}

/** One part of a template: literal text or a placeholder (`expression` stored with ids). */
export type TemplateSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'ref'; readonly expression: string };

/**
 * The parts of a stored template, with the scanner of the server
 * (`splitTemplate`, escapes `\{` and `\\` resolved). A `{{` left open stays
 * text, as the server reads it.
 */
export function templateSegments(template: string): TemplateSegment[] {
  const out: TemplateSegment[] = [];
  for (const part of splitTemplate(template).parts) {
    if (part.kind === 'text') {
      const last = out.at(-1);
      if (last?.kind === 'text')
        out[out.length - 1] = { kind: 'text', text: last.text + part.text };
      else out.push({ kind: 'text', text: part.text });
    } else {
      out.push({ kind: 'ref', expression: part.expression });
    }
  }
  return out;
}

/** Literal text as template source: `{` and `\` escaped so that it never opens a placeholder. */
export function escapeTemplateText(text: string): string {
  return text.replace(/[\\{]/gu, (char) => `\\${char}`);
}

/** The stored template of segments (one space inside the braces, the canonical form). */
export function templateOf(segments: readonly TemplateSegment[]): string {
  return segments
    .map((segment) =>
      segment.kind === 'text' ? escapeTemplateText(segment.text) : `{{ ${segment.expression} }}`,
    )
    .join('');
}

/**
 * What a placeholder refers to when it is a plain reference the builder
 * names itself (chips without asking the server):
 * - `field`: `[fld_…]`, a field of the trigger record;
 * - `record`: `[@id]`, `[@url]` of the trigger record;
 * - `trigger`: `[@fired_at]`, `[@due_at]`, `[@clicked_by]`, `[@clicked_at]`;
 * - `step`: `[act_…]` (its record's title) or `[act_…].[fld_…]` / `[act_…].[@url]`.
 * Anything else is an expression, named by `validate-template`.
 */
export type TemplateReference =
  | { readonly kind: 'field'; readonly fieldId: string }
  | { readonly kind: 'record'; readonly ref: string }
  | { readonly kind: 'trigger'; readonly ref: string }
  | {
      readonly kind: 'step';
      readonly step: string;
      readonly fieldId: string | null;
      readonly ref: string | null;
    }
  | { readonly kind: 'previous'; readonly fieldId: string }
  /** (T612) `[@body.<path>]`, `[@headers.<name>]`, `[@query.<path>]` of `webhook.received`. */
  | {
      readonly kind: 'webhook';
      readonly part: 'body' | 'headers' | 'query';
      readonly pathText: string;
    };

const RECORD_REFS = new Set(['@id', '@url']);
const ID = String.raw`fld_[0-9A-Za-z]+|@[a-z_]{1,32}|act_[0-9A-Za-z_]{1,32}`;
const REFERENCE = new RegExp(String.raw`^\[(${ID})\](?:\.\[(${ID})\])?$`, 'u');

export function templateReference(expression: string): TemplateReference | null {
  const webhook = webhookReferenceOf(expression);
  if (webhook !== null) return { kind: 'webhook', ...webhook };
  const match = REFERENCE.exec(expression.trim());
  if (match === null) return null;
  const [, first = '', second] = match;
  if (first === '@previous') {
    return second?.startsWith('fld_') === true ? { kind: 'previous', fieldId: second } : null;
  }
  if (first.startsWith('act_')) {
    if (second === undefined) return { kind: 'step', step: first, fieldId: null, ref: null };
    if (second.startsWith('fld_')) return { kind: 'step', step: first, fieldId: second, ref: null };
    return RECORD_REFS.has(second)
      ? { kind: 'step', step: first, fieldId: null, ref: second }
      : null;
  }
  if (second !== undefined) return null;
  if (first.startsWith('fld_')) return { kind: 'field', fieldId: first };
  return RECORD_REFS.has(first) ? { kind: 'record', ref: first } : { kind: 'trigger', ref: first };
}

/** The expression of a chip for a reference (what the "+" menu inserts). */
export function referenceExpression(reference: TemplateReference): string {
  switch (reference.kind) {
    case 'field':
      return `[${reference.fieldId}]`;
    case 'record':
    case 'trigger':
      return `[${reference.ref}]`;
    case 'previous':
      return `[@previous].[${reference.fieldId}]`;
    case 'webhook':
      return webhookReferenceExpression(reference.part, reference.pathText);
    case 'step': {
      const inner = reference.fieldId ?? reference.ref;
      return inner === null ? `[${reference.step}]` : `[${reference.step}].[${inner}]`;
    }
  }
}

/** Placeholders of a template that are not plain references (need the server's names). */
export function hasExpressions(template: string): boolean {
  return templateSegments(template).some(
    (segment) => segment.kind === 'ref' && templateReference(segment.expression) === null,
  );
}

const EVENT_TRIGGERS: ReadonlySet<string> = new Set([
  'record.created',
  'record.updated',
  'record.deleted',
  'record.matches',
  'form.submitted',
]);

/** Trigger data each trigger type gives in templates (`[@…]`; CONTRACTS §21). */
export function triggerDataOf(type: string): readonly string[] {
  switch (type) {
    case 'record.date_reached':
      return ['fired_at', 'due_at'];
    case 'button.clicked':
      return ['fired_at', 'clicked_by', 'clicked_at'];
    default:
      // `[@actor]`: who caused the event (T521b).
      return EVENT_TRIGGERS.has(type) ? ['fired_at', 'actor'] : ['fired_at'];
  }
}

/**
 * Trigger data a whole value may be (`{ "trigger": … }`, CONTRACTS §21 —
 * narrower than templates: record triggers have no `fired_at` there).
 */
export function triggerValuePartsOf(type: string): readonly string[] {
  switch (type) {
    case 'schedule':
      return ['fired_at'];
    case 'record.date_reached':
      return ['due_at'];
    case 'button.clicked':
      return ['clicked_by', 'clicked_at'];
    default:
      return EVENT_TRIGGERS.has(type) ? ['actor'] : [];
  }
}

/** Outputs of a step usable as a single value (`{ step, path }`), by action type (CONTRACTS §21). */
export function stepPathsOf(type: string): readonly string[] {
  switch (type) {
    case 'create_record':
    case 'update_record':
      return ['id'];
    case 'find_records':
      return ['records[0].id', 'count'];
    // T911 (CONTRACTS §29.6).
    case 'ai_generate_text':
      return ['text'];
    case 'ai_classify':
      return ['option_id', 'option_name'];
    default:
      return [];
  }
}

/** Whether a value is still to be filled (the save check names it). */
export function isEmptyValue(value: AutomationValue | undefined): boolean {
  if (value === undefined) return true;
  if ('literal' in value) {
    const literal = value.literal;
    return (
      literal === null ||
      (typeof literal === 'string' && literal.trim() === '') ||
      (Array.isArray(literal) && literal.length === 0)
    );
  }
  if ('template' in value) return value.template.trim() === '';
  return false;
}
