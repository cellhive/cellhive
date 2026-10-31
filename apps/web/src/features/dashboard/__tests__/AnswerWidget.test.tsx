import { render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import AnswerWidget from '../widgets/AnswerWidget';

import {
  AMOUNT_FIELD,
  cell,
  DIMENSION_FIELD,
  dimensionColumn,
  metricColumn,
  widgetData,
} from './fixtures';

import type { AskAnswerWidgetProps } from '../../../lib/ai/ask';
import type { FieldDto } from '@cellhive/contracts';

vi.mock('../charts/EChart', () => ({
  default: ({ label, testId }: { label: string; testId?: string }) => (
    <div role="img" aria-label={label} data-testid={testId} />
  ),
}));

/**
 * T914: an "Ask AI" answer drawn by the widget renderer of dashboards — a
 * KPI formatted by its field, a pivot table, a chart with its text
 * alternative, "no records" when nothing matched.
 */

const FIELDS = [
  {
    id: AMOUNT_FIELD,
    name: 'amount',
    type: 'number',
    options: { style: { format: 'currency', currency: 'VND' } },
  },
  { id: DIMENSION_FIELD, name: 'Status', type: 'text', options: {} },
] as unknown as FieldDto[];
const sum = { id: 'm1', aggregation: 'sum', field: AMOUNT_FIELD, label: null, color: null };
const byStatus = { field: DIMENSION_FIELD, date_bucket: null, bucket_width: null };

async function draw(props: Omit<AskAnswerWidgetProps, 'fields'>) {
  const i18n = await createTestI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <AnswerWidget {...props} fields={FIELDS} />
    </I18nextProvider>,
  );
}

const widget = (type: string, title: string, config: Record<string, unknown>) =>
  ({ type, title, config: { table_id: 'tbl_Orders0000000001', ...config } }) as never;

describe('AnswerWidget (T914)', () => {
  it('a KPI, formatted by its field', async () => {
    await draw({
      widget: widget('kpi', 'Revenue', { metrics: [sum] }),
      data: widgetData({
        columns: [metricColumn('m1', { aggregation: 'sum' })],
        rows: [[1_500_000]],
      }),
    });
    expect(screen.getByTestId('kpi-value').textContent).toMatch(/1,500,000/u);
  });

  it('a pivot table', async () => {
    const data = widgetData({
      columns: [dimensionColumn(), metricColumn('m1', { aggregation: 'sum' })],
      rows: [
        [cell('Mới'), 100],
        [cell('Xong'), 200],
      ],
    });
    await draw({
      widget: widget('table', 'By status', {
        table: {
          mode: 'pivot',
          dimension: byStatus,
          metrics: [sum],
          sort: 'metric_desc',
          limit: 20,
        },
      }),
      data,
    });
    const table = screen.getByTestId('widget-pivot');
    expect(within(table).getByRole('rowheader', { name: 'Xong' })).toBeVisible();
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Status', 'Sum of amount']);
  });

  it('a chart with its summary', async () => {
    await draw({
      widget: widget('bar', 'By status', { metrics: [sum], dimension: byStatus }),
      data: widgetData({
        columns: [dimensionColumn(), metricColumn('m1', { aggregation: 'sum' })],
        rows: [[cell('Mới'), 100]],
      }),
    });
    expect((await screen.findByRole('img')).getAttribute('aria-label')).toContain('By status');
    expect(screen.getByRole('button', { name: 'View as table' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('nothing matched', async () => {
    await draw({
      widget: widget('bar', 'By status', { metrics: [sum], dimension: byStatus, filter: null }),
      data: widgetData({ status: 'empty' }),
    });
    expect(screen.getByTestId('widget-state')).toHaveAttribute('data-state', 'empty');
  });
});
