import {
  IMPORT_FIELD_TYPES,
  type FieldDto,
  type ImportFieldType,
  type ImportPreview,
  type ImportUploadDto,
  type StartImportRequest,
} from '@cellhive/contracts';
import { Alert, Checkbox, FormField, Input, Select, Skeleton } from '@cellhive/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { baseQuery, fieldsQuery, tablesQuery } from '../../../lib/query/queries';
import { importsApi } from '../api';
import { tableNameFromFile } from '../file';
import {
  analyzeAppend,
  appendRequest,
  autoMapping,
  canStartAppend,
  effectiveType,
  hasCreateIssues,
  importTargets,
  initialNewColumns,
  newTableRequest,
  primaryColumn,
  titleColumns,
  unsupportedFields,
  validateNewTable,
  type AppendMapping,
  type ColumnStatus,
  type NewColumnDraft,
  type TitleColumn,
} from '../mapping';

import { FieldMapper, FieldMapperRow, TargetCombobox, type TargetGroup } from './FieldMapper';

import type { ImportTarget } from './types';
import type { TFunction } from 'i18next';

export interface MappingStepProps {
  readonly baseId: string;
  readonly target: ImportTarget;
  readonly upload: ImportUploadDto;
  readonly preview: ImportPreview;
  readonly onStarted: (jobId: string) => void;
  readonly footer: (start: { disabled: boolean; pending: boolean; run: () => void }) => ReactNode;
  /** Replaces the start request (tests). */
  readonly startImport?: typeof importsApi.start;
}

function useStart(
  baseId: string,
  onStarted: (jobId: string) => void,
  startImport: typeof importsApi.start,
) {
  return useMutation({
    mutationFn: (body: StartImportRequest) => startImport(baseId, body, crypto.randomUUID()),
    onSuccess: (accepted) => {
      onStarted(accepted.job_id);
    },
  });
}

/** Values shown under a column's name. */
const SAMPLE_COUNT = 3;

/**
 * The first different non-empty values of each column in the preview, as
 * the preview table writes them (numbers for the language, Yes/No).
 */
function useSamples(preview: ImportPreview): (column: number) => readonly string[] {
  const { t } = useTranslation('import');
  const format = useFormatters();
  return useMemo(() => {
    const byColumn = new Map<number, string[]>();
    for (const column of preview.columns) {
      const values: string[] = [];
      for (const row of preview.rows) {
        const value = row[column.index] ?? null;
        if (value === null || (typeof value === 'string' && value.trim() === '')) continue;
        const text =
          typeof value === 'boolean'
            ? t(value ? 'preview.true' : 'preview.false')
            : typeof value === 'number'
              ? format.number(value)
              : value;
        if (!values.includes(text)) values.push(text);
        if (values.length === SAMPLE_COUNT) break;
      }
      byColumn.set(column.index, values);
    }
    return (column: number) => byColumn.get(column) ?? [];
  }, [preview, t, format]);
}

/**
 * Step 3: what becomes of each column, one row per column of the file (its
 * name and sample values → what it becomes; Lucian #130, FieldMapper.tsx).
 * New table: its name, then a field name and type per column (guessed from
 * the file; the first imported column is the primary field, always text), or
 * skip it. Append: a writable field per column (read-only, computed, system
 * and attachment fields are not offered; link and parent fields take record
 * titles, T411), columns without a field are flagged, required fields must
 * be filled, a field filled twice is named under the rows.
 */
export function MappingStep(props: MappingStepProps) {
  return props.target.mode === 'create_table' ? (
    <NewTableMapping {...props} />
  ) : (
    <AppendMappingStep {...props} />
  );
}

function NewTableMapping({
  baseId,
  upload,
  preview,
  onStarted,
  footer,
  startImport = importsApi.start,
}: MappingStepProps) {
  const { t } = useTranslation('import');
  const tables = useQuery(tablesQuery(baseId));
  const [tableName, setTableName] = useState(() => tableNameFromFile(upload.filename));
  const [drafts, setDrafts] = useState<NewColumnDraft[]>(() => initialNewColumns(preview));
  const [touched, setTouched] = useState(false);
  const start = useStart(baseId, onStarted, startImport);
  const samplesOf = useSamples(preview);

  const existing = useMemo(
    () => (tables.data?.items ?? []).map((table) => table.name),
    [tables.data],
  );
  const issues = validateNewTable(tableName, drafts, existing);
  const primary = primaryColumn(drafts);
  const conflict = isApiError(start.error) && start.error.code === 'NAME_CONFLICT';
  const nameError =
    issues.tableName === 'required'
      ? touched
        ? t('mapping.tableNameRequired')
        : undefined
      : issues.tableName === 'taken' || conflict
        ? t('mapping.tableNameTaken')
        : undefined;

  const update = (column: number, patch: Partial<NewColumnDraft>) => {
    setDrafts((current) =>
      current.map((draft) => (draft.column === column ? { ...draft, ...patch } : draft)),
    );
  };

  const run = () => {
    setTouched(true);
    if (hasCreateIssues(issues)) return;
    start.mutate(newTableRequest(upload.id, tableName, drafts, preview.columns));
  };

  return (
    <div className="flex flex-col gap-4">
      <FormField label={t('mapping.tableName')} error={nameError}>
        {(control) => (
          <Input
            {...control}
            value={tableName}
            maxLength={255}
            onChange={(event) => {
              setTableName(event.target.value);
              if (conflict) start.reset();
            }}
          />
        )}
      </FormField>
      <p className="text-label font-normal text-fg-muted">{t('mapping.createHint')}</p>
      <FieldMapper label={t('mapping.columnsRegion')} warning={null}>
        {drafts.map((draft) => {
          const column = preview.columns.find((item) => item.index === draft.column);
          const isPrimary = draft.column === primary;
          const issue = draft.include ? issues.columns.get(draft.column) : undefined;
          const type = effectiveType(draft, primary);
          const columnLabel = column?.name ?? '';
          return (
            <FieldMapperRow
              key={draft.column}
              name={columnLabel}
              samples={samplesOf(draft.column)}
              state={!draft.include ? 'skipped' : issue === undefined ? 'mapped' : 'invalid'}
              target={draft.include ? type : ''}
              leading={
                <Checkbox
                  className="gap-0"
                  label={
                    <span className="sr-only">
                      {t('mapping.importColumn', { column: columnLabel })}
                    </span>
                  }
                  checked={draft.include}
                  onChange={(event) => {
                    update(draft.column, { include: event.target.checked });
                  }}
                />
              }
              badge={isPrimary ? <span className="badge">{t('mapping.primary')}</span> : null}
            >
              <div className="pair">
                <FormField
                  label={
                    <span className="sr-only">
                      {t('mapping.fieldNameOf', { column: columnLabel })}
                    </span>
                  }
                  error={
                    issue === undefined
                      ? undefined
                      : t(
                          issue === 'nameRequired'
                            ? 'mapping.fieldNameRequired'
                            : 'mapping.fieldNameDuplicate',
                        )
                  }
                >
                  {(control) => (
                    <Input
                      {...control}
                      value={draft.name}
                      maxLength={255}
                      disabled={!draft.include}
                      onChange={(event) => {
                        update(draft.column, { name: event.target.value });
                      }}
                    />
                  )}
                </FormField>
                <FormField
                  label={
                    <span className="sr-only">
                      {t('mapping.fieldTypeOf', { column: columnLabel })}
                    </span>
                  }
                  hint={
                    !draft.include
                      ? undefined
                      : isPrimary
                        ? t('mapping.primaryText')
                        : column !== undefined && column.type === type
                          ? t('mapping.guessed')
                          : undefined
                  }
                >
                  {(control) => (
                    <Select
                      {...control}
                      value={type}
                      disabled={!draft.include || isPrimary}
                      onChange={(event) => {
                        update(draft.column, { type: event.target.value as ImportFieldType });
                      }}
                    >
                      {IMPORT_FIELD_TYPES.map((option) => (
                        <option key={option} value={option}>
                          {t(`types.${option}`)}
                        </option>
                      ))}
                    </Select>
                  )}
                </FormField>
              </div>
            </FieldMapperRow>
          );
        })}
      </FieldMapper>
      {issues.noColumns ? (
        <Alert variant="danger">
          <p>{t('mapping.noColumns')}</p>
        </Alert>
      ) : null}
      {start.error !== null && !conflict ? <ErrorAlert error={start.error} /> : null}
      {footer({
        disabled: hasCreateIssues(issues) || start.isSuccess,
        pending: start.isPending,
        run,
      })}
    </div>
  );
}

function statusText(
  t: TFunction<'import'>,
  status: ColumnStatus | undefined,
  fields: ReadonlyMap<string, FieldDto>,
): string {
  switch (status?.kind) {
    case 'mapped': {
      const field = fields.get(status.fieldId);
      // Link and parent fields take record titles (T411, CONTRACTS §19).
      const key =
        field?.type === 'link'
          ? 'mapping.status.mappedLink'
          : field?.type === 'parent'
            ? 'mapping.status.mappedParent'
            : 'mapping.status.mapped';
      return t(key, { field: field?.name ?? '' });
    }
    case 'readOnly':
      return t('mapping.status.readOnly', { field: status.fieldName });
    case 'unsupported':
      return t('mapping.status.unsupported', { field: status.fieldName });
    case 'computed':
      return t('mapping.status.computed', { field: status.fieldName });
    case 'noMatch':
      return t('mapping.status.noMatch');
    default:
      return t('mapping.status.skipped');
  }
}

function AppendMappingStep({
  baseId,
  target,
  upload,
  preview,
  onStarted,
  footer,
  startImport = importsApi.start,
}: MappingStepProps) {
  const { t } = useTranslation('import');
  const tableId = target.mode === 'append' ? target.tableId : '';
  const base = useQuery(baseQuery(baseId));
  const fields = useQuery(fieldsQuery(tableId));
  const visible = useMemo(() => fields.data?.items ?? [], [fields.data]);
  const targets = useMemo(
    () => importTargets(base.data?.access, tableId, visible),
    [base.data, tableId, visible],
  );
  const byId = useMemo(() => new Map(visible.map((field) => [field.id, field])), [visible]);
  // Files can never be imported: listed disabled with the reason (T419).
  const unsupported = useMemo(() => unsupportedFields(visible), [visible]);
  const tables = useQuery(tablesQuery(baseId));
  const [chosen, setChosen] = useState<AppendMapping | null>(null);
  const mapping = chosen ?? autoMapping(preview.columns, targets);
  const analysis = analyzeAppend(preview.columns, mapping, targets, visible);
  const titled = titleColumns(preview.columns, mapping, byId, tableId);
  const start = useStart(baseId, onStarted, startImport);
  const samplesOf = useSamples(preview);
  const statusPrefix = useId();
  const targetGroups = useMemo<TargetGroup[]>(
    () => [
      {
        key: 'fields',
        options: targets.map((field) => ({
          id: field.id,
          type: field.type,
          label: field.required ? t('mapping.requiredField', { name: field.name }) : field.name,
        })),
      },
      ...(unsupported.length === 0
        ? []
        : [
            {
              key: 'files',
              label: t('mapping.unsupportedGroup'),
              options: unsupported.map((field) => ({
                id: field.id,
                type: field.type,
                label: t('mapping.attachmentOption', { name: field.name }),
                disabled: true,
              })),
            },
          ]),
    ],
    [targets, unsupported, t],
  );

  if (fields.isPending || base.isPending) return <Skeleton className="h-40" />;
  if (fields.isError) return <ErrorAlert error={fields.error} />;

  // One line under the rows names every field filled twice; each row says it too.
  const duplicateNames = visible
    .filter((field) => analysis.duplicates.has(field.id))
    .map((field) => field.name);
  const duplicateWarning =
    duplicateNames.length === 0
      ? null
      : t('mapping.duplicates', {
          count: duplicateNames.length,
          fields: duplicateNames.join(', '),
        });

  const choose = (column: number, fieldId: string | null) => {
    const next = new Map(mapping);
    next.set(column, fieldId);
    setChosen(next);
  };
  const run = () => {
    if (!canStartAppend(analysis)) return;
    start.mutate(appendRequest(upload.id, tableId, mapping));
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-label font-normal text-fg-muted">{t('mapping.appendHint')}</p>
      <FieldMapper label={t('mapping.columnsRegion')} warning={duplicateWarning}>
        {preview.columns.map((column) => {
          const fieldId = mapping.get(column.index) ?? null;
          const status = analysis.statuses.get(column.index);
          const duplicate = fieldId !== null && analysis.duplicates.has(fieldId);
          const flagged =
            status?.kind === 'readOnly' ||
            status?.kind === 'unsupported' ||
            status?.kind === 'computed' ||
            status?.kind === 'noMatch';
          const statusId = `${statusPrefix}-${String(column.index)}`;
          return (
            <FieldMapperRow
              key={column.index}
              name={column.name}
              samples={samplesOf(column.index)}
              state={duplicate ? 'invalid' : status?.kind === 'mapped' ? 'mapped' : 'skipped'}
              target={fieldId ?? ''}
            >
              <TargetCombobox
                label={t('mapping.targetOf', { column: column.name })}
                value={fieldId}
                skipLabel={t('mapping.skip')}
                groups={targetGroups}
                invalid={duplicate}
                describedBy={statusId}
                onChange={(next) => {
                  choose(column.index, next);
                }}
              />
              <p
                id={statusId}
                className="status"
                data-tone={duplicate ? 'danger' : flagged ? 'warning' : undefined}
              >
                {duplicate ? t('mapping.duplicateField') : statusText(t, status, byId)}
              </p>
            </FieldMapperRow>
          );
        })}
      </FieldMapper>
      {titled.length === 0 ? null : (
        <TitleColumnsHint
          columns={titled}
          tableName={(id) => tables.data?.items.find((table) => table.id === id)?.name ?? null}
        />
      )}
      {unsupported.length === 0 ? null : (
        <p className="text-label font-normal text-fg-muted" data-testid="import-files-note">
          {t('mapping.filesNote', {
            count: unsupported.length,
            fields: unsupported.map((field) => field.name).join(', '),
          })}
        </p>
      )}
      {analysis.missingRequired.length > 0 ? (
        <Alert variant="danger">
          <p>
            {t('mapping.missingRequired', {
              fields: analysis.missingRequired.map((field) => field.name).join(', '),
            })}
          </p>
        </Alert>
      ) : null}
      {analysis.mappedCount === 0 ? (
        <Alert variant="info">
          <p>{t('mapping.nothingMapped')}</p>
        </Alert>
      ) : null}
      {start.error === null ? null : <ErrorAlert error={start.error} />}
      {footer({
        disabled: !canStartAppend(analysis) || start.isSuccess,
        pending: start.isPending,
        run,
      })}
    </div>
  );
}

/**
 * How link and parent columns are read (T411, CONTRACTS §19), shown as soon
 * as one is mapped (T419): each column, its field and the table whose
 * record titles it names, then the rules — exact and unique titles among
 * the records the user can read, commas between titles, quotes around a
 * title with a comma, `rec_…` ids, rows whose titles match nothing or
 * several records skipped and reported.
 */
function TitleColumnsHint({
  columns,
  tableName,
}: {
  columns: readonly TitleColumn[];
  tableName: (tableId: string) => string | null;
}) {
  const { t } = useTranslation('import');
  const hasLink = columns.some((item) => item.field.type === 'link');
  const hasParent = columns.some((item) => item.field.type === 'parent');
  return (
    <Alert variant="info" data-testid="import-title-hint">
      <p className="font-medium">{t('mapping.titles.heading')}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {columns.map((item) => (
          <li key={item.column.index}>
            {t(item.field.type === 'parent' ? 'mapping.titles.parent' : 'mapping.titles.link', {
              column: item.column.name,
              field: item.field.name,
              table:
                (item.tableId === null ? null : tableName(item.tableId)) ??
                t('mapping.titles.unknownTable'),
            })}
          </li>
        ))}
      </ul>
      <ul className="mt-2 list-disc pl-5 text-label font-normal">
        <li>{t('mapping.titles.exact')}</li>
        {hasLink ? <li>{t('mapping.titles.separator')}</li> : null}
        {hasParent ? <li>{t('mapping.titles.parentRule')}</li> : null}
        <li>{t('mapping.titles.ids')}</li>
        <li>{t('mapping.titles.skipped')}</li>
      </ul>
    </Alert>
  );
}
