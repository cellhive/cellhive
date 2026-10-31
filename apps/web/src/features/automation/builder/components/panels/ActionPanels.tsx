import {
  IF_VALUE_OPERATORS,
  MAX_FIND_FIELDS,
  MAX_FIND_RECORDS,
  MAX_FIND_SORTS,
  MAX_IF_CONDITIONS,
  type AutomationAction,
  type AutomationFieldValues,
  type AutomationDefinition,
  type AutomationValue,
} from '@cellhive/contracts';
import { Button, Input, Select, Tooltip } from '@cellhive/ui';
import { Plus, X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { conditionSlot } from '../../model/check';
import { asFieldId, asTableId, earlierActions, isUnset, NO_TABLE } from '../../model/draft';
import { issuesOf, type BuilderIssue, type StepKey } from '../../model/issues';
import { useBuilderEnv, useFields } from '../env';
import { FieldMapEditor } from '../values/FieldMapEditor';
import { ValueInput } from '../values/ValueInput';

import { IssueText, Note, PanelField, Segmented } from './common';

import type { ValueScope } from '../../model/scope';

/** Paths of the settings in an action (`errors[].path` below the step, CONTRACTS §21). */
const PATH = {
  table: 'config.table_id',
  fields: 'config.fields',
  record: 'config.record_id',
  filter: 'config.filter',
  sort: 'config.sort',
  limit: 'config.limit',
  match: 'config.match',
  conditions: 'config.conditions',
  onFalse: 'config.on_false',
} as const;

const DELETE_NOTE = 'delete-note';

/** The output path naming the record of a step (`find_records`: the first found). */
function recordPathOf(type: string): string {
  return type === 'find_records' ? 'records[0].id' : 'id';
}

function directionOf(value: string): 'asc' | 'desc' {
  return value === 'desc' ? 'desc' : 'asc';
}

type ActionOf<T extends AutomationAction['type']> = Extract<AutomationAction, { type: T }>;

export interface ActionPanelProps<T extends AutomationAction['type']> {
  readonly action: ActionOf<T>;
  readonly definition: AutomationDefinition;
  readonly scope: ValueScope;
  readonly onChange: (action: AutomationAction) => void;
}

/** Issues of a condition editor at `path`, relative to it. */
export function filterIssues(step: StepKey, path: string, issues: readonly BuilderIssue[]) {
  return issues
    .filter((issue) => issue.step === step && issue.path.startsWith(`${path}.`))
    .map((issue) => ({ path: issue.path.slice(path.length + 1), code: issue.code }));
}

export function TableSelect({
  step,
  value,
  onChange,
  label,
}: {
  readonly step: StepKey;
  readonly value: string;
  readonly onChange: (tableId: string) => void;
  readonly label: string;
}) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  return (
    <PanelField label={label} step={step} path={PATH.table}>
      {(control) => (
        <Select
          {...control}
          value={value}
          data-testid="action-table"
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="">{t('values.choose')}</option>
          {env.tables.map((table) => (
            <option key={table.id} value={table.id}>
              {table.name}
            </option>
          ))}
          {value !== '' && !env.tables.some((table) => table.id === value) ? (
            <option value={value}>{t('trigger.unknownTable')}</option>
          ) : null}
        </Select>
      )}
    </PanelField>
  );
}

/** `create_record` (SPEC §11.5): a table of the base and the values of its fields. */
export function CreateRecordPanel({ action, scope, onChange }: ActionPanelProps<'create_record'>) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const fields = useFields(isUnset(action.config.table_id) ? null : action.config.table_id);
  const step = action.id as StepKey;
  return (
    <div className="flex flex-col gap-4">
      <TableSelect
        step={step}
        label={t('action.createIn')}
        value={action.config.table_id}
        onChange={(tableId) => {
          onChange({ ...action, config: { table_id: asTableId(tableId), fields: {} } });
        }}
      />
      {isUnset(action.config.table_id) ? null : (
        <PanelField label={t('action.setValues')} step={step} path={PATH.fields} group>
          {() => (
            <FieldMapEditor
              step={step}
              path={PATH.fields}
              fields={fields}
              value={action.config.fields}
              scope={scope}
              issues={env.issues}
              onChange={(next: AutomationFieldValues) => {
                onChange({ ...action, config: { ...action.config, fields: next } });
              }}
            />
          )}
        </PanelField>
      )}
    </div>
  );
}

/** Which record `update_record` changes: the trigger record or the record of an earlier step. */
function recordChoice(action: ActionOf<'update_record'>): string {
  const target = action.config.record_id;
  if (target === null) return 'trigger';
  if ('step' in target) return `step:${target.step}`;
  return 'other';
}

/**
 * `update_record` (SPEC §11.5): the trigger record (`record_id: null`) or
 * the record of an earlier `create_record` / `update_record` /
 * `find_records` step, and the values of its fields.
 */
export function UpdateRecordPanel({
  action,
  definition,
  scope,
  onChange,
}: ActionPanelProps<'update_record'>) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const step = action.id as StepKey;
  const fields = useFields(isUnset(action.config.table_id) ? null : action.config.table_id);
  const steps = earlierActions(definition, action.id).filter(
    ({ action: earlier }) =>
      earlier.type === 'create_record' ||
      earlier.type === 'update_record' ||
      earlier.type === 'find_records',
  );
  const tableOfStep = (id: string) =>
    scope.steps.find((item) => item.id === id)?.tableId ?? NO_TABLE;
  const choice = recordChoice(action);
  return (
    <div className="flex flex-col gap-4">
      <PanelField label={t('action.record')} step={step} path={PATH.record}>
        {(control) => (
          <Select
            {...control}
            value={choice}
            data-testid="action-record"
            onChange={(event) => {
              const next = event.target.value;
              if (next === 'trigger') {
                onChange({
                  ...action,
                  config: {
                    table_id: scope.triggerTableId ?? NO_TABLE,
                    record_id: null,
                    fields: {},
                  },
                });
                return;
              }
              const id = next.slice('step:'.length);
              const earlier = steps.find((item) => item.action.id === id);
              if (earlier === undefined) return;
              const path = recordPathOf(earlier.action.type);
              onChange({
                ...action,
                config: { table_id: tableOfStep(id), record_id: { step: id, path }, fields: {} },
              });
            }}
          >
            {scope.triggerTableId === null ? null : (
              <option value="trigger">
                {t('action.triggerRecord', { table: env.tableName(scope.triggerTableId) ?? '' })}
              </option>
            )}
            {steps.map(({ action: earlier, number }) => (
              <option key={earlier.id} value={`step:${earlier.id}`}>
                {t('action.stepRecord', {
                  number,
                  type: t(`actionType.${earlier.type}` as 'actionType.if'),
                })}
              </option>
            ))}
            {choice === 'other' ? <option value="other">{t('action.otherRecord')}</option> : null}
            {choice === 'trigger' && scope.triggerTableId === null ? (
              <option value="trigger">{t('action.noTriggerRecord')}</option>
            ) : null}
          </Select>
        )}
      </PanelField>
      {isUnset(action.config.table_id) ? null : (
        <PanelField label={t('action.setValues')} step={step} path={PATH.fields} group>
          {() => (
            <FieldMapEditor
              step={step}
              path={PATH.fields}
              fields={fields}
              value={action.config.fields}
              scope={scope}
              issues={env.issues}
              onChange={(next) => {
                onChange({ ...action, config: { ...action.config, fields: next } });
              }}
            />
          )}
        </PanelField>
      )}
    </div>
  );
}

/** `delete_record` (SPEC §11.5): the trigger record goes to the trash (board: red note). */
export function DeleteRecordPanel({ scope }: { readonly scope: ValueScope }) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const table = scope.triggerTableId === null ? '' : (env.tableName(scope.triggerTableId) ?? '');
  return (
    <Note tone="danger" title={t('action.deleteTitle', { table })} testId={DELETE_NOTE}>
      {t('action.deleteBody')}
    </Note>
  );
}

/**
 * `find_records` (SPEC §11.5): a table, conditions (the view filter
 * builder), sort (≤ 5 keys), fields returned (empty = primary field) and
 * how many (≤ 200). Its output feeds later steps (`[act_…]`, `digest`).
 */
export function FindRecordsPanel({ action, onChange }: ActionPanelProps<'find_records'>) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const step = action.id as StepKey;
  const tableId = isUnset(action.config.table_id) ? null : action.config.table_id;
  const fields = useFields(tableId);
  const ConditionEditor = env.ConditionEditor;
  const config = action.config;
  const set = (patch: Partial<typeof config>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };
  const fieldsId = useId();
  return (
    <div className="flex flex-col gap-4">
      <TableSelect
        step={step}
        label={t('action.findIn')}
        value={config.table_id}
        onChange={(next) => {
          onChange({
            ...action,
            config: {
              table_id: asTableId(next),
              filter: null,
              sort: [],
              fields: [],
              limit: config.limit,
            },
          });
        }}
      />
      {tableId === null ? null : (
        <>
          <ConditionEditor
            key={`${tableId}:${String(env.resetKey)}`}
            tableId={tableId}
            orgId={env.orgId}
            value={config.filter}
            nested
            issues={filterIssues(step, PATH.filter, env.issues)}
            label={t('action.findWhere')}
            emptyText={t('action.findAll')}
            onChange={(state) => {
              env.setConditionState(conditionSlot(step, PATH.filter), state);
              set({ filter: state.filter });
            }}
          />
          <PanelField label={t('action.sort')} step={step} path={PATH.sort} group>
            {() => (
              <div className="flex flex-col gap-1.5">
                {config.sort.map((key, index) => (
                  <div key={`${key.field}-${String(index)}`} className="flex items-center gap-1">
                    <Select
                      aria-label={t('action.sortField', { index: index + 1 })}
                      value={key.field}
                      onChange={(event) => {
                        const sort = config.sort.map((item, position) =>
                          position === index
                            ? { ...item, field: asFieldId(event.target.value) }
                            : item,
                        );
                        set({ sort });
                      }}
                    >
                      {fields.map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                    </Select>
                    <Select
                      className="w-36"
                      aria-label={t('action.sortDirection', { index: index + 1 })}
                      value={key.direction}
                      onChange={(event) => {
                        const direction = directionOf(event.target.value);
                        set({
                          sort: config.sort.map((item, position) =>
                            position === index ? { ...item, direction } : item,
                          ),
                        });
                      }}
                    >
                      <option value="asc">{t('action.asc')}</option>
                      <option value="desc">{t('action.desc')}</option>
                    </Select>
                    <Tooltip content={t('action.sortRemove', { index: index + 1 })}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 max-lg:size-control"
                        aria-label={t('action.sortRemove', { index: index + 1 })}
                        onClick={() => {
                          set({ sort: config.sort.filter((_, position) => position !== index) });
                        }}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </Tooltip>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start max-lg:h-control"
                  disabled={config.sort.length >= MAX_FIND_SORTS || fields.length === 0}
                  onClick={() => {
                    const first = fields[0];
                    if (first !== undefined) {
                      set({ sort: [...config.sort, { field: first.id, direction: 'asc' }] });
                    }
                  }}
                >
                  <Plus aria-hidden="true" />
                  {t('action.sortAdd')}
                </Button>
              </div>
            )}
          </PanelField>
          <PanelField
            label={t('action.returnFields')}
            step={step}
            path={PATH.fields}
            hint={t('action.returnFieldsHint', { max: MAX_FIND_FIELDS })}
            group
          >
            {() => (
              <ul
                id={fieldsId}
                className="flex max-h-48 flex-col overflow-y-auto rounded-md border border-line-control py-1"
              >
                {fields.map((field) => (
                  <li key={field.id}>
                    <label className="flex min-h-8 items-center gap-2 px-2.5 text-body max-lg:min-h-control">
                      <input
                        type="checkbox"
                        checked={config.fields.includes(field.id)}
                        disabled={
                          !config.fields.includes(field.id) &&
                          config.fields.length >= MAX_FIND_FIELDS
                        }
                        onChange={(event) => {
                          set({
                            fields: event.target.checked
                              ? [...config.fields, field.id]
                              : config.fields.filter((id) => id !== field.id),
                          });
                        }}
                      />
                      {field.name}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </PanelField>
          <PanelField
            label={t('action.limit')}
            step={step}
            path={PATH.limit}
            hint={t('action.limitHint', { max: MAX_FIND_RECORDS })}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                max={MAX_FIND_RECORDS}
                className="w-28"
                value={String(config.limit)}
                onChange={(event) => {
                  const next = event.target.valueAsNumber;
                  if (Number.isInteger(next)) {
                    set({ limit: Math.min(MAX_FIND_RECORDS, Math.max(1, next)) });
                  }
                }}
              />
            )}
          </PanelField>
        </>
      )}
    </div>
  );
}

const NO_COMPARE = new Set(['is_empty', 'is_not_empty']);

/**
 * `if` (SPEC §11.3; board "Nếu / Ngược lại"): all or any of up to 10
 * conditions — conditions on the latest trigger record (filter builder) or
 * comparisons of two values — and what happens when they do not hold: run
 * the "false" branch, or stop the run (it ends as succeeded).
 */
export function IfPanel({ action, scope, onChange }: ActionPanelProps<'if'>) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const step = action.id as StepKey;
  const config = action.config;
  const ConditionEditor = env.ConditionEditor;
  const set = (patch: Partial<typeof config>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };
  const setCondition = (index: number, next: (typeof config.conditions)[number] | null) => {
    const conditions = config.conditions.flatMap((item, position) =>
      position === index ? (next === null ? [] : [next]) : [item],
    );
    set({ conditions });
  };
  const full = config.conditions.length >= MAX_IF_CONDITIONS;
  return (
    <div className="flex flex-col gap-4">
      <PanelField label={t('if.match')} step={step} path={PATH.match}>
        {(control) => (
          <Select
            {...control}
            value={config.match}
            onChange={(event) => {
              set({ match: event.target.value === 'or' ? 'or' : 'and' });
            }}
          >
            <option value="and">{t('if.all')}</option>
            <option value="or">{t('if.any')}</option>
          </Select>
        )}
      </PanelField>
      <PanelField label={t('if.conditions')} step={step} path={PATH.conditions} group>
        {() => (
          <ol className="flex flex-col gap-3">
            {config.conditions.map((condition, index) => {
              const path = `config.conditions[${String(index)}]`;
              if ('filter' in condition) {
                return (
                  <li
                    key={`filter-${String(index)}`}
                    className="flex flex-col gap-1 rounded-md border border-line p-2"
                  >
                    <ConditionHeader
                      text={t('if.recordCondition', { index: index + 1 })}
                      onRemove={() => {
                        env.setConditionState(conditionSlot(step, `${path}.filter`), null);
                        setCondition(index, null);
                      }}
                    />
                    {scope.triggerTableId === null ? (
                      <Note tone="warning">{t('if.noRecord')}</Note>
                    ) : (
                      <ConditionEditor
                        key={`${scope.triggerTableId}:${String(index)}:${String(env.resetKey)}`}
                        tableId={scope.triggerTableId}
                        orgId={env.orgId}
                        value={Object.keys(condition.filter).length === 0 ? null : condition.filter}
                        issues={filterIssues(step, `${path}.filter`, env.issues)}
                        label={t('if.recordWhere')}
                        emptyText={t('if.recordEmpty')}
                        onChange={(state) => {
                          env.setConditionState(conditionSlot(step, `${path}.filter`), state);
                          setCondition(index, { filter: state.filter ?? {} });
                        }}
                      />
                    )}
                    <ConditionIssues step={step} path={`${path}.filter`} />
                  </li>
                );
              }
              return (
                <li
                  key={`value-${String(index)}`}
                  className="flex flex-col gap-1.5 rounded-md border border-line p-2"
                  data-testid="if-value-condition"
                >
                  <ConditionHeader
                    text={t('if.valueCondition', { index: index + 1 })}
                    onRemove={() => {
                      setCondition(index, null);
                    }}
                  />
                  <ValueInput
                    value={condition.value}
                    onChange={(value) => {
                      setCondition(index, { ...condition, value: value ?? { literal: null } });
                    }}
                    field={null}
                    allowTemplate={false}
                    scope={scope}
                    label={t('if.left', { index: index + 1 })}
                  />
                  <Select
                    aria-label={t('if.operator', { index: index + 1 })}
                    value={condition.operator}
                    onChange={(event) => {
                      const operator = event.target.value as (typeof IF_VALUE_OPERATORS)[number];
                      setCondition(index, {
                        ...condition,
                        operator,
                        compare: NO_COMPARE.has(operator) ? null : condition.compare,
                      });
                    }}
                  >
                    {IF_VALUE_OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {t(`if.operators.${operator}`)}
                      </option>
                    ))}
                  </Select>
                  {NO_COMPARE.has(condition.operator) ? null : (
                    <ValueInput
                      value={condition.compare ?? undefined}
                      onChange={(compare: AutomationValue | undefined) => {
                        setCondition(index, { ...condition, compare: compare ?? null });
                      }}
                      field={null}
                      allowTemplate={false}
                      scope={scope}
                      label={t('if.right', { index: index + 1 })}
                    />
                  )}
                  <ConditionIssues step={step} path={path} />
                </li>
              );
            })}
          </ol>
        )}
      </PanelField>
      <div className="flex flex-wrap gap-1">
        <Button
          variant="secondary"
          size="sm"
          className="max-lg:h-control"
          disabled={full || scope.triggerTableId === null}
          data-testid="if-add-record-condition"
          onClick={() => {
            set({ conditions: [...config.conditions, { filter: {} }] });
          }}
        >
          <Plus aria-hidden="true" />
          {t('if.addRecord')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="max-lg:h-control"
          disabled={full}
          onClick={() => {
            set({
              conditions: [
                ...config.conditions,
                { value: { literal: null }, operator: 'is_not_empty', compare: null },
              ],
            });
          }}
        >
          <Plus aria-hidden="true" />
          {t('if.addValue')}
        </Button>
      </div>
      <PanelField label={t('if.otherwise')} step={step} path={PATH.onFalse} group>
        {() => (
          <Segmented
            label={t('if.otherwise')}
            value={config.on_false}
            options={[
              { value: 'else', label: t('if.runElse') },
              { value: 'stop', label: t('if.stop') },
            ]}
            onChange={(on_false) => {
              set({ on_false });
            }}
          />
        )}
      </PanelField>
      {config.on_false === 'stop' ? <Note>{t('if.stopNote')}</Note> : null}
    </div>
  );
}

function ConditionHeader({
  text,
  onRemove,
}: {
  readonly text: string;
  readonly onRemove: () => void;
}) {
  const { t } = useTranslation('automationBuilder');
  return (
    <div className="flex items-center gap-1">
      <span className="min-w-0 flex-1 text-label text-fg-muted">{text}</span>
      <Tooltip content={t('if.remove', { text })}>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 max-lg:size-control"
          aria-label={t('if.remove', { text })}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}

function ConditionIssues({ step, path }: { readonly step: StepKey; readonly path: string }) {
  const env = useBuilderEnv();
  const id = useId();
  const issues = issuesOf(env.issues, step).filter((issue) => issue.path === path);
  return <IssueText id={id} issues={issues} />;
}

/**
 * A step of a type the builder cannot edit yet (BACKLOG T521): `update_records`
 * and `delay` until T506, the send steps until T514–T516 (editors T522). It
 * stays in the flow (the server keeps it) and can be removed.
 */
export function ComingSoonPanel({ type }: { readonly type: AutomationAction['type'] }) {
  const { t } = useTranslation('automationBuilder');
  return (
    <Note
      tone="warning"
      title={t('comingSoon.title', { type: t(`actionType.${type}` as 'actionType.if') })}
    >
      {t('comingSoon.body')}
    </Note>
  );
}
