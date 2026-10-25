import { RECORD_OPERATIONS, type RoleAdjustmentDto, type RoleKind } from '@cellhive/contracts';
import { Checkbox, cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Info, TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { viewsQuery } from '../../../../../lib/query/queries';
import { Note } from '../../../parts';
import {
  filterFieldIds,
  hasNegativeLinkCondition,
  isReadOnlyRole,
  operationsBlock,
  toggled,
  withAllFields,
  withFieldMode,
  withFieldPerm,
  type DraftIssue,
  type EditorTable,
  type FilterState,
} from '../model';

import { FieldGrid } from './FieldGrid';
import { blockText, tableLevelOptions } from './levels';
import { Segmented } from './Segmented';

import type { RuleFilterEditorComponent } from '../../../../../lib/permissions/rule-filter-editor';
import type { ReadScope, TableRule } from '@cellhive/permissions';

export type FilterKey = 'edit_filter' | 'read_filter';

const READ_SCOPES = ['all', 'editable', 'filter'] as const satisfies readonly ReadScope[];

export interface TableDetailProps {
  readonly kind: RoleKind;
  readonly table: EditorTable;
  readonly rule: TableRule;
  readonly orgId: string;
  readonly backHref: string;
  readonly RuleFilterEditor: RuleFilterEditorComponent;
  /** Bumped on save and cancel: the filter editors start again from the draft. */
  readonly filterEpoch: number;
  readonly editConditionsOpen: boolean;
  readonly onEditConditionsOpen: (open: boolean) => void;
  readonly onChange: (rule: TableRule) => void;
  readonly onFilterState: (key: FilterKey, state: FilterState | null) => void;
  readonly summary: readonly string[];
  readonly issues: readonly DraftIssue[];
  readonly tableAdjustments: readonly RoleAdjustmentDto[];
  readonly fieldAdjustments: ReadonlyMap<string, readonly RoleAdjustmentDto[]>;
  readonly reasonText: (adjustment: RoleAdjustmentDto) => string;
}

function Section({
  title,
  description,
  children,
  'data-testid': testId,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly 'data-testid': string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      data-testid={testId}
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={id} className="text-body font-semibold text-fg">
          {title}
        </h3>
        {description === undefined ? null : (
          <p className="text-label font-normal text-fg-muted">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Radio({
  name,
  checked,
  label,
  hint,
  onSelect,
  'data-testid': testId,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly label: string;
  readonly hint?: string;
  readonly onSelect: () => void;
  readonly 'data-testid': string;
}) {
  const hintId = useId();
  return (
    <label className="flex min-h-control items-start gap-2 py-1 text-body text-fg">
      <input
        type="radio"
        name={name}
        className="mt-0.5"
        checked={checked}
        aria-describedby={hint === undefined ? undefined : hintId}
        data-testid={testId}
        onChange={onSelect}
      />
      <span className="flex flex-col gap-0.5">
        {label}
        {hint === undefined ? null : (
          <span id={hintId} className="text-label font-normal text-fg-muted">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * One table of the role (S6-research §4 #1–#3, board "Roles"): the level,
 * then **Views** (`allow_edit`, `visible_views`), **Records** (`add` /
 * `delete`, the edit and read scopes with the view filter builder — user
 * variables and link fields, T710 — and the rule in words) and **Fields**
 * (the field grid, options and file downloads). A page of its own
 * (`?table=`): the matrix becomes a list, then this page, at 375 px.
 */
export function TableDetail(props: TableDetailProps) {
  const { t } = useTranslation('baseSettings');
  const { kind, table, rule, onChange } = props;
  const names = { edit: useId(), read: useId() };
  const readOnly = isReadOnlyRole(kind);
  const off = readOnly || rule.perm === 'no_perm';
  const views = useQuery(viewsQuery(table.id));
  const shared = (views.data?.items ?? []).filter((view) => !view.is_personal);
  const record = rule.record_rule;
  const opsBlocked = operationsBlock(kind, rule.perm);
  const linkWarning =
    hasNegativeLinkCondition(record.edit_filter, table.fields) ||
    hasNegativeLinkCondition(record.read_filter, table.fields);
  const selects = table.fields.filter((field) => field.type === 'select');
  const attachments = table.fields.filter((field) => field.type === 'attachment');
  const setRecord = (next: Partial<TableRule['record_rule']>) => {
    onChange({ ...rule, record_rule: { ...rule.record_rule, ...next } });
  };
  const setFieldRule = (next: Partial<TableRule['field_rule']>) => {
    onChange({ ...rule, field_rule: { ...rule.field_rule, ...next } });
  };
  const editConditions = record.edit_filter !== null || props.editConditionsOpen;
  const filterEditor = (key: FilterKey, value: TableRule['record_rule']['edit_filter']) => (
    <props.RuleFilterEditor
      key={`${String(props.filterEpoch)}:${table.id}:${key}`}
      tableId={table.id}
      orgId={props.orgId}
      value={value as Readonly<Record<string, unknown>> | null}
      label={t('editor.records.where')}
      emptyText={t(key === 'edit_filter' ? 'editor.records.editEmpty' : 'editor.records.readEmpty')}
      onChange={(state) => {
        props.onFilterState(key, { valid: state.valid, incomplete: state.incomplete });
        setRecord({ [key]: state.filter as TableRule['record_rule']['edit_filter'] });
      }}
    />
  );

  return (
    <div className="flex flex-col gap-4" data-testid="table-detail" data-table-id={table.id}>
      <Link
        to={props.backHref}
        className="inline-flex w-fit items-center gap-1 text-label text-accent underline-offset-4 hover:underline"
        data-testid="table-detail-back"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t('editor.detail.back')}
      </Link>
      <div className="flex flex-col gap-2">
        <h2 className="text-heading font-semibold break-words text-fg">{table.name}</h2>
        <Segmented
          className="max-w-xl"
          label={t('editor.matrix.levelOf', { name: table.name })}
          value={rule.perm}
          options={tableLevelOptions(t, kind)}
          disabled={readOnly}
          data-testid={`detail-level-${table.id}`}
          onChange={(perm) => {
            onChange({ ...rule, perm });
          }}
        />
        {props.tableAdjustments.map((adjustment) => (
          <p
            key={adjustment.reason}
            className="text-label text-fg"
            data-testid="adjustment"
            data-reason={adjustment.reason}
          >
            {props.reasonText(adjustment)}
          </p>
        ))}
        {props.issues.map((issue) => (
          <p key={issue} className="flex items-center gap-1 text-label text-danger">
            <TriangleAlert aria-hidden="true" className="size-3.5" />
            {t(`editor.issues.${issue}`)}
          </p>
        ))}
      </div>
      {rule.perm === 'no_perm' ? (
        <Note icon={<Info />} data-testid="table-no-access">
          {t('editor.detail.noAccess')}
        </Note>
      ) : null}

      <Section
        title={t('editor.views.title')}
        description={t('editor.views.description')}
        data-testid="detail-views"
      >
        <fieldset className="flex flex-col gap-2" disabled={off}>
          <legend className="sr-only">{t('editor.views.title')}</legend>
          <Checkbox
            label={t('editor.views.allowEdit')}
            hint={t('editor.views.allowEditHint')}
            checked={rule.view_rule.allow_edit}
            data-testid="views-allow-edit"
            onChange={(event) => {
              onChange({
                ...rule,
                view_rule: { ...rule.view_rule, allow_edit: event.currentTarget.checked },
              });
            }}
          />
          <Radio
            name={`${names.edit}-views`}
            checked={rule.view_rule.visible_views === null}
            label={t('editor.views.all')}
            data-testid="views-all"
            onSelect={() => {
              onChange({ ...rule, view_rule: { ...rule.view_rule, visible_views: null } });
            }}
          />
          <Radio
            name={`${names.edit}-views`}
            checked={rule.view_rule.visible_views !== null}
            label={t('editor.views.only')}
            hint={t('editor.views.onlyHint')}
            data-testid="views-only"
            onSelect={() => {
              onChange({ ...rule, view_rule: { ...rule.view_rule, visible_views: [] } });
            }}
          />
          {rule.view_rule.visible_views === null ? null : (
            <ul className="ml-6 flex flex-col gap-1" aria-label={t('editor.views.listLabel')}>
              {shared.map((view) => (
                <li key={view.id}>
                  <Checkbox
                    label={view.name}
                    checked={rule.view_rule.visible_views?.includes(view.id) ?? false}
                    onChange={(event) => {
                      onChange({
                        ...rule,
                        view_rule: {
                          ...rule.view_rule,
                          visible_views: toggled(
                            rule.view_rule.visible_views ?? [],
                            view.id,
                            event.currentTarget.checked,
                          ),
                        },
                      });
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      </Section>

      <Section
        title={t('editor.records.title')}
        description={t('editor.records.description')}
        data-testid="detail-records"
      >
        <fieldset className="flex flex-col gap-1" disabled={off || opsBlocked !== null}>
          <legend className="mb-1 text-label font-medium text-fg">
            {t('editor.records.operations')}
          </legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {RECORD_OPERATIONS.map((operation) => (
              <Checkbox
                key={operation}
                label={t(`editor.records.ops.${operation}`)}
                checked={record.operations.includes(operation)}
                data-testid={`records-op-${operation}`}
                onChange={(event) => {
                  setRecord({
                    operations: toggled(record.operations, operation, event.currentTarget.checked),
                  });
                }}
              />
            ))}
          </div>
          {opsBlocked === null || off ? null : (
            <p className="text-label text-fg-muted">{blockText(t, opsBlocked)}</p>
          )}
        </fieldset>

        <fieldset
          className="flex flex-col gap-1"
          disabled={off || (rule.perm !== 'edit' && rule.perm !== 'manage')}
        >
          <legend className="mb-1 text-label font-medium text-fg">
            {t('editor.records.editScope')}
          </legend>
          <Radio
            name={names.edit}
            checked={!editConditions}
            label={t('editor.records.editAll')}
            data-testid="records-edit-all"
            onSelect={() => {
              props.onEditConditionsOpen(false);
              props.onFilterState('edit_filter', null);
              setRecord({ edit_filter: null });
            }}
          />
          <Radio
            name={names.edit}
            checked={editConditions}
            label={t('editor.records.editWhere')}
            data-testid="records-edit-where"
            onSelect={() => {
              props.onEditConditionsOpen(true);
            }}
          />
        </fieldset>
        {editConditions && !off ? filterEditor('edit_filter', record.edit_filter) : null}

        <fieldset className="flex flex-col gap-1" disabled={off}>
          <legend className="mb-1 text-label font-medium text-fg">
            {t('editor.records.readScope')}
          </legend>
          {READ_SCOPES.map((scope) => (
            <Radio
              key={scope}
              name={names.read}
              checked={record.read_scope === scope}
              label={t(`editor.records.read.${scope}`)}
              data-testid={`records-read-${scope}`}
              onSelect={() => {
                if (scope !== 'filter') {
                  props.onFilterState('read_filter', null);
                  setRecord({ read_scope: scope, read_filter: null });
                } else setRecord({ read_scope: scope });
              }}
            />
          ))}
        </fieldset>
        {record.read_scope === 'filter' && !off
          ? filterEditor('read_filter', record.read_filter)
          : null}

        {linkWarning ? (
          <Note icon={<TriangleAlert />} data-testid="link-warning">
            {t('editor.records.linkWarning')}
          </Note>
        ) : null}
        <div
          role="status"
          className={cn('rounded-md bg-surface-sunken px-3 py-2 text-body text-fg')}
          data-testid="records-summary"
        >
          {props.summary.join(' ')}
        </div>
      </Section>

      <Section
        title={t('editor.fields.title')}
        description={t('editor.fields.description')}
        data-testid="detail-fields"
      >
        <FieldGrid
          kind={kind}
          table={table}
          rule={rule}
          filterFields={filterFieldIds(rule)}
          adjustments={props.fieldAdjustments}
          reasonText={props.reasonText}
          onMode={(mode) => {
            onChange(withFieldMode(rule, mode, table));
          }}
          onField={(fieldId, perm) => {
            onChange(withFieldPerm(rule, fieldId, perm));
          }}
          onAll={(perm) => {
            onChange(withAllFields(rule, table, perm));
          }}
        />
        {selects.length === 0 ? null : (
          <fieldset className="flex flex-col gap-1" disabled={off}>
            <legend className="mb-1 text-label font-medium text-fg">
              {t('editor.fields.options')}
            </legend>
            <p className="text-label text-fg-muted">{t('editor.fields.optionsHint')}</p>
            {selects.map((field) => (
              <Checkbox
                key={field.id}
                label={field.name}
                checked={rule.field_rule.option_edit_fields.includes(field.id as never)}
                onChange={(event) => {
                  setFieldRule({
                    option_edit_fields: toggled(
                      rule.field_rule.option_edit_fields,
                      field.id as never,
                      event.currentTarget.checked,
                    ),
                  });
                }}
              />
            ))}
          </fieldset>
        )}
        {attachments.length === 0 ? null : (
          <fieldset
            className="flex flex-col gap-1"
            disabled={off || rule.field_rule.mode !== 'specify'}
          >
            <legend className="mb-1 text-label font-medium text-fg">
              {t('editor.fields.downloads')}
            </legend>
            <p className="text-label text-fg-muted">
              {t(
                rule.field_rule.mode === 'specify'
                  ? 'editor.fields.downloadsHint'
                  : 'editor.fields.downloadsAll',
              )}
            </p>
            {attachments.map((field) => (
              <Checkbox
                key={field.id}
                label={field.name}
                checked={rule.field_rule.file_download_fields.includes(field.id as never)}
                onChange={(event) => {
                  setFieldRule({
                    file_download_fields: toggled(
                      rule.field_rule.file_download_fields,
                      field.id as never,
                      event.currentTarget.checked,
                    ),
                  });
                }}
              />
            ))}
          </fieldset>
        )}
      </Section>
    </div>
  );
}
