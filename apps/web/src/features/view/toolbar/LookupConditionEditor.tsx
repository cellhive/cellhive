import { Button, cn, Select } from '@cellhive/ui';
import { Plus, X } from 'lucide-react';
import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  conditionFields,
  constantAllowed,
  isComplete,
  linksTo,
  lookupFilterMeta,
  lookupOperators,
  MAX_LOOKUP_CONDITIONS,
  newCondition,
  RECORD_FIELD_ID,
  recordIdField,
  operatorLabelKey,
  refAllowed,
  refChoices,
  THIS_RECORD_REF,
  withOperator,
  type LookupConditionDraft,
} from '../../../lib/schema/lookup-where';

import { ValueEditor } from './ValueEditor';

import type { LookupWhereEditorProps } from '../../../lib/schema/lookup-tools';
import type { FieldDto } from '@cellhive/contracts';
import type { DslOperator } from '@cellhive/filter-dsl';

/** `<select>` value of the "fixed value" choice (field ids never look like this). */
const CONSTANT = '$constant';
/** `<select>` value of a reference not chosen yet. */
const UNSET = '';

/**
 * A computed source field compares by its result (`lookupFilterMeta`): the
 * T311 value editors see it as a field of that type.
 */
function asValueField(field: FieldDto): FieldDto {
  const meta = lookupFilterMeta(field);
  return meta.resultType === undefined ? field : { ...field, type: meta.resultType, options: {} };
}

interface RowProps extends LookupWhereEditorProps {
  readonly condition: LookupConditionDraft;
  readonly index: number;
  readonly fields: readonly FieldDto[];
  readonly onRemove: () => void;
  readonly onUpdate: (condition: LookupConditionDraft) => void;
}

function ConditionRow({
  condition,
  index,
  fields,
  currentFields,
  currentTableId,
  currentTableName,
  orgId,
  issues,
  showIncomplete,
  onRemove,
  onUpdate,
}: RowProps) {
  const { t } = useTranslation(['lookup', 'toolbar']);
  const messageId = useId();
  const field = fields.find((candidate) => candidate.id === condition.field);
  const position = index + 1;
  const fieldName = field?.name ?? t('lookup:conditions.fieldUnknown');
  const issue = issues.get(condition.key);
  const incomplete = showIncomplete && !isComplete(condition, field);
  const message = issue ?? (incomplete ? t('lookup:conditions.incomplete') : undefined);
  const describedBy = message === undefined ? undefined : messageId;
  const operators = field === undefined ? [] : lookupOperators(field, condition.operator);
  const canRef = field !== undefined && refAllowed(field, condition.operator);
  const canConstant = field === undefined || constantAllowed(field);
  const refs =
    field === undefined ? { record: false, fields: [] } : refChoices(field, currentFields);
  const sourceValue =
    condition.value.kind === 'ref'
      ? condition.value.ref === ''
        ? UNSET
        : condition.value.ref
      : CONSTANT;
  const showSource = canRef && operators.length > 0;
  const showConstant =
    field !== undefined && condition.value.kind === 'constant' && canConstant && !!operators.length;

  return (
    <li className="flex flex-col gap-1" data-testid="lookup-condition">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1.15fr)_auto]">
        <Select
          aria-label={t('lookup:conditions.field', { position })}
          aria-invalid={message !== undefined || undefined}
          aria-describedby={describedBy}
          value={condition.field}
          onChange={(event) => {
            const next = fields.find((candidate) => candidate.id === event.currentTarget.value);
            if (next === undefined) return;
            const fresh = newCondition(next, currentTableId);
            // A record ID condition starts on the first link of this table to the source.
            const first = refChoices(next, currentFields).fields[0];
            onUpdate({
              ...fresh,
              key: condition.key,
              ...(fresh.value.kind === 'ref' && fresh.value.ref === '' && first !== undefined
                ? { value: { kind: 'ref', ref: first.id } }
                : {}),
            });
          }}
        >
          {field === undefined ? <option value={condition.field}>{fieldName}</option> : null}
          {fields.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t('toolbar:filter.operator', { field: fieldName })}
          aria-describedby={describedBy}
          value={condition.operator}
          disabled={field === undefined}
          onChange={(event) => {
            if (field === undefined) return;
            onUpdate(
              withOperator(
                condition,
                field,
                event.currentTarget.value as DslOperator,
                currentTableId,
              ),
            );
          }}
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {t(`toolbar:filter.operators.${operatorLabelKey(field, operator)}`)}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="order-3 sm:order-4"
          aria-label={t('lookup:conditions.remove', { position, field: fieldName })}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </Button>
        {showSource ? (
          <Select
            className="order-4 col-span-3 sm:order-3 sm:col-span-1"
            aria-label={t('lookup:conditions.valueSource', { field: fieldName })}
            aria-invalid={message !== undefined || undefined}
            aria-describedby={describedBy}
            value={sourceValue}
            data-testid="lookup-condition-value"
            onChange={(event) => {
              const next = event.currentTarget.value;
              onUpdate({
                ...condition,
                auto: false,
                value: next === CONSTANT ? { kind: 'constant' } : { kind: 'ref', ref: next },
              });
            }}
          >
            {canConstant ? (
              <option value={CONSTANT}>{t('lookup:conditions.constant')}</option>
            ) : (
              <option value={UNSET} disabled>
                {t('lookup:conditions.chooseRef')}
              </option>
            )}
            <optgroup label={t('lookup:conditions.thisTable', { table: currentTableName })}>
              {refs.record ? (
                <option value={THIS_RECORD_REF}>{t('lookup:conditions.thisRecord')}</option>
              ) : null}
              {refs.fields.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </optgroup>
          </Select>
        ) : (
          <span className="order-4 hidden sm:order-3 sm:block" />
        )}
      </div>
      {showConstant ? (
        <div className="flex min-w-0 flex-wrap items-start gap-1">
          <ValueEditor
            field={asValueField(field)}
            operator={condition.operator}
            value={condition.value.value}
            orgId={orgId}
            label={t('toolbar:filter.value', { field: fieldName })}
            invalid={message !== undefined}
            userVariables={false}
            onChange={(value) => {
              onUpdate({
                ...condition,
                auto: false,
                value: value === undefined ? { kind: 'constant' } : { kind: 'constant', value },
              });
            }}
          />
        </div>
      ) : null}
      {condition.auto === true && condition.value.kind === 'ref' ? (
        <p className="flex flex-wrap items-center gap-1.5 text-label font-normal text-fg-muted">
          <span className="inline-flex h-5 items-center rounded-sm bg-option-5 px-2 text-label text-on-option-5">
            {t('lookup:conditions.auto')}
          </span>
          {condition.field === RECORD_FIELD_ID
            ? t('lookup:conditions.recordHint', {
                field:
                  currentFields.find(
                    (item) => condition.value.kind === 'ref' && item.id === condition.value.ref,
                  )?.name ?? '',
              })
            : t('lookup:conditions.autoHint', { table: currentTableName })}
        </p>
      ) : null}
      {message === undefined ? null : (
        <p id={messageId} className="text-label font-normal text-danger">
          {message}
        </p>
      )}
    </li>
  );
}

/**
 * Conditions of a lookup field (T467, board "S4b · Cấu hình tra cứu"): one
 * level, all / any, 1–5 conditions on the source table's fields; values
 * with the view filter's editors (T311) or a field of this table
 * (`field_ref`, "This record"). Only native controls: usable with the
 * keyboard and screen readers.
 */
export function LookupConditionEditor(props: LookupWhereEditorProps) {
  const { t } = useTranslation(['lookup', 'toolbar']);
  const { value, onChange, sourceFields, currentTableId, issues, labelledBy } = props;
  const matchId = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const sourceTableId = sourceFields[0]?.table_id;
  // The source record itself, compared with a link of this table (one-way links, CONTRACTS §13).
  const recordField =
    sourceTableId === undefined || linksTo(props.currentFields, sourceTableId).length === 0
      ? []
      : [
          recordIdField(
            sourceTableId,
            t('lookup:conditions.recordOf', { table: props.sourceTableName ?? '' }),
          ),
        ];
  const fields = [...recordField, ...conditionFields(sourceFields)];
  const count = value.conditions.length;
  const full = count >= MAX_LOOKUP_CONDITIONS;
  const general = issues.get('');

  const update = (key: string, condition: LookupConditionDraft) => {
    onChange({
      ...value,
      conditions: value.conditions.map((item) => (item.key === key ? condition : item)),
    });
  };
  const remove = (index: number) => {
    const conditions = value.conditions.filter((_, position) => position !== index);
    onChange({ ...value, conditions });
    // Focus the next row's first control, else the add button.
    window.requestAnimationFrame(() => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>('li select');
      const next = rows === undefined ? undefined : rows[Math.min(index, conditions.length - 1)];
      (conditions.length === 0 || next === undefined ? addRef.current : next)?.focus();
    });
  };

  const add = () => {
    // A new condition starts on the field of the last one (Lark), else the first field.
    const last = fields.find((field) => field.id === value.conditions.at(-1)?.field);
    const field = last ?? fields[0];
    if (field === undefined) return;
    onChange({ ...value, conditions: [...value.conditions, newCondition(field, currentTableId)] });
    window.requestAnimationFrame(() => {
      listRef.current?.lastElementChild?.querySelector<HTMLElement>('select')?.focus();
    });
  };

  if (value.advanced !== undefined && count === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <p className="text-body text-fg-muted">{t('lookup:conditions.advanced')}</p>
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const first = fields[0];
              onChange({
                op: 'and',
                conditions: first === undefined ? [] : [newCondition(first, currentTableId)],
              });
            }}
          >
            {t('lookup:conditions.replaceAdvanced')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border border-line p-2.5',
        general !== undefined && 'border-danger',
      )}
      onKeyDown={(event) => {
        // Enter in a value box must not submit the field dialog around it.
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-label font-normal text-fg">
        <span id={matchId}>{t('lookup:conditions.matchBefore')}</span>
        <Select
          className="w-auto min-w-28"
          aria-labelledby={`${matchId} ${labelledBy}`}
          value={value.op}
          onChange={(event) => {
            onChange({ ...value, op: event.currentTarget.value === 'or' ? 'or' : 'and' });
          }}
        >
          <option value="and">{t('lookup:conditions.all')}</option>
          <option value="or">{t('lookup:conditions.any')}</option>
        </Select>
        <span>{t('lookup:conditions.matchAfter')}</span>
      </div>
      {fields.length === 0 ? (
        <p className="text-body text-fg-muted">{t('lookup:conditions.noFields')}</p>
      ) : null}
      <ol ref={listRef} aria-labelledby={labelledBy} className="flex flex-col gap-3">
        {value.conditions.map((condition, index) => (
          <ConditionRow
            key={condition.key}
            {...props}
            condition={condition}
            index={index}
            fields={fields}
            onRemove={() => {
              remove(index);
            }}
            onUpdate={(next) => {
              update(condition.key, next);
            }}
          />
        ))}
      </ol>
      <div className="flex items-center gap-2">
        <Button
          ref={addRef}
          variant="ghost"
          size="sm"
          className="text-accent"
          disabled={full || fields.length === 0}
          onClick={add}
        >
          <Plus aria-hidden="true" />
          {t('lookup:conditions.add')}
        </Button>
        <span
          className="ml-auto text-label font-normal text-fg-muted tabular-nums"
          aria-label={t('lookup:conditions.countLabel', {
            count,
            max: MAX_LOOKUP_CONDITIONS,
          })}
        >
          {t('lookup:conditions.count', { count, max: MAX_LOOKUP_CONDITIONS })}
        </span>
      </div>
      {general === undefined ? null : (
        <p role="alert" className="text-label font-normal text-danger">
          {general}
        </p>
      )}
    </div>
  );
}

export default LookupConditionEditor;
