import { Select } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { isBaseAdmin } from '../../../../../lib/permissions/access';
import { rolesQuery } from '../../../../../lib/query/roles';
import { fieldsHiddenFromReaders, filterFieldIds } from '../../model/button-readers';
import { conditionSlot } from '../../model/check';
import { asFieldId, isUnset } from '../../model/draft';
import { issuesAt } from '../../model/issues';
import { useBuilderEnv, useFields } from '../env';

import { IssueText, Note, PanelField } from './common';
import { isVirtual } from './trigger-fields';

import type { AutomationTrigger } from '@cellhive/contracts';

type ButtonTrigger = Extract<AutomationTrigger, { type: 'button.clicked' }>;

const TRIGGER = 'trigger';
const PATH = {
  field: 'field_id',
  permission: 'min_permission',
  when: 'enabled_when',
} as const;
const PERMISSIONS = ['edit', 'read'] as const;
const READ_WARNING = 'button-read-warning';
const HIDDEN_FIELDS = 'button-hidden-fields';

/**
 * `button.clicked` (T525; ADR-32 §2, CONTRACTS §21 "Button"; board "S5 ·
 * Automation builder - trigger và điều kiện"): the button field (one
 * automation per button — buttons another automation runs are listed
 * disabled, `BUTTON_IN_USE`), who may click (`min_permission`, edited
 * here only: changing it moves `run_as`, Quyết định S5 thiết kế #8) with the
 * warning of `read`, and when the button is enabled (`enabled_when`,
 * evaluated as `run_as`). With `read`, fields of the condition some roles
 * cannot read are named: their people can infer the condition from the
 * button's state (Câu hỏi mở S5 #5).
 */
export function ButtonTriggerEditor({
  trigger,
  onChange,
}: {
  readonly trigger: ButtonTrigger;
  readonly onChange: (trigger: ButtonTrigger) => void;
}) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const fields = useFields(isUnset(trigger.table_id) ? null : trigger.table_id);
  const buttons = fields.filter((field) => field.type === 'button');
  const virtual = useMemo(
    () => new Set(fields.filter(isVirtual).map((field) => field.id)),
    [fields],
  );
  const conditionIssuesId = useId();
  const ConditionEditor = env.ConditionEditor;
  const read = trigger.min_permission === 'read';
  const admin = isBaseAdmin(env.base.access);
  // Roles are for base admins only (others get 404): table managers see the general warning.
  const roles = useQuery({ ...rolesQuery(env.base.id), enabled: read && admin });
  const usedFields = filterFieldIds(trigger.enabled_when);
  const hidden =
    read && roles.data !== undefined
      ? fieldsHiddenFromReaders(roles.data.items, trigger.table_id, usedFields)
      : new Map<string, string[]>();
  const fieldName = (id: string) => fields.find((field) => field.id === id)?.name ?? id;
  const runAs = env.runAsName ?? t('trigger.button.runAsYou');
  const conditionIssues = issuesAt(env.issues, TRIGGER, PATH.when);

  return (
    <div className="flex flex-col gap-4" data-testid="button-trigger">
      <PanelField label={t('trigger.button.field')} step={TRIGGER} path={PATH.field}>
        {(control) =>
          buttons.length === 0 ? (
            <p className="text-label font-normal text-fg-muted">{t('trigger.button.noField')}</p>
          ) : (
            <Select
              {...control}
              value={trigger.field_id}
              data-testid="trigger-button-field"
              onChange={(event) => {
                onChange({ ...trigger, field_id: asFieldId(event.target.value) });
              }}
            >
              <option value="">{t('values.choose')}</option>
              {buttons.map((field) => {
                const other =
                  field.button?.automation_id != null &&
                  field.button.automation_id !== env.automationId &&
                  field.id !== trigger.field_id;
                return (
                  <option key={field.id} value={field.id} disabled={other}>
                    {other ? t('trigger.button.inUse', { name: field.name }) : field.name}
                  </option>
                );
              })}
            </Select>
          )
        }
      </PanelField>

      <PanelField label={t('trigger.button.who')} step={TRIGGER} path={PATH.permission} group>
        {() => (
          <div className="flex flex-col gap-2" data-testid="trigger-button-permission">
            {PERMISSIONS.map((value) => (
              <label
                key={value}
                className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line px-3 py-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
              >
                <input
                  type="radio"
                  name={`${env.automationId ?? 'new'}-min-permission`}
                  value={value}
                  checked={trigger.min_permission === value}
                  className="mt-0.5 size-4 shrink-0 accent-accent"
                  onChange={() => {
                    onChange({ ...trigger, min_permission: value });
                  }}
                />
                <span className="flex flex-col">
                  <span className="text-body font-medium">
                    {t(`trigger.button.permission.${value}`)}
                  </span>
                  <span className="text-label font-normal text-fg-muted">
                    {t(`trigger.button.permissionHint.${value}`)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </PanelField>
      {read ? (
        <Note tone="warning" testId={READ_WARNING}>
          <strong className="font-medium">
            {t('trigger.button.readWarning', { name: runAs })}
          </strong>{' '}
          {t('trigger.button.readAdvice')}
        </Note>
      ) : null}

      {isUnset(trigger.table_id) ? null : (
        <>
          <ConditionEditor
            key={`${trigger.table_id}:${String(env.resetKey)}`}
            tableId={trigger.table_id}
            orgId={env.orgId}
            value={trigger.enabled_when}
            excludeFields={virtual}
            issues={conditionIssues.map((issue) => ({
              path: issue.path.replace(/^enabled_when\.?/u, ''),
              code: issue.code,
            }))}
            label={t('trigger.button.when')}
            emptyText={t('trigger.button.whenEmpty')}
            onChange={(state) => {
              env.setConditionState(conditionSlot(TRIGGER, PATH.when), state);
              onChange({ ...trigger, enabled_when: state.filter });
            }}
          />
          <IssueText
            id={conditionIssuesId}
            issues={conditionIssues.filter((issue) => issue.path === PATH.when)}
          />
          {read && usedFields.length > 0 && (hidden.size > 0 || roles.isError || !admin) ? (
            <Note tone="warning" testId={HIDDEN_FIELDS}>
              {hidden.size > 0
                ? t('trigger.button.hiddenFields', {
                    fields: [...hidden.keys()].map(fieldName).join(', '),
                    roles: [...new Set([...hidden.values()].flat())].join(', '),
                  })
                : t('trigger.button.inferable')}
            </Note>
          ) : null}
        </>
      )}
    </div>
  );
}
