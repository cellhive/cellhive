import {
  AI_FIELD_MAX_INSTRUCTIONS_LENGTH,
  AI_FIELD_MAX_OUTPUT_TOKENS,
  AI_FIELD_MIN_OUTPUT_TOKENS,
  type FieldDto,
} from '@cellhive/contracts';
import { Input, Select } from '@cellhive/ui';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { isAiField } from '../../../../../lib/ai/ai-field';
import { useBuilderEnv, useFields } from '../../components/env';
import { Note, PanelField } from '../../components/panels/common';
import { TemplateInput } from '../../components/values/TemplateInput';
import { useTemplateChips } from '../../components/values/use-template-chips';
import { asFieldId, isUnset } from '../../model/draft';
import { referenceExpression } from '../../model/values';

import type { ActionPanelProps } from '../../components/panels/ActionPanels';
import type { PickerSection } from '../../components/values/ValuePicker';
import type { StepKey } from '../../model/issues';
import type { ValueScope } from '../../model/scope';

/**
 * Types a prompt may name (CONTRACTS §29.6, the AI field's rule §29.5):
 * values of the trigger record itself — no link, lookup, attachment,
 * button nor AI field. Formulas are offered; one reading another record is
 * refused by the server at its place (`CROSS_TABLE_NOT_SUPPORTED`).
 */
const PROMPT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'number',
  'select',
  'datetime',
  'checkbox',
  'user',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'auto_number',
  'formula',
]);

const TEXTAREA =
  'min-h-16 w-full rounded-md border border-line-control bg-surface px-3 py-2 text-body text-fg ' +
  'placeholder:text-fg-subtle aria-invalid:border-danger max-lg:text-[16px]';

/** Paths of the settings (`errors[].path` below the step, CONTRACTS §29.6) and test ids. */
const PATH = {
  prompt: 'config.prompt',
  input: 'config.input',
  instructions: 'config.instructions',
  tokens: 'config.max_output_tokens',
  target: 'config.target_field_id',
} as const;
const TEST = {
  noRecordData: 'ai-step-no-record-data',
  quota: 'ai-step-quota',
  prompt: 'ai-step-prompt',
  input: 'ai-step-input',
} as const;

/** The "+" menu of a prompt: the trigger record's fields it may name, and nothing else. */
function promptSections(fields: readonly FieldDto[], title: string): PickerSection[] {
  return [
    {
      key: 'record',
      title,
      items: fields
        .filter((field) => PROMPT_TYPES.has(field.type) && !isAiField(field))
        .map((field) => ({
          key: `field:${field.id}`,
          label: field.name,
          tone: 'field' as const,
          pick: {
            kind: 'ref' as const,
            expression: referenceExpression({ kind: 'field', fieldId: field.id }),
          },
        })),
    },
  ];
}

/** Notes common to both AI steps: where the data goes, the quota rule, record values off. */
function AiNotes() {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  return (
    <>
      {env.ai?.record_data === false ? (
        <Note tone="danger" title={t('aiStep.noRecordData')} testId={TEST.noRecordData}>
          {env.aiSettingsPath == null ? (
            t('aiStep.noRecordDataMember')
          ) : (
            <Link
              to={env.aiSettingsPath}
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              {t('flow.openAiSettings')}
            </Link>
          )}
        </Note>
      ) : null}
      <Note tone="warning" title={t('aiStep.quotaTitle')} testId={TEST.quota}>
        {t('aiStep.quota')}
      </Note>
    </>
  );
}

function PromptField({
  step,
  path,
  label,
  hint,
  template,
  scope,
  onChange,
  testId,
}: {
  readonly step: StepKey;
  readonly path: string;
  readonly label: string;
  readonly hint: string;
  readonly template: string;
  readonly scope: ValueScope;
  readonly onChange: (template: string) => void;
  readonly testId: string;
}) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const tableId = scope.triggerTableId;
  const fields = useFields(tableId);
  // A prompt reads the trigger record only: no step output, no trigger data (CONTRACTS §29.6).
  const promptScope: ValueScope = { ...scope, steps: [] };
  const chips = useTemplateChips(template, promptScope);
  const sections =
    tableId === null
      ? []
      : promptSections(fields, t('picker.record', { table: env.tableName(tableId) ?? '' }));
  return (
    <PanelField label={label} step={step} path={path} hint={hint}>
      {(control) => (
        <TemplateInput
          value={template}
          onChange={onChange}
          chipLabel={chips}
          sections={sections}
          label={label}
          multiline
          placeholder={t('aiStep.promptPlaceholder')}
          invalid={control['aria-invalid']}
          describedBy={control['aria-describedby']}
          testId={testId}
        />
      )}
    </PanelField>
  );
}

function InstructionsField({
  step,
  value,
  onChange,
}: {
  readonly step: StepKey;
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}) {
  const { t } = useTranslation('automationBuilder');
  return (
    <PanelField
      label={t('aiStep.instructions')}
      step={step}
      path={PATH.instructions}
      hint={t('aiStep.instructionsHint')}
    >
      {(control) => (
        <textarea
          {...control}
          rows={2}
          maxLength={AI_FIELD_MAX_INSTRUCTIONS_LENGTH}
          className={TEXTAREA}
          value={value ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next.trim() === '' ? null : next);
          }}
        />
      )}
    </PanelField>
  );
}

/** Plain text fields of the trigger table a step may write (not AI, not computed). */
function textTargets(fields: readonly FieldDto[]): FieldDto[] {
  return fields.filter((field) => field.type === 'text' && !isAiField(field));
}

/** Single select fields of the trigger table `ai_classify` may write (not AI). */
function selectTargets(fields: readonly FieldDto[]): FieldDto[] {
  return fields.filter(
    (field) => field.type === 'select' && field.options['multiple'] !== true && !isAiField(field),
  );
}

/**
 * `ai_generate_text` (T915, CONTRACTS §29.6; board "S5 · Automation builder
 * - action"): a prompt of the trigger record's fields (chips), instructions,
 * the longest answer, and the text field it writes — or none: later steps
 * place the text (`[act_…]`, "Step N · AI text"). The model's text is data:
 * written as is, escaped where a later step places it.
 */
export function AiGenerateTextPanel({
  action,
  scope,
  onChange,
}: ActionPanelProps<'ai_generate_text'>) {
  const { t } = useTranslation('automationBuilder');
  const step = action.id as StepKey;
  const config = action.config;
  const fields = useFields(scope.triggerTableId);
  const targets = textTargets(fields);
  const set = (patch: Partial<typeof config>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };
  const target = config.target_field_id;
  return (
    <div className="flex flex-col gap-4" data-testid="ai-generate-text-panel">
      <p className="flex items-start gap-1.5 text-label font-normal text-fg-muted">
        <Sparkles aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
        {t('aiStep.generateIntro')}
      </p>
      {scope.triggerTableId === null ? <Note tone="warning">{t('aiStep.noRecord')}</Note> : null}
      <PromptField
        step={step}
        path={PATH.prompt}
        label={t('aiStep.prompt')}
        hint={t('aiStep.promptHint')}
        template={config.prompt}
        scope={scope}
        testId={TEST.prompt}
        onChange={(prompt) => {
          set({ prompt });
        }}
      />
      <InstructionsField
        step={step}
        value={config.instructions}
        onChange={(instructions) => {
          set({ instructions });
        }}
      />
      <PanelField
        label={t('aiStep.maxTokens')}
        step={step}
        path={PATH.tokens}
        hint={t('aiStep.maxTokensHint')}
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            min={AI_FIELD_MIN_OUTPUT_TOKENS}
            max={AI_FIELD_MAX_OUTPUT_TOKENS}
            className="w-28"
            value={String(config.max_output_tokens)}
            onChange={(event) => {
              const next = event.target.valueAsNumber;
              if (Number.isInteger(next)) {
                set({
                  max_output_tokens: Math.min(
                    AI_FIELD_MAX_OUTPUT_TOKENS,
                    Math.max(AI_FIELD_MIN_OUTPUT_TOKENS, next),
                  ),
                });
              }
            }}
          />
        )}
      </PanelField>
      <PanelField
        label={t('aiStep.writeTo')}
        step={step}
        path={PATH.target}
        hint={t(target === null ? 'aiStep.outputOnlyHint' : 'aiStep.writeToHint')}
      >
        {(control) => (
          <Select
            {...control}
            value={target ?? ''}
            data-testid="ai-step-target"
            onChange={(event) => {
              const next = event.target.value;
              set({ target_field_id: next === '' ? null : asFieldId(next) });
            }}
          >
            <option value="">{t('aiStep.outputOnly')}</option>
            {targets.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
            {target !== null && !targets.some((field) => field.id === target) ? (
              <option value={target}>{t('aiStep.unknownField')}</option>
            ) : null}
          </Select>
        )}
      </PanelField>
      <AiNotes />
    </div>
  );
}

/**
 * `ai_classify` (T915, CONTRACTS §29.6): an input of the trigger record's
 * fields (chips), instructions, and the single select field it sets — the
 * model answers one of that field's options (an `enum`), nothing else.
 */
export function AiClassifyPanel({ action, scope, onChange }: ActionPanelProps<'ai_classify'>) {
  const { t } = useTranslation('automationBuilder');
  const step = action.id as StepKey;
  const config = action.config;
  const fields = useFields(scope.triggerTableId);
  const targets = selectTargets(fields);
  const set = (patch: Partial<typeof config>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };
  const target = isUnset(config.target_field_id) ? '' : config.target_field_id;
  const chosen = targets.find((field) => field.id === target);
  const options = Array.isArray(chosen?.options['options'])
    ? (chosen.options['options'] as readonly { readonly name?: unknown }[])
        .map((option) => (typeof option.name === 'string' ? option.name : ''))
        .filter((name) => name !== '')
    : [];
  return (
    <div className="flex flex-col gap-4" data-testid="ai-classify-panel">
      <p className="flex items-start gap-1.5 text-label font-normal text-fg-muted">
        <Sparkles aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
        {t('aiStep.classifyIntro')}
      </p>
      {scope.triggerTableId === null ? <Note tone="warning">{t('aiStep.noRecord')}</Note> : null}
      <PromptField
        step={step}
        path={PATH.input}
        label={t('aiStep.input')}
        hint={t('aiStep.promptHint')}
        template={config.input}
        scope={scope}
        testId={TEST.input}
        onChange={(input) => {
          set({ input });
        }}
      />
      <InstructionsField
        step={step}
        value={config.instructions}
        onChange={(instructions) => {
          set({ instructions });
        }}
      />
      <PanelField
        label={t('aiStep.classifyInto')}
        step={step}
        path={PATH.target}
        hint={
          options.length === 0
            ? t('aiStep.classifyIntoHint')
            : t('aiStep.classifyOptions', { options: options.join(', ') })
        }
      >
        {(control) => (
          <Select
            {...control}
            value={target}
            data-testid="ai-step-target"
            onChange={(event) => {
              set({ target_field_id: asFieldId(event.target.value) });
            }}
          >
            <option value="">{t('values.choose')}</option>
            {targets.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
            {target !== '' && chosen === undefined ? (
              <option value={target}>{t('aiStep.unknownField')}</option>
            ) : null}
          </Select>
        )}
      </PanelField>
      <AiNotes />
    </div>
  );
}
