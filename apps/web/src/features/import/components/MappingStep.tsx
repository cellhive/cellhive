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
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
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

/**
 * Step 3: what becomes of each column. New table: its name, then a field
 * name and type per column (guessed from the file; the first imported column
 * is the primary field, always text), or skip it. Append: a writable field
 * per column (read-only, computed, system and attachment fields are not
 * offered; link and parent fields take record titles, T411),
 * columns without a field are flagged, required fields must be filled.
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
      <div
        role="region"
        aria-label={t('mapping.columnsRegion')}
        tabIndex={0}
        className="max-h-80 overflow-auto rounded-md border border-line"
      >
        <table className="w-full border-collapse text-body">
          <thead className="sticky top-0 z-10 bg-surface-sunken text-left text-label">
            <tr>
              <th scope="col" className="px-2 py-1.5">
                {t('mapping.column')}
              </th>
              <th scope="col" className="px-2 py-1.5">
                {t('mapping.import')}
              </th>
              <th scope="col" className="px-2 py-1.5">
                {t('mapping.fieldName')}
              </th>
              <th scope="col" className="px-2 py-1.5">
                {t('mapping.fieldType')}
              </th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((draft) => {
              const column = preview.columns.find((item) => item.index === draft.column);
              const isPrimary = draft.column === primary;
              const issue = issues.columns.get(draft.column);
              const type = effectiveType(draft, primary);
              const columnLabel = column?.name ?? '';
              return (
                <tr
                  key={draft.column}
                  className="border-t border-line align-top"
                  data-testid="import-column-row"
                >
                  <th scope="row" className="max-w-48 truncate px-2 py-1.5 text-left font-medium">
                    {columnLabel}
                    {isPrimary ? (
                      <span className="ml-2 rounded-sm bg-accent-soft px-1 text-label font-normal text-accent">
                        {t('mapping.primary')}
                      </span>
                    ) : null}
                  </th>
                  <td className="px-2 py-1.5">
                    <Checkbox
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
                  </td>
                  <td className="px-2 py-1.5">
                    <FormField
                      label={
                        <span className="sr-only">
                          {t('mapping.fieldNameOf', { column: columnLabel })}
                        </span>
                      }
                      error={
                        draft.include && issue !== undefined
                          ? t(
                              issue === 'nameRequired'
                                ? 'mapping.fieldNameRequired'
                                : 'mapping.fieldNameDuplicate',
                            )
                          : undefined
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
                  </td>
                  <td className="px-2 py-1.5">
                    <FormField
                      label={
                        <span className="sr-only">
                          {t('mapping.fieldTypeOf', { column: columnLabel })}
                        </span>
                      }
                      hint={
                        isPrimary
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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

  if (fields.isPending || base.isPending) return <Skeleton className="h-40" />;
  if (fields.isError) return <ErrorAlert error={fields.error} />;

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
      <div
        role="region"
        aria-label={t('mapping.columnsRegion')}
        tabIndex={0}
        className="max-h-80 overflow-auto rounded-md border border-line"
      >
        <table className="w-full border-collapse text-body">
          <thead className="sticky top-0 z-10 bg-surface-sunken text-left text-label">
            <tr>
              <th scope="col" className="px-2 py-1.5">
                {t('mapping.column')}
              </th>
              <th scope="col" className="px-2 py-1.5">
                {t('mapping.targetField')}
              </th>
              <th scope="col" className="px-2 py-1.5">
                {t('mapping.statusHeading')}
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.columns.map((column) => {
              const fieldId = mapping.get(column.index) ?? null;
              const status = analysis.statuses.get(column.index);
              const duplicate = fieldId !== null && analysis.duplicates.has(fieldId);
              const flagged =
                status?.kind === 'readOnly' ||
                status?.kind === 'unsupported' ||
                status?.kind === 'computed' ||
                status?.kind === 'noMatch';
              return (
                <tr
                  key={column.index}
                  className="border-t border-line align-top"
                  data-testid="import-column-row"
                >
                  <th scope="row" className="max-w-48 truncate px-2 py-1.5 text-left font-medium">
                    {column.name}
                  </th>
                  <td className="px-2 py-1.5">
                    <FormField
                      label={
                        <span className="sr-only">
                          {t('mapping.targetOf', { column: column.name })}
                        </span>
                      }
                      error={duplicate ? t('mapping.duplicateField') : undefined}
                    >
                      {(control) => (
                        <Select
                          {...control}
                          value={fieldId ?? ''}
                          onChange={(event) => {
                            choose(
                              column.index,
                              event.target.value === '' ? null : event.target.value,
                            );
                          }}
                        >
                          <option value="">{t('mapping.skip')}</option>
                          {targets.map((field) => (
                            <option key={field.id} value={field.id}>
                              {field.required
                                ? t('mapping.requiredField', { name: field.name })
                                : field.name}
                            </option>
                          ))}
                          {unsupported.length === 0 ? null : (
                            <optgroup label={t('mapping.unsupportedGroup')}>
                              {unsupported.map((field) => (
                                <option key={field.id} value={field.id} disabled>
                                  {t('mapping.attachmentOption', { name: field.name })}
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </Select>
                      )}
                    </FormField>
                  </td>
                  <td
                    className={flagged ? 'px-2 py-1.5 text-warning' : 'px-2 py-1.5 text-fg-muted'}
                  >
                    {statusText(t, status, byId)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
