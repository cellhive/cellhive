import { DATETIME_FORMATS, type LookupFieldAggregate } from '@cellhive/field-types';
import { Alert, Button, Dialog, FormField, Input, Select, Spinner } from '@cellhive/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowRight, History, Link2 } from 'lucide-react';
import { useId, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError, type ApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { translateDetail } from '../../../lib/errors/translate';
import {
  baseQuery,
  fieldsQuery,
  orgQuery,
  tableQuery,
  tableRecordCountQuery,
  tablesQuery,
} from '../../../lib/query/queries';
import { issuesByKey } from '../../../lib/schema/lookup-where';
import {
  aggregatesFor,
  applyShortcut,
  buildOptions,
  carriesSourceStyle,
  changedOptions,
  cycleOf,
  errorTargetOf,
  hasDefinition,
  linkShortcuts,
  lookupDraftOf,
  resultKindOf,
  sourceStyleOf,
  styleChoicesFor,
  withSelect,
  withSource,
  type ErrorTarget,
  type LinkShortcut,
  type LookupDraft,
  type StyleChoice,
} from '../model';
import { useLookupPreview } from '../use-lookup-preview';

import { LookupPreview } from './LookupPreview';

import type { LookupFieldEditorWithWhereProps } from '../../../lib/schema/lookup-tools';
import type { FieldDto, TableDto } from '@cellhive/contracts';

const TEXTAREA_CLASSES =
  'min-h-16 w-full rounded-md border border-line-control bg-surface px-3 py-2 text-body text-fg ' +
  'placeholder:text-fg-subtle aria-invalid:border-danger';

/** Server errors of a save or a preview, by the control they belong to. */
function placeErrors(error: unknown): {
  readonly byTarget: ReadonlyMap<ErrorTarget, ApiError['errors']>;
  readonly apiError: ApiError | null;
} {
  const byTarget = new Map<ErrorTarget, ApiError['errors']>();
  if (!isApiError(error)) return { byTarget, apiError: null };
  if (error.code === 'NAME_CONFLICT') {
    byTarget.set('name', [{ path: 'name', code: 'NAME_CONFLICT', message: error.detail ?? '' }]);
    return { byTarget, apiError: error };
  }
  for (const item of error.errors) {
    const target = errorTargetOf(item.path);
    byTarget.set(target, [...(byTarget.get(target) ?? []), item]);
  }
  return { byTarget, apiError: error };
}

/** A short description of a number or date style ("VND currency", "dd/MM/yyyy"). */
function useStyleText() {
  const { t } = useTranslation('lookup');
  return (style: Readonly<Record<string, unknown>> | null): string => {
    if (style === null) return t('format.none');
    if (typeof style['format'] === 'string') return style['format'];
    switch (style['type']) {
      case 'currency':
        return t('format.currencyOf', {
          code: typeof style['currency_code'] === 'string' ? style['currency_code'] : '',
        });
      case 'plain':
        return style['percentage'] === true ? t('format.percent') : t('format.number');
      case 'progress':
        return t('format.progress');
      case 'rating':
        return t('format.rating');
      default:
        return t('format.none');
    }
  };
}

interface ShortcutPickerProps {
  readonly shortcuts: readonly LinkShortcut[];
  readonly active: LinkShortcut | undefined;
  readonly tableName: string;
  readonly onPick: (shortcut: LinkShortcut) => void;
  readonly onChange: () => void;
}

/** "Through a link field" (SPEC §5.8): the chosen link as a banner, else a picker. */
function ShortcutPicker({ shortcuts, active, tableName, onPick, onChange }: ShortcutPickerProps) {
  const { t } = useTranslation('lookup');
  const selectRef = useRef<HTMLSelectElement>(null);
  const [changing, setChanging] = useState(false);
  if (active !== undefined && !changing) {
    return (
      <div
        className="flex items-center gap-2 rounded-md bg-accent-soft px-2.5 py-2 text-label font-normal text-fg"
        data-testid="lookup-shortcut"
      >
        <Link2 aria-hidden="true" className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1">
          {t('shortcut.via')} <strong className="font-semibold">{active.linkField.name}</strong>{' '}
          {active.direction === 'out'
            ? t('shortcut.ofThisTable')
            : t('shortcut.ofTable', { table: active.sourceTable.name })}{' '}
          {t('shortcut.generated')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-accent"
          aria-label={t('shortcut.changeLabel')}
          onClick={() => {
            setChanging(true);
            onChange();
            window.requestAnimationFrame(() => selectRef.current?.focus());
          }}
        >
          {t('shortcut.change')}
        </Button>
      </div>
    );
  }
  if (shortcuts.length === 0) return null;
  return (
    <FormField label={t('shortcut.label')} hint={t('shortcut.hint', { table: tableName })}>
      {(control) => (
        <Select
          {...control}
          ref={selectRef}
          value=""
          data-testid="lookup-shortcut-select"
          onChange={(event) => {
            const picked = shortcuts.find((item) => item.key === event.currentTarget.value);
            if (picked === undefined) return;
            setChanging(false);
            onPick(picked);
          }}
        >
          <option value="">{t('shortcut.choose')}</option>
          {shortcuts.map((shortcut) => (
            <option key={shortcut.key} value={shortcut.key}>
              {t(shortcut.direction === 'out' ? 'shortcut.optionOut' : 'shortcut.optionIn', {
                field: shortcut.linkField.name,
                table: shortcut.sourceTable.name,
              })}
            </option>
          ))}
        </Select>
      )}
    </FormField>
  );
}

/** The chain of a `FORMULA_CYCLE`: field (table) → … → field. */
function CycleChain({
  steps,
  tables,
}: {
  steps: readonly { id: string; name: string; tableId: string }[];
  tables: readonly TableDto[];
}) {
  const { t } = useTranslation('lookup');
  return (
    <Alert variant="danger" data-testid="lookup-cycle">
      <div className="flex flex-col gap-1.5">
        <p>{t('cycle.title')}</p>
        <ol className="flex flex-wrap items-center gap-1 text-label" aria-label={t('cycle.chain')}>
          {steps.map((step, index) => {
            const table = tables.find((item) => item.id === step.tableId)?.name;
            return (
              <li key={`${step.id}:${String(index)}`} className="flex items-center gap-1">
                {index === 0 ? null : (
                  <ArrowRight aria-hidden="true" className="size-3.5 text-fg-muted" />
                )}
                <span className="rounded-sm bg-surface-sunken px-1.5 py-0.5">
                  {step.name || t('cycle.hidden')}
                  {table === undefined ? null : <span className="text-fg-muted"> · {table}</span>}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="text-label font-normal text-fg-muted">{t('cycle.hint')}</p>
      </div>
    </Alert>
  );
}

/**
 * Create or edit a lookup field (T467, SPEC §5.8, board "S4b · Cấu hình
 * tra cứu"): the source table and field ("Get data from"), the shortcut
 * "through a link field", 1–5 conditions (all / any) on source fields with
 * a constant or a field of this table, the aggregation valid for the field
 * taken and the result format (the source's by default: currency for a
 * sum of amounts). The right pane previews the first 5 records through the
 * server (debounced, older requests cancelled). Only tables and fields the
 * user reads are listed (the API leaves the others out). The field dialog
 * saves; its errors are placed on the controls they name, a reference cycle
 * shows its chain. Below 768 px the dialog fills the screen.
 */
export function LookupFieldEditor({
  tableId,
  field,
  convertingFieldId,
  name,
  description,
  onNameChange,
  onDescriptionChange,
  typePicker,
  onSave,
  saving,
  saveError,
  onClose,
  WhereEditor,
}: LookupFieldEditorWithWhereProps) {
  const { t, i18n } = useTranslation(['lookup', 'field', 'common', 'errors']);
  // The field being edited or converted (T469) is never a choice of its own lookup.
  const selfId = field?.id ?? convertingFieldId;
  const styleText = useStyleText();
  const conditionsLabelId = useId();
  const table = useQuery(tableQuery(tableId));
  const baseId = table.data?.base_id;
  const base = useQuery({ ...baseQuery(baseId ?? ''), enabled: baseId !== undefined });
  const orgId = base.data?.organization_id ?? '';
  const org = useQuery({ ...orgQuery(orgId), enabled: orgId !== '' });
  const tables = useQuery({ ...tablesQuery(baseId ?? ''), enabled: baseId !== undefined });
  const tableList = useMemo(() => tables.data?.items ?? [], [tables.data]);
  const recordCount = useQuery(tableRecordCountQuery(tableId));
  const ownFields = useQuery(fieldsQuery(tableId));
  const currentFields = useMemo(
    () => (ownFields.data?.items ?? []).filter((item) => item.id !== selfId),
    [ownFields.data, selfId],
  );
  const definition = hasDefinition(field);

  const [draft, setDraft] = useState<LookupDraft>(() => lookupDraftOf(field));
  // Stored operators are shown under their labels once the source fields are known.
  const [touched, setTouched] = useState(false);
  const sourceFieldsQuery = useQuery({ ...fieldsQuery(draft.from), enabled: draft.from !== '' });
  const sourceFields = useMemo(
    () => (sourceFieldsQuery.data?.items ?? []).filter((item) => item.id !== selfId),
    [sourceFieldsQuery.data, selfId],
  );
  const [normalized, setNormalized] = useState(false);
  if (!normalized && !touched && field !== undefined && sourceFieldsQuery.data !== undefined) {
    setNormalized(true);
    setDraft(lookupDraftOf(field, sourceFields));
  }
  const [submitted, setSubmitted] = useState(false);

  // Link fields of every readable table (shortcuts through links pointing here).
  const tableFields = useQueries({
    queries: tableList.map((item) => fieldsQuery(item.id)),
  });
  const shortcuts = useMemo(() => {
    const byTable = new Map<string, readonly FieldDto[]>();
    tableList.forEach((item, index) => {
      const items = tableFields[index]?.data?.items;
      if (items !== undefined) byTable.set(item.id, items);
    });
    return linkShortcuts(tableId, currentFields, tableList, (id) => byTable.get(id));
  }, [tableList, tableFields, tableId, currentFields]);
  const activeShortcut = shortcuts.find((item) => item.key === draft.shortcut);

  const fallbackCurrency =
    org.data?.settings.currency ?? (i18n.language.startsWith('vi') ? 'VND' : 'USD');
  const built = useMemo(
    () => buildOptions(draft, sourceFields, currentFields, fallbackCurrency),
    [draft, sourceFields, currentFields, fallbackCurrency],
  );
  const previewBody = useMemo(
    () =>
      built.options === null || !definition
        ? null
        : {
            type: 'lookup' as const,
            options: { ...built.options },
            ...(field === undefined ? {} : { field_id: field.id }),
          },
    [built.options, definition, field],
  );
  const preview = useLookupPreview(tableId, previewBody);

  const change = (next: LookupDraft) => {
    setTouched(true);
    setDraft(next);
  };

  // Errors: of the last save, else of the preview (the same checks, `422`).
  const previewInvalid =
    isApiError(preview.error) && preview.error.status === 422 ? preview.error : null;
  const placed = placeErrors(saveError ?? previewInvalid);
  const cycle = placed.apiError === null ? null : cycleOf(placed.apiError);
  const detailText = (items: ApiError['errors'] | undefined) =>
    items === undefined || items.length === 0
      ? undefined
      : items
          .map((item) =>
            item.code === 'NAME_CONFLICT'
              ? t('field:validation.NAME_CONFLICT')
              : translateDetail(i18n, item),
          )
          .join(' ');
  const required = translateDetail(i18n, { code: 'REQUIRED' });

  const selectField = sourceFields.find((item) => item.id === draft.select);
  const sourceTable = tableList.find((item) => item.id === draft.from);
  const aggregates = aggregatesFor(selectField);
  const resultKind = resultKindOf(selectField, draft.aggregate);
  const styleChoices = styleChoicesFor(selectField, draft.aggregate, DATETIME_FORMATS, draft.style);
  const sourceStyle = sourceStyleOf(selectField);

  const nameError =
    submitted && name.trim() === '' ? required : detailText(placed.byTarget.get('name'));
  const fromError =
    submitted && draft.from === '' ? required : detailText(placed.byTarget.get('from'));
  const selectError =
    submitted && draft.from !== '' && draft.select === ''
      ? required
      : detailText(placed.byTarget.get('select'));
  const aggregateError = detailText(placed.byTarget.get('aggregate'));
  const styleError = detailText(placed.byTarget.get('style'));

  const whereIssues = (() => {
    const map = new Map<string, string>();
    const add = (key: string, text: string) => {
      map.set(key, map.has(key) ? `${map.get(key) ?? ''} ${text}` : text);
    };
    for (const [key, codes] of built.issues) {
      for (const code of codes) add(key, translateDetail(i18n, { code }));
    }
    const server = placed.byTarget.get('where') ?? [];
    const serverKeys = issuesByKey(server, built.keys);
    for (const [key, codes] of serverKeys) {
      for (const code of codes) {
        const item = server.find((candidate) => candidate.code === code);
        add(key, translateDetail(i18n, item ?? { code }));
      }
    }
    if (
      submitted &&
      draft.conditions.conditions.length === 0 &&
      draft.conditions.advanced === undefined
    ) {
      add('', t('lookup:conditions.atLeastOne'));
    }
    return map;
  })();

  const shownPaths = placed.apiError?.errors.map((item) => item.path) ?? [];
  const otherError =
    saveError !== null &&
    saveError !== undefined &&
    cycle === null &&
    !(isApiError(saveError) && saveError.code === 'NAME_CONFLICT') &&
    (!isApiError(saveError) || saveError.errors.length === 0 || placed.byTarget.has('other'))
      ? saveError
      : null;

  const formRef = useRef<HTMLFormElement>(null);
  /** After a refused save, the first control with a problem gets the focus. */
  const focusFirstProblem = () => {
    window.requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  };
  const save = () => {
    setSubmitted(true);
    if (name.trim() === '') {
      focusFirstProblem();
      return;
    }
    if (!definition) {
      onSave(null);
      return;
    }
    if (built.options === null) {
      focusFirstProblem();
      return;
    }
    onSave(field === undefined ? built.options : changedOptions(field, built.options));
  };
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    save();
  };

  const tableName = table.data?.name ?? '';
  const primaryName =
    ownFields.data?.items.find((item) => item.is_primary)?.name ?? t('lookup:preview.record');

  const sourcePicker = (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 text-label text-fg">{t('lookup:source.legend')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <FormField
          label={<span className="sr-only">{t('lookup:source.table')}</span>}
          error={fromError}
        >
          {(control) => (
            <Select
              {...control}
              value={draft.from}
              data-testid="lookup-from"
              onChange={(event) => {
                change(withSource(draft, event.currentTarget.value));
              }}
            >
              <option value="" disabled>
                {t('lookup:source.chooseTable')}
              </option>
              {tableList.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id === tableId
                    ? t('lookup:source.thisTable', { table: item.name })
                    : item.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField
          label={<span className="sr-only">{t('lookup:source.field')}</span>}
          error={selectError}
        >
          {(control) => (
            <Select
              {...control}
              value={draft.select}
              disabled={draft.from === ''}
              data-testid="lookup-select"
              onChange={(event) => {
                const next = sourceFields.find((item) => item.id === event.currentTarget.value);
                change(withSelect(draft, next));
              }}
            >
              <option value="" disabled>
                {t('lookup:source.chooseField')}
              </option>
              {sourceFields.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      <ShortcutPicker
        shortcuts={shortcuts}
        active={activeShortcut}
        tableName={tableName}
        onPick={(shortcut) => {
          change(applyShortcut(draft, shortcut));
        }}
        onChange={() => {
          change({ ...draft, shortcut: null });
        }}
      />
    </fieldset>
  );

  const sourceChoiceText = (() => {
    if (resultKind === 'values') {
      return t('lookup:format.sourceLocked', { style: styleText(sourceStyle) });
    }
    return carriesSourceStyle(selectField, draft.aggregate)
      ? t('lookup:format.source', { style: styleText(sourceStyle) })
      : t('lookup:format.default');
  })();
  const choiceText = (choice: StyleChoice): string => {
    switch (choice) {
      case 'source':
        return sourceChoiceText;
      case 'custom':
        return t('lookup:format.custom');
      case 'number:plain':
        return t('lookup:format.number');
      case 'number:decimal':
        return t('lookup:format.decimal');
      case 'number:percent':
        return t('lookup:format.percent');
      case 'number:currency':
        return t('lookup:format.currencyOf', {
          code:
            draft.currency ??
            (sourceStyle !== null && typeof sourceStyle['currency_code'] === 'string'
              ? sourceStyle['currency_code']
              : fallbackCurrency),
        });
      default:
        return choice.slice('date:'.length);
    }
  };

  const resultControls = (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <FormField label={t('lookup:aggregate.label')} error={aggregateError}>
        {(control) => (
          <Select
            {...control}
            value={draft.aggregate}
            disabled={selectField === undefined}
            data-testid="lookup-aggregate"
            onChange={(event) => {
              const aggregate = event.currentTarget.value as LookupFieldAggregate;
              change({ ...draft, aggregate, style: 'source' });
            }}
          >
            {aggregates.map((aggregate) => (
              <option key={aggregate} value={aggregate}>
                {t(`lookup:aggregate.options.${aggregate}`)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField
        label={t('lookup:format.label')}
        error={styleError}
        hint={
          resultKind === 'values' && selectField !== undefined
            ? t('lookup:format.lockedHint', {
                field: selectField.name,
                table: sourceTable?.name ?? '',
              })
            : undefined
        }
      >
        {(control) => (
          <Select
            {...control}
            value={draft.style}
            disabled={selectField === undefined || resultKind === 'values'}
            data-testid="lookup-style"
            onChange={(event) => {
              change({ ...draft, style: event.currentTarget.value as StyleChoice });
            }}
          >
            {styleChoices.map((choice) => (
              <option key={choice} value={choice}>
                {choiceText(choice)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
    </div>
  );

  const footerHint =
    preview.preview === undefined
      ? null
      : preview.preview.compute_mode === 'virtual'
        ? t('lookup:footer.virtual')
        : t('lookup:footer.background', { count: recordCount.data?.count ?? 0 });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {field === undefined && convertingFieldId === undefined
            ? t('field:dialog.createTitle')
            : t('field:dialog.editTitle')}
          {tableName === '' ? null : (
            <span className="text-label font-normal text-fg-muted">
              {t('field:convert.tableOf', { table: tableName })}
            </span>
          )}
        </span>
      }
      closeLabel={t('common:actions.close')}
      className="max-w-[1060px] max-md:m-0 max-md:h-dvh max-md:max-h-none max-md:w-full max-md:max-w-none max-md:overflow-y-auto max-md:rounded-none max-md:border-0"
    >
      <form
        ref={formRef}
        noValidate
        className="flex flex-col"
        onSubmit={onSubmit}
        data-testid="lookup-editor"
      >
        <div className="-mx-6 grid border-y border-line md:max-h-[min(720px,calc(100dvh-12rem))] md:grid-cols-[minmax(0,460px)_minmax(0,1fr)] md:overflow-hidden">
          <div className="flex min-w-0 flex-col gap-4 p-5 md:overflow-y-auto md:border-r md:border-line">
            <FormField label={t('field:name')} error={nameError}>
              {(control) => (
                <Input
                  {...control}
                  autoComplete="off"
                  maxLength={255}
                  value={name}
                  onChange={(event) => {
                    onNameChange(event.target.value);
                  }}
                />
              )}
            </FormField>
            {typePicker}
            {definition ? (
              <>
                {sourcePicker}
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span id={conditionsLabelId} className="text-label text-fg">
                    {t('lookup:conditions.label')}
                  </span>
                  {draft.from === '' ? (
                    <p className="text-body text-fg-muted">{t('lookup:conditions.chooseSource')}</p>
                  ) : (
                    <WhereEditor
                      sourceFields={sourceFields}
                      sourceTableName={sourceTable?.name}
                      currentFields={currentFields}
                      currentTableId={tableId}
                      currentTableName={tableName}
                      orgId={orgId}
                      value={draft.conditions}
                      onChange={(conditions) => {
                        change({
                          ...draft,
                          conditions,
                          shortcut: conditions.conditions.some((item) => item.auto === true)
                            ? draft.shortcut
                            : null,
                        });
                      }}
                      issues={whereIssues}
                      showIncomplete={submitted}
                      labelledBy={conditionsLabelId}
                    />
                  )}
                  <p className="text-label font-normal text-fg-muted">
                    {t('lookup:conditions.hint')}
                  </p>
                </div>
                {resultControls}
                {cycle === null ? null : <CycleChain steps={cycle} tables={tableList} />}
              </>
            ) : (
              <Alert variant="info" data-testid="lookup-no-definition">
                <p>{t('lookup:noDefinition')}</p>
              </Alert>
            )}
            <FormField label={t('field:description')}>
              {(control) => (
                <textarea
                  {...control}
                  rows={2}
                  maxLength={2000}
                  className={TEXTAREA_CLASSES}
                  value={description}
                  onChange={(event) => {
                    onDescriptionChange(event.target.value);
                  }}
                />
              )}
            </FormField>
            {otherError === null ? null : <ErrorAlert error={otherError} hidePaths={shownPaths} />}
          </div>
          <div className="flex min-w-0 flex-col gap-4 bg-surface-sunken/40 p-5 md:overflow-y-auto">
            <LookupPreview
              tableId={tableId}
              orgId={orgId}
              titleHeader={primaryName}
              preview={preview.preview}
              idle={previewBody === null}
              loading={preview.loading}
              stale={preview.stale}
              error={preview.error}
              onRetry={preview.retry}
              sourceName={sourceTable?.name}
            />
          </div>
        </div>
        <div className="-mx-6 -mb-6 flex flex-wrap items-center gap-2 bg-surface px-5 py-3 max-md:sticky max-md:bottom-0 max-md:border-t max-md:border-line">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label font-normal text-fg-muted max-md:basis-full">
            {footerHint === null ? null : (
              <>
                <History aria-hidden="true" className="size-3.5 shrink-0" />
                {footerHint}
              </>
            )}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" disabled={saving} data-testid="lookup-save">
            {saving ? <Spinner /> : null}
            {convertingFieldId === undefined ? t('lookup:save') : t('field:convert.computed.next')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default LookupFieldEditor;
