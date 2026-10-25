import { WIDGET_TYPES, type WidgetType } from '@cellhive/contracts';
import { Dialog, FormField, Select } from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  Combine,
  Gauge,
  LineChart,
  ListFilter,
  PieChart,
  Table2,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fieldsQuery, tablesQuery } from '../../../lib/query/queries';

import { defaultConfig, defaultSize } from './widget-defaults';

import type { WidgetContent } from './editor-session';

const ICONS: Readonly<Record<WidgetType, LucideIcon>> = {
  kpi: Gauge,
  bar: BarChart3,
  line: LineChart,
  pie: PieChart,
  combo: Combine,
  table: Table2,
  text: Type,
  filter_control: ListFilter,
};

export interface WidgetLibraryProps {
  readonly open: boolean;
  readonly baseId: string;
  readonly onClose: () => void;
  readonly onAdd: (
    type: WidgetType,
    content: WidgetContent,
    size: { readonly w: number; readonly h: number },
  ) => void;
}

/**
 * "Add widget" (T812, S7 decision #6): the eight widget types with what
 * each shows, and the table a data widget reads. The new widget starts
 * with settings that work for that table, then its settings panel opens.
 */
export function WidgetLibrary({ open, baseId, onClose, onAdd }: WidgetLibraryProps) {
  const { t } = useTranslation('dashboard');
  const queryClient = useQueryClient();
  const tables = useQuery({ ...tablesQuery(baseId), enabled: open });
  const [chosenTable, setChosenTable] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items = tables.data?.items ?? [];
  const tableId = chosenTable ?? items[0]?.id ?? null;

  const add = async (type: WidgetType) => {
    setProblem(null);
    if (type === 'text') {
      onAdd(type, { title: '', config: { markdown: '' } }, defaultSize(type));
      return;
    }
    if (tableId === null) {
      setProblem(t('edit.library.noTable'));
      return;
    }
    setBusy(true);
    try {
      const fields = await queryClient.query(fieldsQuery(tableId));
      const config = defaultConfig(type, tableId, fields.items);
      if (config === null) {
        setProblem(t('edit.library.noField', { type: t(`type.${type}`) }));
        return;
      }
      onAdd(type, { title: '', config }, defaultSize(type));
    } catch {
      setProblem(t('edit.library.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setProblem(null);
          onClose();
        }
      }}
      title={t('edit.library.title')}
      description={t('edit.library.description')}
      closeLabel={t('edit.library.close')}
      layout="sheet"
      className="sm:max-w-xl"
    >
      <div className="flex flex-col gap-4" data-testid="widget-library">
        <FormField label={t('edit.library.table')}>
          {(control) => (
            <Select
              {...control}
              value={tableId ?? ''}
              disabled={items.length === 0}
              onChange={(event) => {
                setChosenTable(event.currentTarget.value);
              }}
            >
              {items.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {WIDGET_TYPES.map((type) => {
            const Icon = ICONS[type];
            return (
              <li key={type}>
                <button
                  type="button"
                  disabled={busy}
                  data-testid={`widget-library-${type}`}
                  onClick={() => {
                    void add(type);
                  }}
                  className="flex min-h-control w-full items-start gap-3 rounded-lg border border-line bg-surface p-3 text-left hover:border-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
                >
                  <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-body font-semibold text-fg">{t(`type.${type}`)}</span>
                    <span className="text-label font-normal text-fg-muted">
                      {t(`edit.library.about.${type}`)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {problem === null ? null : (
          <p role="alert" className="text-body text-danger">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
}
