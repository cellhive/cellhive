import {
  AUTO_NUMBER_DATE_FORMATS,
  formatAutoNumber,
  type AutoNumberOptions,
  type AutoNumberRule,
} from '@cellhive/field-types';
import { Button, Input, Select } from '@cellhive/ui';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { issueAt, useIssueText } from '../shared';

import type { DraftIssue } from '../../draft';

/** SPEC §5.5: 1 to 9 rules. */
const MAX_RULES = 9;
const LENGTHS = Array.from({ length: 9 }, (_, index) => index + 1);
const RULE_TYPES: readonly AutoNumberRule['type'][] = [
  'text',
  'incremental_number',
  'created_time',
];

function defaultRule(type: AutoNumberRule['type']): AutoNumberRule {
  switch (type) {
    case 'text':
      return { type: 'text', text: '-' };
    case 'incremental_number':
      return { type: 'incremental_number', length: 4 };
    case 'created_time':
      return { type: 'created_time', date_format: 'yyyyMMdd' };
  }
}

/** The first numbers the rules would give, or `null` while a rule is invalid. */
export function autoNumberPreview(
  rules: readonly AutoNumberRule[],
  timeZone: string,
  now: Date,
): string[] | null {
  if (rules.some((rule) => rule.type === 'text' && rule.text === '')) return null;
  return [1, 2, 3].map((autoValue) =>
    formatAutoNumber(rules, { autoValue, createdAt: now, timeZone }),
  );
}

export interface AutoNumberRulesBuilderProps {
  readonly value: AutoNumberOptions;
  readonly onChange: (value: AutoNumberOptions) => void;
  readonly issues: readonly DraftIssue[];
  /** Zone of `created_time` rules (the org zone on the server). */
  readonly timeZone: string;
  /** An existing field: changing the rules renumbers its records. */
  readonly existing: boolean;
}

/**
 * Rules of an `auto_number` field (SPEC §5.5), e.g. `TK-` + date + `-` +
 * 4-digit counter, with a live preview of the first numbers.
 */
export function AutoNumberRulesBuilder({
  value,
  onChange,
  issues,
  timeZone,
  existing,
}: AutoNumberRulesBuilderProps) {
  const { t } = useTranslation('field');
  const issueText = useIssueText();
  const headingId = useId();
  const rules = value.style.rules;
  const setRules = (next: AutoNumberRule[]) => {
    onChange({ ...value, style: { rules: next } });
  };
  const replace = (index: number, rule: AutoNumberRule) => {
    setRules(rules.map((current, position) => (position === index ? rule : current)));
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    if (rule === undefined) return;
    next.splice(index + by, 0, rule);
    setRules(next);
  };
  const preview = autoNumberPreview(rules, timeZone, new Date());

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-label text-fg">
        {t('autoNumber.rules')}
      </h3>
      <ol className="flex flex-col gap-2">
        {rules.map((rule, index) => {
          const position = index + 1;
          const error = issueText(issueAt(issues, `options.style.rules.${String(index)}.text`));
          return (
            // Rules have no identity of their own: the position is the key.
            <li key={index} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Select
                  aria-label={t('autoNumber.ruleType', { position })}
                  className="w-40 shrink-0"
                  value={rule.type}
                  onChange={(event) => {
                    replace(index, defaultRule(event.target.value as AutoNumberRule['type']));
                  }}
                >
                  {RULE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`autoNumber.types.${type}`)}
                    </option>
                  ))}
                </Select>
                {rule.type === 'text' ? (
                  <Input
                    aria-label={t('autoNumber.text', { position })}
                    aria-invalid={error !== undefined}
                    autoComplete="off"
                    maxLength={100}
                    value={rule.text}
                    onChange={(event) => {
                      replace(index, { type: 'text', text: event.target.value });
                    }}
                  />
                ) : null}
                {rule.type === 'incremental_number' ? (
                  <Select
                    aria-label={t('autoNumber.length', { position })}
                    value={String(rule.length)}
                    onChange={(event) => {
                      replace(index, {
                        type: 'incremental_number',
                        length: Number(event.target.value),
                      });
                    }}
                  >
                    {LENGTHS.map((length) => (
                      <option key={length} value={length}>
                        {t('autoNumber.digits', { count: length })}
                      </option>
                    ))}
                  </Select>
                ) : null}
                {rule.type === 'created_time' ? (
                  <Select
                    aria-label={t('autoNumber.dateFormat', { position })}
                    value={rule.date_format}
                    onChange={(event) => {
                      replace(index, {
                        type: 'created_time',
                        date_format: event.target
                          .value as (typeof AUTO_NUMBER_DATE_FORMATS)[number],
                      });
                    }}
                  >
                    {AUTO_NUMBER_DATE_FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {format}
                      </option>
                    ))}
                  </Select>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={t('autoNumber.moveUp', { position })}
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={t('autoNumber.moveDown', { position })}
                  disabled={index === rules.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={t('autoNumber.remove', { position })}
                  disabled={rules.length === 1}
                  onClick={() => {
                    setRules(rules.filter((_, current) => current !== index));
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              {error === undefined ? null : (
                <p className="text-label font-normal text-danger">{error}</p>
              )}
            </li>
          );
        })}
      </ol>
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={rules.length >= MAX_RULES}
          onClick={() => {
            setRules([...rules, defaultRule('text')]);
          }}
        >
          <Plus aria-hidden="true" />
          {t('autoNumber.add')}
        </Button>
      </div>
      <div className="flex flex-col gap-1 rounded-md bg-surface-sunken px-3 py-2">
        <p className="text-label text-fg-muted">{t('autoNumber.preview')}</p>
        <p aria-live="polite" className="font-mono text-mono text-fg">
          {preview === null ? t('autoNumber.previewInvalid') : preview.join(', ')}
        </p>
      </div>
      {existing ? (
        <p className="text-label font-normal text-fg-muted">{t('autoNumber.recomputeHint')}</p>
      ) : null}
    </section>
  );
}
