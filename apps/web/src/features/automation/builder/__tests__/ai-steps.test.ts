import { automationDefinitionSchema } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { pickerSections } from '../components/values/sections';
import { checkDraft } from '../model/check';
import { ACTION_MENU, AI_ACTION_TYPES, newAction, type TableId } from '../model/draft';
import { chipNameOf, scopeOf, templateTextSteps } from '../model/scope';

import type { AutomationAction, AutomationDefinition, FieldDto } from '@cellhive/contracts';
import type { TFunction } from 'i18next';

/**
 * T915: the AI steps of the builder (CONTRACTS §29.6) — new steps, the
 * save check, `[act_…]` of an earlier `ai_generate_text` as "Step N · AI
 * text" (chips, the "+" menu, `text_steps` of `validate-template`).
 */

const TICKETS = 'tbl_Tickets000000001' as TableId;
const SEVERITY = 'fld_Severity00000001' as const;
const context = {
  now: new Date('2026-11-01T00:00:00Z'),
  conditions: new Map(),
  orgTimeZone: 'UTC',
};

function definitionWith(
  actions: AutomationAction[],
  trigger: AutomationDefinition['trigger'] = {
    type: 'record.created',
    table_id: TICKETS,
    skip_bulk: false,
  },
): AutomationDefinition {
  return { trigger, condition: null, actions };
}

const ctx = { triggerTableId: TICKETS, firstTableId: TICKETS };
const t = ((key: string, options?: Record<string, unknown>) =>
  options === undefined
    ? key
    : `${key} ${JSON.stringify(options)}`) as TFunction<'automationBuilder'>;

describe('new AI steps (T915)', () => {
  it('offers both AI steps at the end of the menu', () => {
    expect(ACTION_MENU.slice(-2)).toEqual(['ai_generate_text', 'ai_classify']);
    expect([...AI_ACTION_TYPES]).toEqual(['ai_generate_text', 'ai_classify']);
  });

  it('starts them empty: the save check names what to fill', () => {
    const text = newAction('ai_generate_text', 'act_1', ctx);
    const classify = newAction('ai_classify', 'act_2', ctx);
    expect(text.config).toEqual({
      prompt: '',
      instructions: null,
      max_output_tokens: 300,
      target_field_id: null,
    });
    const issues = checkDraft(definitionWith([text, classify]), { ...context, name: 'AI' });
    expect(issues.map((issue) => `${issue.step} ${issue.path} ${issue.code}`)).toEqual([
      'act_1 config.prompt REQUIRED',
      'act_2 config.input REQUIRED',
      'act_2 config.target_field_id REQUIRED',
    ]);
  });

  it('accepts complete steps (the contract schema too)', () => {
    const definition = definitionWith([
      {
        id: 'act_1',
        type: 'ai_classify',
        config: {
          input: 'Severity of {{ [fld_Desc00000000001] }}',
          instructions: null,
          target_field_id: SEVERITY,
        },
      },
    ]);
    expect(checkDraft(definition, { ...context, name: 'AI' })).toEqual([]);
    expect(automationDefinitionSchema.safeParse(definition).success).toBe(true);
  });

  it('needs a trigger record', () => {
    const step = {
      ...newAction('ai_generate_text', 'act_1', ctx),
      config: {
        prompt: 'Hello',
        instructions: null,
        max_output_tokens: 300,
        target_field_id: null,
      },
    } as AutomationAction;
    const scheduled = definitionWith([step], {
      type: 'schedule',
      cron: '0 8 * * *',
      timezone: null,
    });
    expect(checkDraft(scheduled, { ...context, name: 'AI' })).toEqual([
      { step: 'act_1', path: '', code: 'NO_TRIGGER_RECORD' },
    ]);
  });
});

describe('the text of an AI step in later templates', () => {
  const definition = definitionWith([
    {
      id: 'act_1',
      type: 'ai_generate_text',
      config: {
        prompt: 'Summarize',
        instructions: null,
        max_output_tokens: 300,
        target_field_id: null,
      },
    },
    { id: 'act_2', type: 'delete_record', config: {} },
  ]);
  const scope = scopeOf(definition, 'act_2', TICKETS);
  const names = { fieldsOf: () => [] as FieldDto[] };

  it('names `[act_1]` "Step 1 · AI text"', () => {
    expect(chipNameOf('[act_1]', scope, names)).toEqual({
      tone: 'step',
      number: '1',
      part: 'text',
    });
    // Its record makes no sense: an AI step has none.
    expect(chipNameOf('[act_1].[fld_X]', scope, names).tone).toBe('error');
  });

  it('sends it as a text step to validate-template', () => {
    expect(templateTextSteps(scope)).toEqual(['act_1']);
    expect(templateTextSteps(scopeOf(definition, 'act_1', TICKETS))).toEqual([]);
  });

  it('offers it in the "+" menu of templates, as one chip', () => {
    const sections = pickerSections({
      scope,
      names,
      tableName: () => 'Tickets',
      mode: 'template',
      t,
    });
    const steps = sections.find((section) => section.key === 'steps');
    expect(steps?.items).toEqual([
      {
        key: 'step:act_1',
        label: 'chip.stepPart {"number":"1","part":"chip.part.text"}',
        tone: 'step',
        pick: { kind: 'ref', expression: '[act_1]' },
      },
    ]);
  });
});
