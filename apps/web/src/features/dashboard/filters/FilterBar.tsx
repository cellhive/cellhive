import { Button, cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { FilterX, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDashboardDataSource, type DashboardDataSource } from '../view/data-source';

import {
  DateRangeControl,
  NumberRangeControl,
  OptionsControl,
  TextControl,
  type ControlProps,
} from './controls';
import { hasActiveFilters } from './filter-state';
import { useDashboardFilters } from './use-dashboard-filters';

import type { DashboardGlobalFilter, WidgetGroupValue } from '@cellhive/contracts';

/**
 * (T813, research §5.4) The filter bar, sticky at the top of the dashboard:
 * the global filters (SPEC §10.3: one value for every widget on a table
 * they target), a chip per cross-filter ("Filtered by: Urgent ×", removed
 * by its button or by clicking the group again) and "Clear filters". It is
 * not shown while there is nothing in it.
 */
export function FilterBar({
  baseId,
  className,
}: {
  readonly baseId: string;
  readonly className?: string;
}) {
  const { t } = useTranslation('dashboard');
  const filters = useDashboardFilters();
  const { state, dashboard } = filters;
  const active = hasActiveFilters(state);
  if (dashboard.global_filters.length === 0 && !active) return null;
  return (
    <div
      role="search"
      aria-label={t('filters.bar')}
      data-testid="dashboard-filter-bar"
      className={cn(
        'sticky top-0 z-20 flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-line bg-canvas py-3',
        className,
      )}
    >
      {dashboard.global_filters.map((filter, index) => (
        <GlobalFilterControl key={filter.id} baseId={baseId} filter={filter} position={index + 1} />
      ))}
      {state.cross.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-2" aria-label={t('filters.crossList')}>
          {state.cross.map((cross) => {
            const source = dashboard.widgets.find((widget) => widget.id === cross.widgetId);
            const widgetName =
              source === undefined || source.title.trim() === ''
                ? t(`type.${source?.type ?? 'bar'}`)
                : source.title;
            return (
              <li
                key={cross.widgetId}
                data-testid={`cross-chip-${cross.widgetId}`}
                className="flex h-control items-center gap-1 rounded-full border border-accent bg-accent-soft pr-1 pl-3 text-body text-fg"
              >
                <span className="truncate">{t('filters.crossChip', { value: cross.label })}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 rounded-full max-lg:size-control"
                  aria-label={t('filters.removeCross', { value: cross.label, widget: widgetName })}
                  onClick={() => {
                    filters.removeCross(cross.widgetId);
                  }}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {active ? (
        <Button
          variant="ghost"
          className="ml-auto"
          data-testid="dashboard-clear-filters"
          onClick={filters.clear}
        >
          <FilterX aria-hidden="true" />
          {t('filters.clear')}
        </Button>
      ) : null}
    </div>
  );
}

function GlobalFilterControl({
  baseId,
  filter,
  position,
}: {
  readonly baseId: string;
  readonly filter: DashboardGlobalFilter;
  readonly position: number;
}) {
  const { t } = useTranslation('dashboard');
  const filters = useDashboardFilters();
  const source = useDashboardDataSource();
  const label =
    filter.label === null || filter.label === ''
      ? t('filters.globalUnnamed', { position })
      : filter.label;
  const props: ControlProps = {
    label,
    inline: true,
    value: filters.state.global[filter.id] ?? null,
    onChange: (value) => {
      filters.setGlobal(filter.id, value);
    },
    testId: `global-filter-${filter.id}`,
  };
  switch (filter.kind) {
    case 'date_range':
      return <DateRangeControl {...props} />;
    case 'number_range':
      return <NumberRangeControl {...props} />;
    case 'text':
      return <TextControl {...props} />;
    case 'select':
      return <GlobalSelectControl filter={filter} props={props} />;
    case 'user':
      // (T814) No member list through a share link: such a filter is not offered there.
      return source.members === null ? null : (
        <GlobalUserControl baseId={baseId} members={source.members} props={props} />
      );
  }
}

/** Items matching a local search (global filters list what the field declares). */
function useLocalSearch(items: readonly WidgetGroupValue[]) {
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return needle === ''
      ? items
      : items.filter((item) =>
          (item.label ?? String(item.value)).toLocaleLowerCase().includes(needle),
        );
  }, [items, search]);
  return { search, setSearch, shown };
}

interface FieldOption {
  readonly id: string;
  readonly name: string;
}

/** A global `select` filter: the options of the field it targets (the first target's). */
function GlobalSelectControl({
  filter,
  props,
}: {
  readonly filter: DashboardGlobalFilter;
  readonly props: ControlProps;
}) {
  const target = filter.targets[0];
  const source = useDashboardDataSource();
  const fields = useQuery({
    ...source.fields(target?.table_id ?? ''),
    enabled: target !== undefined,
  });
  const items = useMemo<WidgetGroupValue[]>(() => {
    const field = fields.data?.items.find((item) => item.id === target?.field);
    const options = (field?.options as { options?: FieldOption[] } | undefined)?.options ?? [];
    return options.map((option) => ({ value: option.id, label: option.name }));
  }, [fields.data, target?.field]);
  const { search, setSearch, shown } = useLocalSearch(items);
  return (
    <OptionsControl
      {...props}
      multiple
      source={{
        items: shown,
        hasMore: false,
        loading: fields.isPending,
        failed: fields.isError,
        search,
        onSearch: setSearch,
      }}
    />
  );
}

/** A global `user` filter: the people who can open the base. */
function GlobalUserControl({
  baseId,
  members: membersQuery,
  props,
}: {
  readonly baseId: string;
  readonly members: NonNullable<DashboardDataSource['members']>;
  readonly props: ControlProps;
}) {
  const members = useQuery(membersQuery(baseId));
  const items = useMemo<WidgetGroupValue[]>(
    () =>
      (members.data?.items ?? []).map((member) => ({
        value: member.id,
        label: member.display_name,
      })),
    [members.data],
  );
  const { search, setSearch, shown } = useLocalSearch(items);
  return (
    <OptionsControl
      {...props}
      multiple
      source={{
        items: shown,
        hasMore: false,
        loading: members.isPending,
        failed: members.isError,
        search,
        onSearch: setSearch,
      }}
    />
  );
}
