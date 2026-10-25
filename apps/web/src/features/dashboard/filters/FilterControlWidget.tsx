import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type WidgetDataContext } from '../api';
import { TEST_IDS } from '../test-ids';
import { useDashboardDataSource } from '../view/data-source';
import { WidgetMessage } from '../widgets/WidgetMessage';

import {
  DateRangeControl,
  NumberRangeControl,
  OptionsControl,
  TextControl,
  type ControlProps,
} from './controls';
import { parentFiltersFor } from './filter-state';
import { useDashboardFilters } from './use-dashboard-filters';
import { useDebounced } from './use-debounced';

import type { FilterControlKind, WidgetDto } from '@cellhive/contracts';

const NO_ITEMS: readonly [] = [];

/**
 * A `filter_control` widget (T813, CONTRACTS §28.2, §28.4): the viewer
 * picks a value, every widget that follows the control (`filter_bindings`)
 * is filtered. `select`, `user` and `text` offer the values of the field
 * among the records the viewer reads (`POST …/options`), narrowed by the
 * parent controls (cascading slicers: province → district); a new parent
 * value clears the children. In the editor the control only shows what it
 * is (filters apply in view mode).
 */
export function FilterControlWidget({
  widget,
  title,
  context,
}: {
  readonly widget: WidgetDto;
  readonly title: string;
  readonly context: WidgetDataContext;
}) {
  const { t } = useTranslation('dashboard');
  const filters = useDashboardFilters();
  const source = useDashboardDataSource();
  const kind = (widget.config as { control?: FilterControlKind }).control ?? 'select';
  if (!filters.enabled) {
    return (
      <WidgetMessage
        kind="empty"
        title={
          source.filtersOff === 'link'
            ? t('filters.offOnLink')
            : t('filters.editing', { kind: t(`edit.panel.controls.${kind}`) })
        }
        testId={TEST_IDS.widgetState}
      />
    );
  }
  const props: ControlProps = {
    label: title,
    hideLabel: true,
    value: filters.state.controls[widget.id] ?? null,
    onChange: (value) => {
      filters.setControl(widget.id, value);
    },
    testId: `filter-control-${widget.id}`,
  };
  switch (kind) {
    case 'date_range':
      return <DateRangeControl {...props} />;
    case 'number_range':
      return <NumberRangeControl {...props} />;
    case 'text':
      return <TextControl {...props} />;
    case 'select':
    case 'user':
      return <ValuesControl widget={widget} context={context} props={props} />;
  }
}

function ValuesControl({
  widget,
  context,
  props,
}: {
  readonly widget: WidgetDto;
  readonly context: WidgetDataContext;
  readonly props: ControlProps;
}) {
  const { t } = useTranslation('dashboard');
  const { state, dashboard } = useDashboardFilters();
  const source = useDashboardDataSource();
  const [search, setSearch] = useState('');
  const deferred = useDebounced(search.trim(), 300);
  const parents = useMemo(
    () => parentFiltersFor(widget, state, dashboard.widgets),
    [widget, state, dashboard.widgets],
  );
  const options = useQuery(source.widgetOptions(widget, context, parents, deferred));
  if (options.data?.status === 'no_permission') {
    return (
      <WidgetMessage
        kind="no_permission"
        title={t('filters.noPermission')}
        testId={TEST_IDS.widgetState}
      />
    );
  }
  if (options.data?.status === 'broken') {
    return (
      <WidgetMessage kind="broken" title={t('state.broken.title')} testId={TEST_IDS.widgetState} />
    );
  }
  return (
    <OptionsControl
      {...props}
      multiple
      source={{
        items: options.data?.items ?? NO_ITEMS,
        hasMore: options.data?.has_more ?? false,
        loading: options.isPending || options.isFetching,
        failed: options.isError,
        search,
        onSearch: setSearch,
      }}
    />
  );
}
