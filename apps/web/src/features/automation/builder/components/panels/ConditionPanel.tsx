import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { conditionSlot } from '../../model/check';
import { issuesOf } from '../../model/issues';
import { useBuilderEnv, useFields } from '../env';

import { Note } from './common';
import { isVirtual } from './trigger-fields';

import type { AutomationFilter } from '@cellhive/contracts';

export interface ConditionPanelProps {
  readonly tableId: string | null;
  readonly changeOperators: boolean;
  readonly value: AutomationFilter | null;
  readonly onChange: (filter: AutomationFilter | null) => void;
}

/**
 * "Run only if" (SPEC §11.3; board "S5 · Automation builder - trigger và
 * điều kiện"): the view filter builder (T311), one level, tested on the
 * trigger record after the change; `record.updated` adds "has changed /
 * changed to / changed from". Virtual computed fields are not offered (T509).
 */
export function ConditionPanel({ tableId, changeOperators, value, onChange }: ConditionPanelProps) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const fields = useFields(tableId);
  const virtual = useMemo(
    () => new Set(fields.filter(isVirtual).map((field) => field.id)),
    [fields],
  );
  const ConditionEditor = env.ConditionEditor;
  if (tableId === null) {
    return <Note>{t('condition.noTable')}</Note>;
  }
  return (
    <div className="flex flex-col gap-3" data-testid="condition-panel">
      <ConditionEditor
        key={`${tableId}:${String(env.resetKey)}`}
        tableId={tableId}
        orgId={env.orgId}
        value={value}
        changeOperators={changeOperators}
        excludeFields={virtual}
        issues={issuesOf(env.issues, 'condition')}
        label={t('condition.label')}
        emptyText={t('condition.empty')}
        onChange={(state) => {
          env.setConditionState(conditionSlot('condition', ''), state);
          onChange(state.filter);
        }}
      />
      <p className="text-label font-normal text-fg-muted">
        {changeOperators ? t('condition.hintChanges') : t('condition.hint')}
      </p>
    </div>
  );
}
