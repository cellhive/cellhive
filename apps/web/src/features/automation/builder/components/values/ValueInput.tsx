import { Button, Tooltip } from '@cellhive/ui';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { sourceNameOf, type ValueScope } from '../../model/scope';
import { templateOf, templateSegments, valueKind } from '../../model/values';
import { useBuilderEnv } from '../env';

import { Chip } from './chips';
import { ExpressionDialog } from './ExpressionDialog';
import { LiteralEditor } from './LiteralEditor';
import { pickerSections } from './sections';
import { TemplateInput } from './TemplateInput';
import { useTemplateChips } from './use-template-chips';
import { ValuePicker } from './ValuePicker';

import type { AutomationValue, FieldDto } from '@cellhive/contracts';

export interface ValueInputProps {
  readonly value: AutomationValue | undefined;
  readonly onChange: (value: AutomationValue | undefined) => void;
  /** The field written (`null`: a comparison of an `if`). Text fields take templates. */
  readonly field: FieldDto | null;
  readonly scope: ValueScope;
  readonly label: string;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
  /** Text and comparisons may hold several chips and text (a template). */
  readonly allowTemplate?: boolean | undefined;
  readonly multiline?: boolean | undefined;
  readonly testId?: string | undefined;
  /** Without a field: the constant is a date and time (`delay.until`). */
  readonly literal?: 'datetime' | undefined;
}

const TEMPLATE = 'template';
const VALUE = 'value';

/** A template without chips is saved as its text (a literal). */
function fromTemplate(template: string): AutomationValue | undefined {
  const segments = templateSegments(template);
  if (segments.every((segment) => segment.kind === 'text')) {
    const text = segments.map((segment) => segment.text).join('');
    return text === '' ? undefined : { literal: text };
  }
  return { template };
}

/** The template a text value shows in the template field. */
function asTemplate(value: AutomationValue | undefined): string {
  if (value === undefined) return '';
  if ('template' in value) return value.template;
  if ('literal' in value && typeof value.literal === 'string') {
    return templateOf([{ kind: 'text', text: value.literal }]);
  }
  return '';
}

/**
 * One value of an action (SPEC §11.4; board "S5 · Automation builder"):
 * text with chips for text fields, a constant editor by field type for
 * others, or one source chip (field of the trigger record, trigger data,
 * output of an earlier step) chosen from the "+" menu.
 */
export function ValueInput({
  value,
  onChange,
  field,
  scope,
  label,
  invalid,
  describedBy,
  allowTemplate,
  multiline,
  testId,
  literal,
}: ValueInputProps) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const [picking, setPicking] = useState(false);
  const [expression, setExpression] = useState<((stored: string) => void) | null>(null);
  const kind = value === undefined ? null : valueKind(value);
  const textual = allowTemplate ?? (field === null || field.type === 'text');
  const template = asTemplate(value);
  const chipLabel = useTemplateChips(template, scope);

  const expressionDialog =
    expression === null ? null : (
      <ExpressionDialog
        baseId={env.base.id}
        scope={scope}
        onCancel={() => {
          setExpression(null);
        }}
        onInsert={(stored) => {
          expression(stored);
          setExpression(null);
        }}
      />
    );

  if (kind === 'digest') {
    return (
      <p className="text-label font-normal text-fg-muted" data-testid={testId}>
        {t('values.digest')}
      </p>
    );
  }

  const textLiteral =
    value !== undefined && 'literal' in value && typeof value.literal === 'string';
  // A formula (`{{ [Số tiền] + 1 }}`) shows as its chips whatever the field type: a
  // constant editor would show it empty (T527) and replace it at the first key.
  if (kind === 'template' || (textual && (kind === null || textLiteral))) {
    return (
      <>
        <TemplateInput
          value={template}
          onChange={(next) => {
            onChange(fromTemplate(next));
          }}
          chipLabel={chipLabel}
          sections={pickerSections({
            scope,
            names: env,
            tableName: env.tableName,
            mode: TEMPLATE,
            t,
          })}
          onExpression={(insert) => {
            setExpression(() => insert);
          }}
          label={label}
          invalid={invalid}
          describedBy={describedBy}
          multiline={multiline}
          testId={testId}
        />
        {expressionDialog}
      </>
    );
  }

  const source =
    value !== undefined && ('field' in value || 'trigger' in value || 'step' in value)
      ? value
      : null;
  return (
    <div className="relative flex min-w-0 items-start gap-1" data-testid={testId}>
      <div className="min-w-0 flex-1">
        {source === null ? (
          <LiteralEditor
            field={field}
            value={value !== undefined && 'literal' in value ? value.literal : undefined}
            onChange={(literal) => {
              onChange(literal === undefined ? undefined : { literal: literal as never });
            }}
            label={label}
            invalid={invalid}
            describedBy={describedBy}
            kind={literal}
          />
        ) : (
          <div
            className="flex min-h-control items-center rounded-md border border-line-control bg-surface px-2"
            role="group"
            aria-label={label}
            aria-describedby={describedBy}
          >
            <Chip name={sourceNameOf(source, scope, env)}>
              <button
                type="button"
                className="-mr-0.5 ml-0.5 inline-flex size-4 items-center justify-center rounded-full hover:bg-surface/60"
                aria-label={t('values.clear', { label })}
                onClick={() => {
                  onChange(undefined);
                }}
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </Chip>
          </div>
        )}
      </div>
      <Tooltip content={t('values.insert')}>
        <Button
          variant="secondary"
          size="icon"
          className="size-8 max-lg:size-control"
          aria-label={t('values.pickFor', { label })}
          aria-expanded={picking}
          onClick={() => {
            setPicking(true);
          }}
        >
          <Plus aria-hidden="true" />
        </Button>
      </Tooltip>
      {picking ? (
        <ValuePicker
          label={t('values.pickerLabel', { label })}
          sections={pickerSections({
            scope,
            names: env,
            tableName: env.tableName,
            mode: VALUE,
            t,
          })}
          onPick={(picked) => {
            if (picked.kind === 'value') onChange(picked.value);
          }}
          onClose={() => {
            setPicking(false);
          }}
        />
      ) : null}
      {expressionDialog}
    </div>
  );
}
