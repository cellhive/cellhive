import { FILTER_CONTROL_KINDS, MAX_GLOBAL_FILTERS } from '@cellhive/contracts';
import { Button, Dialog, Input, Select } from '@cellhive/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fieldsQuery, tablesQuery } from '../../../lib/query/queries';

import { controlFields } from './field-kinds';

import type { DashboardGlobalFilter, FieldDto, FilterControlKind } from '@cellhive/contracts';

interface Draft {
  readonly id: string;
  readonly label: string;
  readonly kind: FilterControlKind;
  /** Field by table id (`''`: that table is not filtered). */
  readonly targets: Readonly<Record<string, string>>;
}

function toDraft(filter: DashboardGlobalFilter): Draft {
  return {
    id: filter.id,
    label: filter.label ?? '',
    kind: filter.kind,
    targets: Object.fromEntries(filter.targets.map((target) => [target.table_id, target.field])),
  };
}

function fromDraft(draft: Draft): DashboardGlobalFilter {
  const label = draft.label.trim();
  return {
    id: draft.id,
    label: label === '' ? null : label,
    kind: draft.kind,
    targets: Object.entries(draft.targets)
      .filter(([, field]) => field !== '')
      .map(([table, field]) => ({
        table_id: table as DashboardGlobalFilter['targets'][number]['table_id'],
        field: field as DashboardGlobalFilter['targets'][number]['field'],
      })),
  };
}

/** A new id, unique in the list (`[A-Za-z0-9_-]{1,32}`, CONTRACTS §28.1). */
function newId(existing: readonly Draft[]): string {
  let index = existing.length + 1;
  while (existing.some((draft) => draft.id === `f${String(index)}`)) index += 1;
  return `f${String(index)}`;
}

/**
 * (T813, SPEC §10.3) Global filters of a dashboard, for base admins in edit
 * mode: each has a name, a kind (date range, options, people, text, number
 * range) and, per table of the base, the field it filters there (fields
 * that do not fit the kind are not offered). Viewers pick the value in the
 * filter bar. Saved together with "Save" (one undo step); each filter needs
 * at least one table.
 */
export function GlobalFiltersDialog({
  open,
  baseId,
  filters,
  onSave,
  onClose,
}: {
  readonly open: boolean;
  readonly baseId: string;
  readonly filters: readonly DashboardGlobalFilter[];
  readonly onSave: (filters: DashboardGlobalFilter[]) => void;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('dashboard');
  // The editor mounts the dialog anew on each opening: the draft starts from the saved list.
  const [drafts, setDrafts] = useState<Draft[]>(() => filters.map(toDraft));
  const [tried, setTried] = useState(false);
  const tables = useQuery({ ...tablesQuery(baseId), enabled: open });
  const tableList = tables.data?.items ?? [];
  const fieldLists = useQueries({
    queries: tableList.map((table) => ({ ...fieldsQuery(table.id), enabled: open })),
  });
  const fieldsOf = (index: number): readonly FieldDto[] => fieldLists[index]?.data?.items ?? [];
  const invalid = drafts.some((draft) =>
    Object.values(draft.targets).every((field) => field === ''),
  );
  const update = (index: number, change: (draft: Draft) => Draft) => {
    setDrafts((current) => current.map((draft, at) => (at === index ? change(draft) : draft)));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('edit.globalFilters.title')}
      description={t('edit.globalFilters.description')}
      closeLabel={t('edit.globalFilters.close')}
      layout="sheet"
    >
      <div className="flex flex-col gap-4" data-testid="dashboard-global-filters-dialog">
        {drafts.length === 0 ? (
          <p className="text-body text-fg-muted">{t('edit.globalFilters.empty')}</p>
        ) : null}
        {drafts.map((draft, index) => (
          <FilterDraft
            key={draft.id}
            draft={draft}
            position={index + 1}
            tables={tableList}
            fieldsOf={fieldsOf}
            showError={tried}
            onChange={(change) => {
              update(index, change);
            }}
            onRemove={() => {
              setDrafts((current) => current.filter((_, at) => at !== index));
            }}
          />
        ))}
        <Button
          variant="secondary"
          className="self-start"
          disabled={drafts.length >= MAX_GLOBAL_FILTERS}
          onClick={() => {
            setDrafts((current) => [
              ...current,
              { id: newId(current), label: '', kind: 'date_range', targets: {} },
            ]);
          }}
        >
          <Plus aria-hidden="true" />
          {t('edit.globalFilters.add')}
        </Button>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={onClose}>
            {t('edit.globalFilters.cancel')}
          </Button>
          <Button
            onClick={() => {
              if (invalid) {
                setTried(true);
                return;
              }
              onSave(drafts.map(fromDraft));
              onClose();
            }}
          >
            {t('edit.globalFilters.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function FilterDraft({
  draft,
  position,
  tables,
  fieldsOf,
  showError,
  onChange,
  onRemove,
}: {
  readonly draft: Draft;
  readonly position: number;
  readonly tables: readonly { id: string; name: string }[];
  readonly fieldsOf: (index: number) => readonly FieldDto[];
  readonly showError: boolean;
  readonly onChange: (change: (draft: Draft) => Draft) => void;
  readonly onRemove: () => void;
}) {
  const { t } = useTranslation('dashboard');
  const id = useId();
  const missing = Object.values(draft.targets).every((field) => field === '');
  const name = draft.label.trim() === '' ? t('filters.globalUnnamed', { position }) : draft.label;
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <legend className="px-1 text-label font-semibold text-fg">{name}</legend>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-label`} className="text-label text-fg">
            {t('edit.globalFilters.name')}
          </label>
          <Input
            id={`${id}-label`}
            maxLength={100}
            value={draft.label}
            onChange={(event) => {
              const label = event.target.value;
              onChange((current) => ({ ...current, label }));
            }}
          />
        </div>
        <div className="flex min-w-40 flex-col gap-1">
          <label htmlFor={`${id}-kind`} className="text-label text-fg">
            {t('edit.panel.controlKind')}
          </label>
          <Select
            id={`${id}-kind`}
            value={draft.kind}
            onChange={(event) => {
              const kind = event.target.value as FilterControlKind;
              // Fields that fitted the old kind do not fit the new one.
              onChange((current) => ({ ...current, kind, targets: {} }));
            }}
          >
            {FILTER_CONTROL_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`edit.panel.controls.${kind}`)}
              </option>
            ))}
          </Select>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('edit.globalFilters.remove', { name })}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-label font-medium text-fg" id={`${id}-targets`}>
          {t('edit.globalFilters.targets')}
        </p>
        {tables.map((table, index) => {
          const fields = controlFields([...fieldsOf(index)], draft.kind);
          return (
            <div key={table.id} className="flex flex-wrap items-center gap-2">
              <label htmlFor={`${id}-${table.id}`} className="w-40 truncate text-body text-fg">
                {table.name}
              </label>
              <Select
                id={`${id}-${table.id}`}
                className="w-auto min-w-48 flex-1"
                value={draft.targets[table.id] ?? ''}
                aria-invalid={showError && missing}
                aria-describedby={showError && missing ? `${id}-error` : `${id}-targets`}
                onChange={(event) => {
                  const field = event.target.value;
                  onChange((current) => ({
                    ...current,
                    targets: { ...current.targets, [table.id]: field },
                  }));
                }}
              >
                <option value="">{t('edit.globalFilters.notFiltered')}</option>
                {fields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
              </Select>
            </div>
          );
        })}
        {showError && missing ? (
          <p id={`${id}-error`} className="text-label font-normal text-danger">
            {t('edit.globalFilters.needTarget')}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}
