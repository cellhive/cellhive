import {
  type AutomationDefinition,
  type AutomationTrigger,
  type AutomationTriggerType,
} from '@cellhive/contracts';
import { Select, Skeleton, Switch } from '@cellhive/ui';
import { lazy, Suspense, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { canManageAutomations, isBaseAdmin } from '../../../../../lib/permissions/access';
import { conditionSlot } from '../../model/check';
import {
  asTableId,
  asViewId,
  BUILDER_TRIGGER_TYPES,
  hasOutboundAction,
  hasTriggerRecord,
  isUnset,
  NO_FIELD,
  NO_TABLE,
  switchTrigger,
  triggerNeedsTable,
  type TableId,
} from '../../model/draft';
import { issuesAt } from '../../model/issues';
import { triggerDataOf } from '../../model/values';
import { WEBHOOK_PARTS } from '../../triggers/webhook/model';
import { useBuilderEnv, useFields } from '../env';
import { Chip } from '../values/chips';

import { ButtonTriggerEditor } from './ButtonTriggerEditor';
import { IssueText, Note, PanelField } from './common';
import { ScheduleEditor } from './ScheduleEditor';
import { DateReachedEditor, isVirtual, WatchFieldsEditor } from './trigger-fields';

/** (T612) Hook, URL and sample listening: its own chunk, loaded with the trigger. */
const WebhookTriggerEditor = lazy(() => import('../../triggers/webhook/WebhookTriggerEditor'));

/** Paths of the trigger's settings (`errors[].path` below `definition.trigger`). */
const PATH = {
  type: 'type',
  table: 'table_id',
  condition: 'condition',
  view: 'view_id',
} as const;

const TRIGGER = 'trigger';

/** The trigger on another table: what named fields of the old one starts over. */
function withTable(trigger: AutomationTrigger, tableId: TableId): AutomationTrigger {
  switch (trigger.type) {
    case 'record.updated':
      return { ...trigger, table_id: tableId, watch_fields: [] };
    case 'record.matches':
      return { ...trigger, table_id: tableId, condition: {} };
    case 'record.date_reached':
    case 'button.clicked':
      return { ...trigger, table_id: tableId, field_id: NO_FIELD };
    case 'record.created':
    case 'record.deleted':
      return { ...trigger, table_id: tableId };
    default:
      return trigger;
  }
}

/** Why a trigger type cannot be chosen (`null`: it can). Both are base admins only (ADR-25 §3). */
function unavailable(type: AutomationTriggerType, admin: boolean): 'schedule' | 'webhook' | null {
  if (type === 'schedule' && !admin) return 'schedule';
  if (type === 'webhook.received' && !admin) return 'webhook';
  return null;
}

export interface TriggerPanelProps {
  readonly definition: AutomationDefinition;
  readonly onChange: (trigger: AutomationTrigger) => void;
}

/**
 * The trigger's settings (SPEC §11.2; boards "S5 · Automation builder",
 * "… - trigger và điều kiện"): type, table (only tables the caller manages,
 * ADR-25 §3), and by type the watched fields, the condition of
 * `record.matches`, the form, the schedule, the date — plus `skip_bulk`,
 * suggested when a step sends outside (ADR-26 §3), and the trigger data
 * later steps may use.
 */
export function TriggerPanel({ definition, onChange }: TriggerPanelProps) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const trigger = definition.trigger;
  const admin = isBaseAdmin(env.base.access);
  const managed = env.tables.filter((table) => canManageAutomations(env.base.access, table.id));
  const tableId = 'table_id' in trigger ? trigger.table_id : null;
  const fields = useFields(isUnset(tableId) ? null : tableId);
  const virtual = useMemo(
    () => new Set(fields.filter(isVirtual).map((field) => field.id)),
    [fields],
  );
  const bulkId = useId();
  const ConditionEditor = env.ConditionEditor;

  return (
    <div className="flex flex-col gap-4" data-testid="trigger-panel">
      <PanelField label={t('trigger.type')} step={TRIGGER} path={PATH.type}>
        {(control) => (
          <Select
            {...control}
            value={trigger.type}
            data-testid="trigger-type"
            onChange={(event) => {
              const type = event.target.value as AutomationTriggerType;
              onChange(switchTrigger(trigger, type, managed[0]?.id ?? NO_TABLE));
            }}
          >
            {BUILDER_TRIGGER_TYPES.map((type) => {
              const reason = unavailable(type, admin);
              return (
                <option key={type} value={type} disabled={reason !== null && type !== trigger.type}>
                  {reason === null
                    ? t(`triggerType.${type}`)
                    : t('trigger.unavailableOption', {
                        type: t(`triggerType.${type}`),
                        reason: t(`trigger.unavailable.${reason}`),
                      })}
                </option>
              );
            })}
          </Select>
        )}
      </PanelField>

      {triggerNeedsTable(trigger.type) && 'table_id' in trigger ? (
        <PanelField label={t('trigger.table')} step={TRIGGER} path={PATH.table}>
          {(control) => (
            <Select
              {...control}
              value={trigger.table_id}
              data-testid="trigger-table"
              onChange={(event) => {
                onChange(withTable(trigger, asTableId(event.target.value)));
              }}
            >
              <option value="">{t('values.choose')}</option>
              {managed.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.name}
                </option>
              ))}
              {!isUnset(trigger.table_id) &&
              !managed.some((table) => table.id === trigger.table_id) ? (
                <option value={trigger.table_id}>
                  {env.tableName(trigger.table_id) ?? t('trigger.unknownTable')}
                </option>
              ) : null}
            </Select>
          )}
        </PanelField>
      ) : null}

      {trigger.type === 'record.updated' && !isUnset(trigger.table_id) ? (
        <WatchFieldsEditor trigger={trigger} onChange={onChange} />
      ) : null}

      {trigger.type === 'record.matches' && !isUnset(trigger.table_id) ? (
        <>
          <ConditionEditor
            key={`${trigger.table_id}:${String(env.resetKey)}`}
            tableId={trigger.table_id}
            orgId={env.orgId}
            value={Object.keys(trigger.condition).length === 0 ? null : trigger.condition}
            excludeFields={virtual}
            issues={issuesAt(env.issues, TRIGGER, PATH.condition).map((issue) => ({
              path: issue.path.replace(/^condition\.?/u, ''),
              code: issue.code,
            }))}
            label={t('trigger.matchLabel')}
            emptyText={t('trigger.matchEmpty')}
            onChange={(state) => {
              env.setConditionState(conditionSlot(TRIGGER, PATH.condition), state);
              onChange({ ...trigger, condition: state.filter ?? {} });
            }}
          />
          <IssueLine path={PATH.condition} />
          <Note>{t('trigger.matchNote')}</Note>
        </>
      ) : null}

      {trigger.type === 'form.submitted' ? (
        <PanelField label={t('trigger.form')} step={TRIGGER} path={PATH.view}>
          {(control) =>
            env.forms.length === 0 ? (
              <p className="text-label font-normal text-fg-muted">{t('trigger.noForms')}</p>
            ) : (
              <Select
                {...control}
                value={trigger.view_id}
                data-testid="trigger-form"
                onChange={(event) => {
                  onChange({ ...trigger, view_id: asViewId(event.target.value) });
                }}
              >
                <option value="">{t('values.choose')}</option>
                {env.forms.map((view) => (
                  <option key={view.id} value={view.id}>
                    {`${env.tableName(view.table_id) ?? ''} · ${view.name}`}
                  </option>
                ))}
              </Select>
            )
          }
        </PanelField>
      ) : null}

      {trigger.type === 'schedule' ? (
        <ScheduleEditor trigger={trigger} onChange={onChange} />
      ) : null}

      {trigger.type === 'record.date_reached' && !isUnset(trigger.table_id) ? (
        <DateReachedEditor trigger={trigger} onChange={onChange} />
      ) : null}

      {trigger.type === 'button.clicked' && !isUnset(trigger.table_id) ? (
        <ButtonTriggerEditor trigger={trigger} onChange={onChange} />
      ) : null}

      {trigger.type === 'webhook.received' ? (
        <Suspense fallback={<Skeleton className="h-24" />}>
          <WebhookTriggerEditor trigger={trigger} onChange={onChange} />
        </Suspense>
      ) : null}

      {'skip_bulk' in trigger ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <Switch
              id={bulkId}
              checked={trigger.skip_bulk}
              data-testid="trigger-skip-bulk"
              onChange={(event) => {
                onChange({ ...trigger, skip_bulk: event.target.checked });
              }}
            />
            <label htmlFor={bulkId} className="text-body font-medium">
              {t('trigger.skipBulk')}
            </label>
          </div>
          <p className="text-label font-normal text-fg-muted">{t('trigger.skipBulkHint')}</p>
          {hasOutboundAction(definition) && !trigger.skip_bulk ? (
            <Note>{t('trigger.skipBulkSuggest')}</Note>
          ) : null}
        </div>
      ) : null}

      <section className="flex flex-col gap-1.5" aria-label={t('trigger.data')}>
        <h3 className="text-label text-fg">{t('trigger.data')}</h3>
        <div className="flex flex-wrap gap-1.5">
          {hasTriggerRecord(trigger) ? <Chip name={{ tone: 'trigger', record: '@id' }} /> : null}
          {trigger.type === 'webhook.received'
            ? WEBHOOK_PARTS.map((part) => (
                <Chip key={part} name={{ tone: 'trigger', webhook: part }} />
              ))
            : null}
          {triggerDataOf(trigger.type).map((data) => (
            <Chip key={data} name={{ tone: 'trigger', data }} />
          ))}
          {trigger.type === 'record.updated' ? (
            <Chip name={{ tone: 'trigger', previous: t('trigger.previousAny') }} />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function IssueLine({ path }: { readonly path: string }) {
  const env = useBuilderEnv();
  const issues = issuesAt(env.issues, 'trigger', path).filter((issue) => issue.path === path);
  const id = useId();
  if (issues.length === 0) return null;
  return <IssueText id={id} issues={issues} />;
}
