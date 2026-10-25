import type { WidgetDataColumn, WidgetDataDto } from '@cellhive/contracts';

/** Builders of widget data for the dashboard tests (CONTRACTS §28.3). */

export const DIMENSION_FIELD = 'fld_Status0000000001';
export const SERIES_FIELD = 'fld_Region0000000001';
export const AMOUNT_FIELD = 'fld_Amount0000000001';

export function column(
  overrides: Partial<WidgetDataColumn> & Pick<WidgetDataColumn, 'key' | 'role'>,
): WidgetDataColumn {
  return {
    field_id: null,
    field_type: null,
    aggregation: null,
    date_bucket: null,
    bucket_width: null,
    ...overrides,
  };
}

export const dimensionColumn = (overrides: Partial<WidgetDataColumn> = {}) =>
  column({
    key: 'dimension',
    role: 'dimension',
    field_id: DIMENSION_FIELD,
    field_type: 'text',
    ...overrides,
  });

export const seriesColumn = (overrides: Partial<WidgetDataColumn> = {}) =>
  column({
    key: 'series',
    role: 'series',
    field_id: SERIES_FIELD,
    field_type: 'text',
    ...overrides,
  });

export const metricColumn = (key: string, overrides: Partial<WidgetDataColumn> = {}) =>
  column({ key, role: 'metric', aggregation: 'count', ...overrides });

export const cell = (value: string | number | boolean | null, label: string | null = null) => ({
  value,
  label,
});

export function widgetData(overrides: Partial<WidgetDataDto> = {}): WidgetDataDto {
  return {
    status: 'ok',
    columns: [],
    rows: [],
    computed_at: '2026-10-25T00:00:00.000Z',
    cache: 'miss',
    ignored_filters: [],
    ...overrides,
  };
}

export const PALETTE = ['#c0', '#c1', '#c2', '#c3', '#c4', '#c5', '#c6', '#c7'];
export const COLORS = { palette: PALETTE, other: '#other' };
export const THEME = {
  text: '#text',
  muted: '#muted',
  line: '#line',
  surface: '#surface',
  font: 'Inter',
};
