import { FormField, Input, Select, Switch } from '@cellhive/ui';
import { Table2 } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { LockedValue } from '../../convert/parts';
import { issueAt, useIssueText } from '../shared';

import type { RecordFilterEditorProps } from '../../../../lib/schema/field-tools';
import type { DraftIssue, LinkDraft } from '../../draft';
import type { ComponentType, ReactNode } from 'react';

export interface LinkOptionsFormProps {
  readonly value: LinkDraft;
  readonly onChange: (value: LinkDraft) => void;
  /** Tables of the base the user sees (the linked table is one of them). */
  readonly tables: readonly { readonly id: string; readonly name: string }[];
  /** A saved field: its linked table is fixed (BACKLOG S4 design decision #5). */
  readonly editing: boolean;
  readonly issues: readonly DraftIssue[];
  readonly orgId: string | undefined;
  readonly RecordFilterEditor?: ComponentType<RecordFilterEditorProps> | undefined;
  /** (T415) Name of this field's table (hints, default name of the reverse field). */
  readonly tableName?: string | undefined;
  /**
   * (T415) Why two-way cannot be switched (no schema rights on the linked
   * table, ADR-28 §1), translated; `undefined`: it can.
   */
  readonly twoWayLocked?: string | undefined;
  /** (T415) The saved definition, to mark what changed ("Changed"). */
  readonly saved?: LinkDraft | undefined;
  /** (T415) Name of the reverse field of a saved two-way link. */
  readonly partnerName?: string | undefined;
}

function ChangedBadge() {
  const { t } = useTranslation('field');
  return (
    <span className="inline-flex h-5 items-center rounded-sm bg-warning/10 px-1.5 text-label font-medium text-warning">
      {t('link.changed')}
    </span>
  );
}

function SwitchRow({
  checked,
  disabled,
  label,
  hint,
  badge,
  onChange,
  'data-testid': testId,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  badge?: ReactNode;
  onChange: (checked: boolean) => void;
  'data-testid': string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        data-testid={testId}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <label htmlFor={id} className="font-medium text-fg">
            {label}
          </label>
          {badge}
        </span>
        <p id={`${id}-hint`} className="text-label font-normal text-fg-muted">
          {hint}
        </p>
        {children}
      </div>
    </div>
  );
}

/**
 * Options of a link field (board "Cấu hình liên kết, bật hai chiều"): the
 * linked table (locked once saved, decision #5), one or several records,
 * two-way with the name of the reverse field (T415, ADR-28: switching it on
 * a saved field is a conversion, previewed by the dialog), and the
 * conditions a linked record must meet (`record_filter`, the view filter
 * builder over the linked table's fields).
 */
export function LinkOptionsForm({
  value,
  onChange,
  tables,
  editing,
  issues,
  orgId,
  RecordFilterEditor,
  tableName,
  twoWayLocked,
  saved,
  partnerName,
}: LinkOptionsFormProps) {
  const { t } = useTranslation('field');
  const issueText = useIssueText();
  const tableIssue = issueAt(issues, 'options.link_table');
  const reverseIssue = issueAt(issues, 'options.bidirectional_link_field_name');
  const labelId = useId();
  const hintId = useId();
  const linked = tables.find((table) => table.id === value.linkTable);
  const linkedName = linked?.name ?? t('link.otherTable');
  const twoWay = value.bidirectional === true;
  const wasTwoWay = saved?.bidirectional === true;
  const source = tableName ?? t('link.thisTable');
  return (
    <div className="flex flex-col gap-4">
      {editing ? (
        <div className="flex flex-col gap-1">
          <span id={labelId} className="text-label text-fg">
            {t('link.table')}
          </span>
          <LockedValue
            icon={Table2}
            labelledBy={labelId}
            describedBy={hintId}
            data-testid="link-table"
          >
            {linkedName}
          </LockedValue>
          <p id={hintId} className="text-label font-normal text-fg-muted">
            {t('link.tableFixed')}
          </p>
        </div>
      ) : (
        <FormField label={t('link.table')} error={issueText(tableIssue)}>
          {(control) => (
            <Select
              {...control}
              value={value.linkTable}
              data-testid="link-table"
              onChange={(event) => {
                // Another table: conditions on the former one's fields no longer apply.
                onChange({ ...value, linkTable: event.target.value, recordFilter: null });
              }}
            >
              <option value="">{t('link.chooseTable')}</option>
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      )}
      <div className="flex flex-col gap-4 rounded-lg border border-line p-4">
        <SwitchRow
          data-testid="link-allow-multiple"
          checked={value.allowMultiple}
          label={t('link.allowMultiple')}
          hint={
            value.allowMultiple
              ? t('link.allowMultipleOn', { table: linkedName })
              : t('link.allowMultipleOff', { table: linkedName })
          }
          badge={
            saved !== undefined && saved.allowMultiple !== value.allowMultiple ? (
              <ChangedBadge />
            ) : null
          }
          onChange={(allowMultiple) => {
            onChange({ ...value, allowMultiple });
          }}
        />
        <SwitchRow
          data-testid="link-two-way"
          checked={twoWay}
          disabled={twoWayLocked !== undefined || value.linkTable === ''}
          label={t('link.twoWay')}
          hint={twoWayLocked ?? t('link.twoWayHint', { table: linkedName, source })}
          badge={saved !== undefined && wasTwoWay !== twoWay ? <ChangedBadge /> : null}
          onChange={(bidirectional) => {
            onChange({
              ...value,
              bidirectional,
              // The reverse field is named after this table by default (like Lark).
              reverseName:
                bidirectional && (value.reverseName ?? '').trim() === ''
                  ? source
                  : (value.reverseName ?? ''),
            });
          }}
        >
          {twoWay && !wasTwoWay ? (
            <FormField
              className="mt-2"
              label={t('link.reverseName', { table: linkedName })}
              hint={t('link.reverseHint')}
              error={issueText(reverseIssue)}
            >
              {(control) => (
                <Input
                  {...control}
                  autoComplete="off"
                  maxLength={255}
                  value={value.reverseName ?? ''}
                  data-testid="link-reverse-name"
                  onChange={(event) => {
                    onChange({ ...value, reverseName: event.target.value });
                  }}
                />
              )}
            </FormField>
          ) : null}
          {twoWay && wasTwoWay && partnerName !== undefined ? (
            <p className="text-label font-normal text-fg-muted">
              {t('link.reverseField', { name: partnerName, table: linkedName })}
            </p>
          ) : null}
        </SwitchRow>
      </div>
      {RecordFilterEditor === undefined || value.linkTable === '' || orgId === undefined ? null : (
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="text-label text-fg">{t('link.filter')}</legend>
          <RecordFilterEditor
            key={value.linkTable}
            tableId={value.linkTable}
            orgId={orgId}
            value={value.recordFilter}
            onChange={(recordFilter) => {
              onChange({ ...value, recordFilter });
            }}
          />
          <p className="text-label font-normal text-fg-muted">{t('link.filterHint')}</p>
        </fieldset>
      )}
    </div>
  );
}
