import { Button, cn } from '@cellhive/ui';
import { Funnel, Lock, Sparkles } from 'lucide-react';
import { createElement, useId } from 'react';
import { useTranslation } from 'react-i18next';

import { typeIconOf } from '../../../../../lib/schema/field-icons';
import {
  chosenFieldPerm,
  FIELD_MODES,
  isComputed,
  isReadOnlyRole,
  type EditorTable,
} from '../model';

import { fieldLevelOptions } from './levels';
import { Segmented } from './Segmented';

import type { RoleAdjustmentDto, RoleKind } from '@cellhive/contracts';
import type { FieldPerm, FieldRuleMode, TableRule } from '@cellhive/permissions';

export interface FieldGridProps {
  readonly kind: RoleKind;
  readonly table: EditorTable;
  readonly rule: TableRule;
  /** Fields the record filters name (raised to read / create when saved). */
  readonly filterFields: ReadonlySet<string>;
  /** Field adjustments of the last save, by field id. */
  readonly adjustments: ReadonlyMap<string, readonly RoleAdjustmentDto[]>;
  readonly reasonText: (adjustment: RoleAdjustmentDto) => string;
  readonly onMode: (mode: FieldRuleMode) => void;
  readonly onField: (fieldId: string, perm: FieldPerm) => void;
  readonly onAll: (perm: FieldPerm) => void;
}

const BULK: readonly FieldPerm[] = ['edit', 'read', 'no_perm'];
const FIELD_ICON = 'size-4 shrink-0 text-fg-muted';

function FieldRow({
  field,
  props,
  editable,
}: {
  readonly field: EditorTable['fields'][number];
  readonly props: FieldGridProps;
  readonly editable: boolean;
}) {
  const { t } = useTranslation('baseSettings');
  const hintId = useId();
  const computed = isComputed(field);
  const inFilter = props.filterFields.has(field.id);
  const adjustments = props.adjustments.get(field.id) ?? [];
  const readOnly = isReadOnlyRole(props.kind);
  const hints = computed || inFilter || adjustments.length > 0;
  return (
    <tr data-testid="field-row" data-field-id={field.id}>
      <th scope="row" className="px-3 py-2 text-left align-top font-normal">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {createElement(typeIconOf(field.type), {
              'aria-hidden': true,
              className: FIELD_ICON,
            })}
            <span className="break-words text-fg">{field.name}</span>
          </span>
          {hints ? (
            <span id={hintId} className="flex flex-col gap-0.5">
              {computed ? (
                <span className="flex items-start gap-1 text-label font-normal text-fg-muted">
                  <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  {t('editor.fields.computed')}
                </span>
              ) : null}
              {inFilter ? (
                <span className="flex items-start gap-1 text-label font-normal text-fg-muted">
                  <Funnel aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  {t(
                    props.rule.record_rule.operations.includes('add') && !computed
                      ? 'editor.fields.inFilterCreate'
                      : 'editor.fields.inFilter',
                  )}
                </span>
              ) : null}
              {adjustments.map((adjustment) => (
                <span
                  key={adjustment.reason}
                  className="flex items-start gap-1 text-label font-normal text-fg"
                  data-testid="adjustment"
                  data-reason={adjustment.reason}
                >
                  <Sparkles aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
                  {props.reasonText(adjustment)}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </th>
      <td className="w-0 px-3 py-2 align-top">
        <Segmented
          // Labels never cut and tracks sized by them, so the shrink-to-fit cell grows to
          // "Create only" / "Chỉ tạo" (T720: every label was cut at 375 px, that one at 1440).
          fit
          className="min-w-[19rem] grid-cols-[repeat(2,auto)] max-sm:min-w-0 sm:grid-cols-[repeat(4,auto)]"
          label={t('editor.fields.levelOf', { name: field.name })}
          value={chosenFieldPerm(props.rule, field)}
          options={fieldLevelOptions(t, props.kind, props.rule.perm)}
          disabled={readOnly || !editable}
          describedBy={hints ? hintId : undefined}
          data-testid={`field-level-${field.id}`}
          onChange={(perm) => {
            props.onField(field.id, perm);
          }}
        />
      </td>
    </tr>
  );
}

/**
 * Field permissions of a table (S6-research §4 #2): the mode, then one row
 * per field with a segmented `radiogroup` Edit / Create only / Read / None —
 * editable when the mode is "Choose per field", showing the mode's value
 * otherwise. Computed fields are at most Read (the server lowers more,
 * the row says so); fields used in a record condition are raised when
 * saved. Bulk buttons set every field at once. Tab moves between fields,
 * arrow keys change a field's level.
 */
export function FieldGrid(props: FieldGridProps) {
  const { t } = useTranslation('baseSettings');
  const modeName = useId();
  const readOnly = isReadOnlyRole(props.kind);
  const off = readOnly || props.rule.perm === 'no_perm';
  const specify = props.rule.field_rule.mode === 'specify';
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2" disabled={off}>
        <legend className="mb-1 text-label font-medium text-fg">{t('editor.fields.mode')}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {FIELD_MODES.map((mode) => (
            <label key={mode} className="flex min-h-control items-center gap-2 text-body text-fg">
              <input
                type="radio"
                name={modeName}
                value={mode}
                checked={props.rule.field_rule.mode === mode}
                data-testid={`field-mode-${mode}`}
                onChange={() => {
                  props.onMode(mode);
                }}
              />
              {t(`editor.fields.modes.${mode}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label text-fg-muted">{t('editor.fields.bulk')}</span>
        {BULK.map((perm) => (
          <Button
            key={perm}
            variant="secondary"
            size="toolbar"
            disabled={off}
            data-testid={`field-bulk-${perm}`}
            onClick={() => {
              props.onAll(perm);
            }}
          >
            {t(`editor.fields.bulkTo.${perm}`)}
          </Button>
        ))}
      </div>
      {!specify && !off ? (
        <p className="text-label text-fg-muted">{t('editor.fields.modeHint')}</p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-body" data-testid="field-grid">
          <caption className="sr-only">
            {t('editor.fields.caption', { name: props.table.name })}
          </caption>
          <thead className="bg-surface-sunken">
            <tr>
              <th
                scope="col"
                className="h-[34px] px-3 text-left text-label font-medium text-fg-muted"
              >
                {t('editor.fields.columns.field')}
              </th>
              <th
                scope="col"
                className={cn('h-[34px] px-3 text-left text-label font-medium text-fg-muted')}
              >
                {t('editor.fields.columns.level')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {props.table.fields.map((field) => (
              <FieldRow key={field.id} field={field} props={props} editable={specify && !off} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
