import { MAX_EMAIL_RECIPIENT_VALUES, type EmailRecipientValue } from '@cellhive/contracts';
import { Button, cn, Tooltip } from '@cellhive/ui';
import { AlertTriangle, AtSign, Clock, Hash, Layers, Plus, X, type LucideIcon } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useBuilderEnv } from '../../components/env';
import { IssueText } from '../../components/panels/common';
import { CHIP_CLASS, CHIP_TONE_CLASS, useChipText } from '../../components/values/chips';
import {
  ValuePicker,
  type PickerItem,
  type PickerSection,
} from '../../components/values/ValuePicker';
import { issuesOf, type StepKey } from '../../model/issues';
import { sourceNameOf, type ValueScope, ChipTone } from '../../model/scope';

import {
  addAddresses,
  isRecipientField,
  recipientKey,
  recipientTokens,
  splitAddresses,
} from './model';

import type { TFunction } from 'i18next';

const LITERAL = 'literal';

const TOKEN_ICONS: Record<ChipTone | 'literal', LucideIcon> = {
  literal: AtSign,
  field: Hash,
  trigger: Clock,
  step: Layers,
  expression: Hash,
  error: AlertTriangle,
};

/**
 * Sections of the "+" menu of a recipient box (CONTRACTS §21): people and
 * email fields of the trigger record, the person who clicked the button,
 * people/email fields of the first record an earlier `find_records` found.
 */
export function recipientSections(
  scope: ValueScope,
  env: ReturnType<typeof useBuilderEnv>,
  t: TFunction<'automationEmail'>,
  tb: TFunction<'automationBuilder'>,
): PickerSection[] {
  const sections: PickerSection[] = [];
  if (scope.triggerTableId !== null) {
    const items: PickerItem[] = (env.fieldsOf(scope.triggerTableId) ?? [])
      .filter(isRecipientField)
      .map((field) => ({
        key: `field:${field.id}`,
        label: field.name,
        hint: field.type === 'text' ? t('recipients.emailField') : t('recipients.userField'),
        tone: 'field' as const,
        pick: { kind: 'value' as const, value: { field: field.id } },
      }));
    if (items.length > 0) {
      sections.push({
        key: 'record',
        title: tb('picker.record', { table: env.tableName(scope.triggerTableId) ?? '' }),
        items,
      });
    }
  }
  if (scope.triggerType === 'button.clicked') {
    sections.push({
      key: 'trigger',
      title: tb('picker.trigger'),
      items: [
        {
          key: 'trigger:clicked_by',
          label: tb('chip.trigger.clicked_by'),
          tone: 'trigger',
          pick: { kind: 'value', value: { trigger: 'clicked_by' } },
        },
      ],
    });
  }
  const steps = scope.steps.flatMap((step): PickerItem[] => {
    if (step.type !== 'find_records' || step.tableId === null) return [];
    return (env.fieldsOf(step.tableId) ?? []).filter(isRecipientField).map((field) => ({
      key: `step:${step.id}:${field.id}`,
      label: t('recipients.stepField', { number: step.number, field: field.name }),
      tone: 'step' as const,
      pick: {
        kind: 'value' as const,
        value: { step: step.id, path: `records[0].fields.${field.id}` },
      },
    }));
  });
  if (steps.length > 0) sections.push({ key: 'steps', title: tb('picker.steps'), items: steps });
  return sections;
}

export interface RecipientsFieldProps {
  readonly label: string;
  readonly step: StepKey;
  /** `config.to`, `config.cc`, `config.bcc`. */
  readonly path: string;
  readonly value: readonly EmailRecipientValue[];
  readonly onChange: (value: EmailRecipientValue[]) => void;
  readonly scope: ValueScope;
  readonly testId: string;
}

/**
 * One recipient list as tokens (board "S5 · Email template editor"): typed
 * addresses (Enter, comma, semicolon, space or leaving the box make
 * tokens; a pasted list is split), people/email fields, the person who
 * clicked, a field of an earlier step's record from "+". Backspace in the
 * empty box removes the last token; each token has its own remove button.
 */
export function RecipientsField({
  label,
  step,
  path,
  value,
  onChange,
  scope,
  testId,
}: RecipientsFieldProps) {
  const { t } = useTranslation('automationEmail');
  const { t: tb } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const chipText = useChipText();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const tokens = recipientTokens(value);
  const issues = issuesOf(env.issues, step).filter(
    (issue) => issue.path === path || issue.path.startsWith(`${path}[`),
  );
  const full = tokens.length >= MAX_EMAIL_RECIPIENT_VALUES;
  const describedBy =
    [issues.length > 0 ? `${id}-issues` : null, invalid.length > 0 ? `${id}-invalid` : null]
      .filter((item) => item !== null)
      .join(' ') || undefined;

  const commit = (raw: string): boolean => {
    const { valid, invalid: wrong } = splitAddresses(raw);
    if (valid.length > 0)
      onChange(addAddresses(tokens, valid).slice(0, MAX_EMAIL_RECIPIENT_VALUES));
    setInvalid(wrong);
    setText(wrong.join(', '));
    return valid.length > 0 || wrong.length > 0;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      if (text.trim() === '') return;
      event.preventDefault();
      commit(text);
    } else if (event.key === 'Backspace' && text === '' && tokens.length > 0) {
      event.preventDefault();
      onChange(tokens.slice(0, -1));
    }
  };

  const nameOf = (token: EmailRecipientValue): string => {
    if ('literal' in token) return typeof token.literal === 'string' ? token.literal : '';
    if ('step' in token && token.path?.startsWith('records[0].fields.') === true) {
      const fieldId = token.path.slice('records[0].fields.'.length);
      const owner = scope.steps.find((item) => item.id === token.step);
      const field =
        owner?.tableId === null || owner === undefined
          ? undefined
          : env.fieldsOf(owner.tableId)?.find((item) => item.id === fieldId);
      if (owner !== undefined && field !== undefined) {
        return t('recipients.stepField', { number: owner.number, field: field.name });
      }
    }
    return chipText(sourceNameOf(token, scope, env));
  };

  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2 max-sm:grid-cols-1">
      <label htmlFor={id} className="pt-2 text-label text-fg">
        {label}
      </label>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="relative flex min-w-0 items-start gap-1">
          <div
            className={cn(
              'flex min-h-control min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border border-line-control bg-surface px-1.5 py-1',
              'focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent',
              issues.length > 0 && 'border-danger',
            )}
            data-testid={testId}
          >
            <ul className="contents" aria-label={t('recipients.list', { label })}>
              {tokens.map((token, index) => {
                const name = nameOf(token);
                const remove = (
                  <button
                    type="button"
                    className="-mr-0.5 ml-0.5 inline-flex size-4 items-center justify-center rounded-full hover:bg-surface/60"
                    aria-label={t('recipients.remove', { name })}
                    onClick={() => {
                      onChange(tokens.filter((_, position) => position !== index));
                      input.current?.focus();
                    }}
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                );
                const tone = 'literal' in token ? LITERAL : sourceNameOf(token, scope, env).tone;
                const Icon = TOKEN_ICONS[tone];
                return (
                  <li key={`${recipientKey(token)}-${String(index)}`} className="flex min-w-0">
                    <span
                      className={cn(
                        CHIP_CLASS,
                        tone === LITERAL
                          ? 'border-line bg-surface-sunken text-fg'
                          : CHIP_TONE_CLASS[tone],
                      )}
                      data-chip-tone={tone}
                      title={tone === 'error' ? tb('chip.refHint') : undefined}
                    >
                      <Icon aria-hidden="true" className="size-3 shrink-0" />
                      <span className="truncate">{name}</span>
                      {remove}
                    </span>
                  </li>
                );
              })}
            </ul>
            <input
              ref={input}
              id={id}
              type="text"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              disabled={full}
              value={text}
              aria-label={t('recipients.add', { label })}
              aria-invalid={issues.length > 0 || invalid.length > 0 || undefined}
              aria-describedby={describedBy}
              placeholder={tokens.length === 0 ? t('recipients.placeholder') : undefined}
              className="h-7 min-w-32 flex-1 bg-transparent px-1 text-body outline-none placeholder:text-fg-subtle max-lg:text-[16px]"
              onChange={(event) => {
                setText(event.target.value);
                if (invalid.length > 0) setInvalid([]);
              }}
              onKeyDown={onKeyDown}
              onBlur={() => {
                if (text.trim() !== '') commit(text);
              }}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData('text/plain');
                if (!/[,;\s]/u.test(pasted.trim())) return;
                event.preventDefault();
                commit(`${text} ${pasted}`);
              }}
            />
          </div>
          <Tooltip content={t('recipients.pick')}>
            <Button
              variant="secondary"
              size="icon"
              className="size-8 max-lg:size-control"
              aria-label={t('recipients.pickFor', { label })}
              aria-expanded={picking}
              disabled={full}
              onClick={() => {
                setPicking(true);
              }}
            >
              <Plus aria-hidden="true" />
            </Button>
          </Tooltip>
          {picking ? (
            <ValuePicker
              label={t('recipients.pickFor', { label })}
              sections={recipientSections(scope, env, t, tb)}
              onPick={(picked) => {
                if (picked.kind !== 'value') return;
                const next = picked.value as EmailRecipientValue;
                if (tokens.some((token) => recipientKey(token) === recipientKey(next))) return;
                onChange([...tokens, next]);
              }}
              onClose={(reason) => {
                setPicking(false);
                if (reason !== 'outside') input.current?.focus();
              }}
            />
          ) : null}
        </div>
        {invalid.length > 0 ? (
          <p id={`${id}-invalid`} className="text-label font-normal text-danger" role="alert">
            {t('recipients.invalid', { addresses: invalid.join(', ') })}
          </p>
        ) : null}
        <IssueText id={`${id}-issues`} issues={issues} />
      </div>
    </div>
  );
}
