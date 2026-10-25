import { Button, Tooltip } from '@cellhive/ui';
import { Plus, X } from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isAutomationValue } from '../../../../../lib/automation/condition-editor';
import { useBuilderEnv } from '../env';
import { ValueSummary } from '../summaries';

import { pickerSections } from './sections';
import { ValuePicker } from './ValuePicker';

import type { ConditionValueSourceProps } from '../../../../../lib/automation/condition-editor';
import type { ValueScope } from '../../model/scope';
import type { AutomationValue } from '@cellhive/contracts';

/** The scope of the step whose filter is edited (the condition editor knows no automation). */
export const FilterScopeContext = createContext<ValueScope | null>(null);

const VALUE = 'value';

/**
 * A value from the automation in a condition of `update_records` (T506,
 * CONTRACTS §21: a whole value of SPEC §11.4 as the condition's value,
 * resolved when the step runs): a "+" next to the constant editor; once
 * chosen, a chip (×: back to a constant).
 */
export function FilterValueSource({ value, onChange, label }: ConditionValueSourceProps) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const scope = useContext(FilterScopeContext);
  const [picking, setPicking] = useState(false);
  if (scope === null) return null;
  const source = isAutomationValue(value) ? (value as AutomationValue) : null;
  return (
    <span className="relative inline-flex items-center gap-1">
      {source === null ? null : (
        <span className="inline-flex items-center gap-1" data-testid="filter-value-source">
          <ValueSummary value={source} scope={scope} />
          <Tooltip content={t('values.clear', { label })}>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 max-lg:size-control"
              aria-label={t('values.clear', { label })}
              onClick={() => {
                onChange(undefined);
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </Tooltip>
        </span>
      )}
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
    </span>
  );
}
