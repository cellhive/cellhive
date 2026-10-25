import {
  DATE_BUCKETS,
  MAX_TABLE_WIDGET_FIELDS,
  MAX_TABLE_WIDGET_ROWS,
  MAX_WIDGET_LIMIT,
  METRIC_AGGREGATIONS,
  PREVIOUS_PERIOD_RANGES,
  RELATIVE_DATE_RANGES,
  WIDGET_SORTS,
  type FieldDto,
  type FilterControlKind,
  type MetricAggregation,
  type WidgetType,
} from '@cellhive/contracts';
import { Button, Checkbox, FormField, Input, Select } from '@cellhive/ui';
import { Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TextWidget } from '../../widgets/TextWidget';
import {
  controlFields,
  dateFields,
  groupableFields,
  metricFields,
  widgetFieldKind,
} from '../field-kinds';
import { availableControls, dimensionOf, nextMetricId } from '../widget-defaults';

import { arrayAt, getIn, stringAt, type Config, type ConfigPath } from './config-paths';
import {
  CheckSetting,
  ColorSetting,
  NumberSetting,
  SelectSetting,
  TextSetting,
  usePanel,
  useIssueText,
  type ChoiceOption,
} from './controls';

const fieldOptions = (fields: readonly FieldDto[]): ChoiceOption[] =>
  fields.map((field) => ({ value: field.id, label: field.name }));

/**
 * Config keys and values (CONTRACTS §28.2) used inside the markup: data, not
 * UI text, kept out of the JSX for the i18n lint rule.
 */
const K = {
  aggregation: 'aggregation',
  any: 'any',
  area: 'area',
  asc: 'asc',
  axis: 'axis',
  bar: 'bar',
  below: 'below',
  bucket_width: 'bucket_width',
  chart: 'chart',
  color: 'color',
  compact: 'compact',
  compare: 'compare',
  control: 'control',
  count: 'count',
  currency: 'currency',
  date_bucket: 'date_bucket',
  date_field: 'date_field',
  decimals: 'decimals',
  default: 'default',
  desc: 'desc',
  dimension: 'dimension',
  direction: 'direction',
  display: 'display',
  donut: 'donut',
  empty_text: 'empty_text',
  field: 'field',
  fields: 'fields',
  from: 'from',
  group_others: 'group_others',
  grouped: 'grouped',
  horizontal: 'horizontal',
  label: 'label',
  left: 'left',
  limit: 'limit',
  line: 'line',
  metric_desc: 'metric_desc',
  metrics: 'metrics',
  mode: 'mode',
  month: 'month',
  number: 'number',
  orientation: 'orientation',
  parent_control_id: 'parent_control_id',
  percent: 'percent',
  pivot: 'pivot',
  prefix: 'prefix',
  previous_period: 'previous_period',
  range: 'range',
  records: 'records',
  relative: 'relative',
  right: 'right',
  series_dimension: 'series_dimension',
  show_legend: 'show_legend',
  show_values: 'show_values',
  smooth: 'smooth',
  sort: 'sort',
  stack: 'stack',
  stacked: 'stacked',
  suffix: 'suffix',
  table: 'table',
  target: 'target',
  thresholds: 'thresholds',
  to: 'to',
  vertical: 'vertical',
} as const;

const THRESHOLD_COLOR = '#b42318';
const STACK_TEST_ID = 'display-stack';

interface MetricValue {
  readonly id: string;
  readonly aggregation: MetricAggregation;
  readonly field: string | null;
  readonly label: string | null;
  readonly color: string | null;
  readonly chart?: 'bar' | 'line';
  readonly axis?: 'left' | 'right';
}

// --- Dimension -----------------------------------------------------------------------------

/** Group by: a field records can be grouped by, its date bucket or number range width. */
export function DimensionSetting({
  path,
  label,
  fields,
  testId,
}: {
  readonly path: ConfigPath;
  readonly label: string;
  readonly fields: readonly FieldDto[];
  readonly testId?: string;
}) {
  const { t } = useTranslation('dashboard');
  const { config, update } = usePanel();
  const fieldId = stringAt(config, [...path, 'field']);
  const field = fields.find((candidate) => candidate.id === fieldId);
  const kind = field === undefined ? null : widgetFieldKind(field);
  return (
    <>
      <SelectSetting
        path={[...path, K.field]}
        label={label}
        options={fieldOptions(groupableFields(fields))}
        testId={testId}
        onChange={(value) => {
          const next = fields.find((candidate) => candidate.id === value);
          if (next !== undefined) update(path, dimensionOf(next));
        }}
      />
      {kind === 'date' ? (
        <SelectSetting
          path={[...path, K.date_bucket]}
          label={t('edit.panel.dateBucket')}
          options={DATE_BUCKETS.map((bucket) => ({
            value: bucket,
            label: t(`edit.panel.buckets.${bucket}`),
          }))}
        />
      ) : null}
      {kind === 'number' ? (
        <NumberSetting
          path={[...path, K.bucket_width]}
          label={t('edit.panel.bucketWidth')}
          hint={t('edit.panel.bucketWidthHint')}
          min={0}
          step="any"
        />
      ) : null}
    </>
  );
}

/** Series (bar, line): a second grouping, which takes exactly one metric. */
export function SeriesSetting({ fields }: { readonly fields: readonly FieldDto[] }) {
  const { t } = useTranslation('dashboard');
  const { config, update } = usePanel();
  const dimension = stringAt(config, ['dimension', 'field']);
  const fieldId = stringAt(config, ['series_dimension', 'field']);
  const field = fields.find((candidate) => candidate.id === fieldId);
  const kind = field === undefined ? null : widgetFieldKind(field);
  return (
    <>
      <SelectSetting
        path={[K.series_dimension, K.field]}
        label={t('edit.panel.series')}
        nullLabel={t('edit.panel.seriesNone')}
        hint={t('edit.panel.seriesHint')}
        options={fieldOptions(groupableFields(fields).filter((item) => item.id !== dimension))}
        onChange={(value) => {
          const next = fields.find((candidate) => candidate.id === value);
          if (next === undefined) {
            update([K.series_dimension], null);
            return;
          }
          update([K.series_dimension], dimensionOf(next));
          // A series takes one metric.
          const metrics = arrayAt<MetricValue>(config, [K.metrics]);
          if (metrics.length > 1) update([K.metrics], metrics.slice(0, 1));
        }}
      />
      {kind === 'date' ? (
        <SelectSetting
          path={[K.series_dimension, K.date_bucket]}
          label={t('edit.panel.dateBucket')}
          options={DATE_BUCKETS.map((bucket) => ({
            value: bucket,
            label: t(`edit.panel.buckets.${bucket}`),
          }))}
        />
      ) : null}
    </>
  );
}

// --- Metrics -------------------------------------------------------------------------------

function aggregationsFor(fields: readonly FieldDto[]): MetricAggregation[] {
  return METRIC_AGGREGATIONS.filter(
    (aggregation) => aggregation === 'count' || metricFields(fields, aggregation).length > 0,
  );
}

function MetricRow({
  path,
  index,
  metric,
  fields,
  combo,
  removable,
  onRemove,
}: {
  readonly path: ConfigPath;
  readonly index: number;
  readonly metric: MetricValue;
  readonly fields: readonly FieldDto[];
  readonly combo: boolean;
  readonly removable: boolean;
  readonly onRemove: () => void;
}) {
  const { t } = useTranslation('dashboard');
  const { update } = usePanel();
  const here = [...path, index];
  const position = index + 1;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3" data-testid="metric-row">
      <div className="flex items-center justify-between gap-2">
        <span className="text-label font-semibold text-fg">
          {t('edit.panel.metricN', { position })}
        </span>
        {removable ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('edit.panel.removeMetric', { position })}
            onClick={onRemove}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <SelectSetting
        path={[...here, K.aggregation]}
        label={t('edit.panel.aggregation')}
        options={aggregationsFor(fields).map((aggregation) => ({
          value: aggregation,
          label: t(`edit.panel.aggregations.${aggregation}`),
        }))}
        testId={`metric-${String(index)}-aggregation`}
        onChange={(value) => {
          const aggregation = (value ?? 'count') as MetricAggregation;
          const allowed = metricFields(fields, aggregation);
          const field =
            aggregation === 'count'
              ? null
              : allowed.some((item) => item.id === metric.field)
                ? metric.field
                : (allowed[0]?.id ?? null);
          update(here, { ...metric, aggregation, field });
        }}
      />
      {metric.aggregation === 'count' ? null : (
        <SelectSetting
          path={[...here, K.field]}
          label={t('edit.panel.metricField')}
          options={fieldOptions(metricFields(fields, metric.aggregation))}
          testId={`metric-${String(index)}-field`}
        />
      )}
      <TextSetting path={[...here, K.label]} label={t('edit.panel.metricLabel')} maxLength={100} />
      {combo ? (
        <div className="grid grid-cols-2 gap-2">
          <SelectSetting
            path={[...here, K.chart]}
            label={t('edit.panel.drawAs')}
            options={[
              { value: K.bar, label: t('edit.panel.drawBar') },
              { value: K.line, label: t('edit.panel.drawLine') },
            ]}
          />
          <SelectSetting
            path={[...here, K.axis]}
            label={t('edit.panel.axis')}
            options={[
              { value: K.left, label: t('edit.panel.axisLeft') },
              { value: K.right, label: t('edit.panel.axisRight') },
            ]}
          />
        </div>
      ) : null}
      <ColorSetting path={[...here, K.color]} label={t('edit.panel.color')} />
    </li>
  );
}

/** Metrics: what is computed per group (1–5; KPI and pie one; combo 2–5). */
export function MetricsSetting({
  path,
  fields,
  min,
  max,
  combo = false,
}: {
  readonly path: ConfigPath;
  readonly fields: readonly FieldDto[];
  readonly min: number;
  readonly max: number;
  readonly combo?: boolean;
}) {
  const { t } = useTranslation('dashboard');
  const { config, update } = usePanel();
  const metrics = arrayAt<MetricValue>(config, path);
  const error = useIssueText(path);
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {metrics.map((metric, index) => (
          <MetricRow
            key={metric.id}
            path={path}
            index={index}
            metric={metric}
            fields={fields}
            combo={combo}
            removable={metrics.length > min}
            onRemove={() => {
              update(
                path,
                metrics.filter((_, position) => position !== index),
              );
            }}
          />
        ))}
      </ol>
      {error === undefined ? null : <p className="text-label font-normal text-danger">{error}</p>}
      {metrics.length < max ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="text-accent"
            data-testid="metric-add"
            onClick={() => {
              update(path, [
                ...metrics,
                {
                  id: nextMetricId(metrics),
                  aggregation: K.count,
                  field: null,
                  label: null,
                  color: null,
                  ...(combo ? { chart: K.line, axis: K.left } : {}),
                },
              ]);
            }}
          >
            <Plus aria-hidden="true" />
            {t('edit.panel.addMetric')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// --- Sort, limit, "Other" -------------------------------------------------------------------

export function SortSetting({
  path = [],
  maxLimit = MAX_WIDGET_LIMIT,
  others,
}: {
  readonly path?: ConfigPath;
  readonly maxLimit?: number;
  /** Offers "Group the rest into Other" (default shown as `others`). */
  readonly others?: boolean;
}) {
  const { t } = useTranslation('dashboard');
  return (
    <>
      <SelectSetting
        path={[...path, K.sort]}
        label={t('edit.panel.sort')}
        options={WIDGET_SORTS.map((sort) => ({
          value: sort,
          label: t(`edit.panel.sorts.${sort}`),
        }))}
      />
      <NumberSetting
        path={[...path, K.limit]}
        label={t('edit.panel.limit')}
        min={1}
        max={maxLimit}
        step={1}
        hint={t('edit.panel.limitHint', { max: maxLimit })}
      />
      {others === undefined ? null : (
        <CheckSetting
          path={[...path, K.group_others]}
          label={t('edit.panel.others')}
          fallback={others}
        />
      )}
    </>
  );
}

// --- Display -------------------------------------------------------------------------------

/** Number format of the widget's values (`null`: each field's own format). */
export function NumberFormatSetting() {
  const { t } = useTranslation('dashboard');
  const { config, update } = usePanel();
  const format = getIn(config, ['display', 'number_format']) as
    | { style: string; currency: string | null; decimals: number | null; compact: boolean }
    | null
    | undefined;
  const path = ['display', 'number_format'];
  return (
    <>
      <FormField label={t('edit.panel.numberFormat')}>
        {(control) => (
          <Select
            {...control}
            value={format?.style ?? ''}
            onChange={(event) => {
              const style = event.currentTarget.value;
              update(
                path,
                style === ''
                  ? null
                  : {
                      style,
                      currency: style === 'currency' ? (format?.currency ?? 'USD') : null,
                      decimals: format?.decimals ?? null,
                      compact: format?.compact ?? false,
                    },
              );
            }}
          >
            <option value="">{t('edit.panel.formats.field')}</option>
            {([K.number, K.currency, K.percent] as const).map((style) => (
              <option key={style} value={style}>
                {t(`edit.panel.formats.${style}`)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      {format?.style === 'currency' ? (
        <TextSetting
          path={[...path, K.currency]}
          label={t('edit.panel.currency')}
          placeholder="USD"
          maxLength={3}
          nullable={false}
        />
      ) : null}
      {format === null || format === undefined ? null : (
        <>
          <SelectSetting
            path={[...path, K.decimals]}
            label={t('edit.panel.decimals')}
            nullLabel={t('edit.panel.decimalsAuto')}
            options={[0, 1, 2, 3, 4, 5, 6].map((count) => ({
              value: String(count),
              label: String(count),
            }))}
            onChange={(value) => {
              update([...path, K.decimals], value === null ? null : Number(value));
            }}
          />
          <CheckSetting path={[...path, K.compact]} label={t('edit.panel.compact')} />
        </>
      )}
    </>
  );
}

/** How a chart is drawn (by type), legend, value labels, format, empty text. */
export function ChartDisplaySetting({ type }: { readonly type: WidgetType }) {
  const { t } = useTranslation('dashboard');
  return (
    <>
      {type === 'bar' ? (
        <>
          <SelectSetting
            path={[K.display, K.orientation]}
            label={t('edit.panel.orientation')}
            options={[
              { value: K.vertical, label: t('edit.panel.vertical') },
              { value: K.horizontal, label: t('edit.panel.horizontal') },
            ]}
          />
          <SelectSetting
            path={[K.display, K.stack]}
            label={t('edit.panel.stack')}
            testId={STACK_TEST_ID}
            options={[
              { value: K.grouped, label: t('edit.panel.stacks.grouped') },
              { value: K.stacked, label: t('edit.panel.stacks.stacked') },
              { value: K.percent, label: t('edit.panel.stacks.percent') },
            ]}
          />
        </>
      ) : null}
      {type === 'line' ? (
        <>
          <CheckSetting path={[K.display, K.area]} label={t('edit.panel.area')} />
          <CheckSetting path={[K.display, K.smooth]} label={t('edit.panel.smooth')} />
        </>
      ) : null}
      {type === 'pie' ? (
        <CheckSetting path={[K.display, K.donut]} label={t('edit.panel.donut')} />
      ) : null}
      <CheckSetting path={[K.display, K.show_legend]} label={t('edit.panel.legend')} fallback />
      <CheckSetting path={[K.display, K.show_values]} label={t('edit.panel.values')} />
      <NumberFormatSetting />
      <TextSetting
        path={[K.display, K.empty_text]}
        label={t('edit.panel.emptyText')}
        placeholder={t('state.empty.title')}
        maxLength={200}
      />
    </>
  );
}

// --- KPI -----------------------------------------------------------------------------------

export function KpiSetting({ fields }: { readonly fields: readonly FieldDto[] }) {
  const { t } = useTranslation('dashboard');
  const { config, update } = usePanel();
  const compare = getIn(config, ['compare']) as { date_field: string; range: string } | null;
  const dates = dateFields(fields);
  const thresholds = arrayAt<{ below: number | null; color: string }>(config, [
    'display',
    'thresholds',
  ]);
  return (
    <>
      <FormField label={t('edit.panel.compare')} error={useIssueText([K.compare], true)}>
        {(control) => (
          <Select
            {...control}
            value={compare === null ? '' : 'previous_period'}
            disabled={dates.length === 0 && compare === null}
            onChange={(event) => {
              const first = dates[0];
              update(
                [K.compare],
                event.currentTarget.value === '' || first === undefined
                  ? null
                  : { mode: K.previous_period, date_field: first.id, range: K.month },
              );
            }}
          >
            <option value="">{t('edit.panel.compareNone')}</option>
            <option value="previous_period">{t('edit.panel.comparePrevious')}</option>
          </Select>
        )}
      </FormField>
      {compare === null ? null : (
        <>
          <SelectSetting
            path={[K.compare, K.date_field]}
            label={t('edit.panel.compareField')}
            options={fieldOptions(dates)}
          />
          <SelectSetting
            path={[K.compare, K.range]}
            label={t('edit.panel.compareRange')}
            options={PREVIOUS_PERIOD_RANGES.map((range) => ({
              value: range,
              label: t(`edit.panel.ranges.${range}`),
            }))}
          />
        </>
      )}
      <NumberSetting path={[K.display, K.target]} label={t('edit.panel.target')} step={K.any} />
      <div className="grid grid-cols-2 gap-2">
        <TextSetting path={[K.display, K.prefix]} label={t('edit.panel.prefix')} maxLength={20} />
        <TextSetting path={[K.display, K.suffix]} label={t('edit.panel.suffix')} maxLength={20} />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-label text-fg">{t('edit.panel.thresholds')}</legend>
        <p className="text-label font-normal text-fg-muted">{t('edit.panel.thresholdsHint')}</p>
        <ol className="flex flex-col gap-2">
          {thresholds.map((threshold, index) => (
            <li key={index} className="flex items-end gap-2">
              <div className="flex-1">
                <NumberSetting
                  path={[K.display, K.thresholds, index, K.below]}
                  label={t('edit.panel.thresholdBelow', { position: index + 1 })}
                  step="any"
                />
              </div>
              <ColorSetting
                path={[K.display, K.thresholds, index, K.color]}
                label={t('edit.panel.color')}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('edit.panel.removeThreshold', { position: index + 1 })}
                onClick={() => {
                  update(
                    [K.display, K.thresholds],
                    thresholds.filter((_, position) => position !== index),
                  );
                }}
              >
                <X aria-hidden="true" />
              </Button>
              <span className="sr-only">{threshold.color}</span>
            </li>
          ))}
        </ol>
        {thresholds.length < 5 ? (
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="text-accent"
              onClick={() => {
                update(
                  [K.display, K.thresholds],
                  [...thresholds, { below: null, color: THRESHOLD_COLOR }],
                );
              }}
            >
              <Plus aria-hidden="true" />
              {t('edit.panel.addThreshold')}
            </Button>
          </div>
        ) : null}
      </fieldset>
      <NumberFormatSetting />
    </>
  );
}

// --- Table ---------------------------------------------------------------------------------

export function TableSetting({ fields }: { readonly fields: readonly FieldDto[] }) {
  const { t } = useTranslation('dashboard');
  const { config, update } = usePanel();
  const mode = stringAt(config, ['table', 'mode']) ?? 'records';
  const shown = arrayAt<string>(config, ['table', 'fields']);
  const legendId = useId();
  const fieldsError = useIssueText(['table', 'fields'], true);
  return (
    <>
      <SelectSetting
        path={[K.table, K.mode]}
        label={t('edit.panel.tableMode')}
        options={[
          { value: K.records, label: t('edit.panel.tableModes.records') },
          { value: K.pivot, label: t('edit.panel.tableModes.pivot') },
        ]}
        onChange={(value) => {
          if (value === 'pivot') {
            const first = groupableFields(fields)[0];
            update([K.table], {
              mode: K.pivot,
              dimension: first === undefined ? null : dimensionOf(first),
              metrics: [
                {
                  id: nextMetricId([]),
                  aggregation: K.count,
                  field: null,
                  label: null,
                  color: null,
                },
              ],
              sort: K.metric_desc,
              limit: 10,
            });
          } else {
            update([K.table], {
              mode: K.records,
              fields: fields.slice(0, 5).map((field) => field.id),
              sort: null,
              limit: 10,
            });
          }
        }}
      />
      {mode === 'pivot' ? (
        <>
          <DimensionSetting
            path={[K.table, K.dimension]}
            label={t('edit.panel.dimension')}
            fields={fields}
          />
          <MetricsSetting path={[K.table, K.metrics]} fields={fields} min={1} max={5} />
          <SortSetting path={[K.table]} maxLimit={MAX_TABLE_WIDGET_ROWS} />
        </>
      ) : (
        <>
          <fieldset aria-labelledby={legendId} className="flex flex-col gap-1">
            <p id={legendId} className="mb-1 text-label text-fg">
              {t('edit.panel.tableFields', { max: MAX_TABLE_WIDGET_FIELDS })}
            </p>
            {fields.map((field) => {
              const checked = shown.includes(field.id);
              return (
                <Checkbox
                  key={field.id}
                  label={field.name}
                  checked={checked}
                  disabled={!checked && shown.length >= MAX_TABLE_WIDGET_FIELDS}
                  onChange={(event) => {
                    const next = event.currentTarget.checked
                      ? fields
                          .map((item) => item.id)
                          .filter((id) => id === field.id || shown.includes(id))
                      : shown.filter((id) => id !== field.id);
                    update([K.table, K.fields], next);
                  }}
                />
              );
            })}
            {fieldsError === undefined ? null : (
              <p className="text-label font-normal text-danger">{fieldsError}</p>
            )}
          </fieldset>
          <SelectSetting
            path={[K.table, K.sort, K.field]}
            label={t('edit.panel.recordSort')}
            nullLabel={t('edit.panel.recordSortNone')}
            options={fieldOptions(fields)}
            onChange={(value) => {
              update([K.table, K.sort], value === null ? null : { field: value, direction: K.asc });
            }}
          />
          {getIn(config, ['table', 'sort']) === null ? null : (
            <SelectSetting
              path={[K.table, K.sort, K.direction]}
              label={t('edit.panel.direction')}
              options={[
                { value: K.asc, label: t('edit.panel.asc') },
                { value: K.desc, label: t('edit.panel.desc') },
              ]}
            />
          )}
          <NumberSetting
            path={[K.table, K.limit]}
            label={t('edit.panel.rows')}
            min={1}
            max={MAX_TABLE_WIDGET_ROWS}
            step={1}
          />
        </>
      )}
      <NumberFormatSetting />
    </>
  );
}

// --- Text ----------------------------------------------------------------------------------

export function MarkdownSetting() {
  const { t } = useTranslation('dashboard');
  const { config, update } = usePanel();
  const [preview, setPreview] = useState(false);
  const markdown = stringAt(config, ['markdown']) ?? '';
  const error = useIssueText(['markdown']);
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-label text-fg">
          {t('edit.panel.markdown')}
        </label>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={preview}
          onClick={() => {
            setPreview((value) => !value);
          }}
        >
          {t('edit.panel.preview')}
        </Button>
      </div>
      {preview ? (
        <div
          className="min-h-40 rounded-md border border-line p-3"
          data-testid="markdown-preview"
          aria-label={t('edit.panel.previewLabel')}
          role="region"
        >
          <TextWidget markdown={markdown} />
        </div>
      ) : (
        <textarea
          id={id}
          value={markdown}
          rows={10}
          maxLength={10_000}
          aria-invalid={error !== undefined}
          data-testid="markdown-input"
          className="min-h-40 w-full rounded-md border border-line-control bg-surface px-3 py-2 font-code text-mono text-fg focus-visible:outline-2 focus-visible:outline-accent"
          onChange={(event) => {
            update(['markdown'], event.currentTarget.value);
          }}
        />
      )}
      <p className="text-label font-normal text-fg-muted">{t('edit.panel.markdownHint')}</p>
      {error === undefined ? null : <p className="text-label font-normal text-danger">{error}</p>}
    </div>
  );
}

// --- Filter control ------------------------------------------------------------------------

/** The default value of a filter control, by kind (CONTRACTS §28.4). */
function ControlDefault({
  kind,
  field,
}: {
  readonly kind: FilterControlKind;
  readonly field: FieldDto | undefined;
}) {
  const { t } = useTranslation('dashboard');
  const { config, update } = usePanel();
  const value = getIn(config, ['default']) as {
    values?: unknown[];
    range?: { from: unknown; to: unknown };
    relative?: string;
  } | null;
  const error = useIssueText(['default'], true);
  const [text, setText] = useState(() =>
    Array.isArray(value?.values) ? value.values.map(String).join(', ') : '',
  );
  if (kind === 'date_range') {
    return (
      <SelectSetting
        path={[K.default, K.relative]}
        label={t('edit.panel.defaultValue')}
        nullLabel={t('edit.panel.defaultNone')}
        options={RELATIVE_DATE_RANGES.map((range) => ({
          value: range,
          label: t(`edit.panel.relative.${range}`),
        }))}
        onChange={(next) => {
          update([K.default], next === null ? null : { relative: next });
        }}
      />
    );
  }
  if (kind === 'number_range') {
    const range = value?.range ?? { from: null, to: null };
    const set = (side: 'from' | 'to', text: string) => {
      const number = text === '' ? null : Number(text);
      const next = { ...range, [side]: number !== null && Number.isFinite(number) ? number : null };
      update(['default'], next.from === null && next.to === null ? null : { range: next });
    };
    return (
      <div className="grid grid-cols-2 gap-2">
        {([K.from, K.to] as const).map((side) => (
          <FormField
            key={side}
            label={t(`edit.panel.range.${side}`)}
            error={side === 'from' ? error : undefined}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                step={K.any}
                value={typeof range[side] === 'number' ? String(range[side]) : ''}
                onChange={(event) => {
                  set(side, event.currentTarget.value);
                }}
              />
            )}
          </FormField>
        ))}
      </div>
    );
  }
  if (kind === 'select') {
    const options = ((field?.options as { options?: { id: string; name: string }[] } | undefined)
      ?.options ?? []) as { id: string; name: string }[];
    const chosen = Array.isArray(value?.values) ? (value.values as string[]) : [];
    return (
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-label text-fg">{t('edit.panel.defaultValue')}</legend>
        {options.map((option) => (
          <Checkbox
            key={option.id}
            label={option.name}
            checked={chosen.includes(option.id)}
            onChange={(event) => {
              const next = event.currentTarget.checked
                ? [...chosen, option.id]
                : chosen.filter((id) => id !== option.id);
              update([K.default], next.length === 0 ? null : { values: next });
            }}
          />
        ))}
        {error === undefined ? null : <p className="text-label font-normal text-danger">{error}</p>}
      </fieldset>
    );
  }
  if (kind === 'text') {
    return (
      <FormField
        label={t('edit.panel.defaultValue')}
        hint={t('edit.panel.defaultTextHint')}
        error={error}
      >
        {(control) => (
          <Input
            {...control}
            value={text}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              setText(raw);
              const values = raw
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item !== '');
              update([K.default], values.length === 0 ? null : { values });
            }}
          />
        )}
      </FormField>
    );
  }
  return <p className="text-label font-normal text-fg-muted">{t('edit.panel.defaultUser')}</p>;
}

export interface ControlSiblings {
  /** Other filter controls of the dashboard (saved), by id. */
  readonly controls: readonly {
    readonly id: string;
    readonly name: string;
    readonly tableId: string;
    readonly parent: string | null;
  }[];
  /** Data widgets of the dashboard (saved) that read the same table. */
  readonly targets: readonly {
    readonly key: string;
    readonly name: string;
    readonly bound: boolean;
  }[];
  readonly onBind: (key: string, bound: boolean) => void;
  /** This control has been saved (bindings need its id). */
  readonly saved: boolean;
  readonly selfId: string | null;
}

export function ControlSetting({
  fields,
  siblings,
}: {
  readonly fields: readonly FieldDto[];
  readonly siblings: ControlSiblings;
}) {
  const { t } = useTranslation('dashboard');
  const { config, update } = usePanel();
  const kind = (stringAt(config, ['control']) ?? 'select') as FilterControlKind;
  const tableId = stringAt(config, ['table_id']);
  const fieldId = stringAt(config, ['field']);
  const field = fields.find((candidate) => candidate.id === fieldId);
  // A parent is another control of the same table that does not descend from this one.
  const descendsFromSelf = (id: string): boolean => {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current !== null && !seen.has(current)) {
      if (current === siblings.selfId) return true;
      seen.add(current);
      current = siblings.controls.find((control) => control.id === current)?.parent ?? null;
    }
    return false;
  };
  const parents = siblings.controls.filter(
    (control) =>
      control.tableId === tableId &&
      control.id !== siblings.selfId &&
      !descendsFromSelf(control.id),
  );
  const bindId = useId();
  return (
    <>
      <SelectSetting
        path={[K.control]}
        label={t('edit.panel.controlKind')}
        options={availableControls(fields).map((value) => ({
          value,
          label: t(`edit.panel.controls.${value}`),
        }))}
        onChange={(value) => {
          const next = (value ?? 'select') as FilterControlKind;
          const first = controlFields(fields, next)[0];
          update([], { ...config, control: next, field: first?.id ?? null, default: null });
        }}
      />
      <SelectSetting
        path={[K.field]}
        label={t('edit.panel.controlField')}
        options={fieldOptions(controlFields(fields, kind))}
        onChange={(value) => {
          update([], { ...config, field: value, default: null });
        }}
      />
      <SelectSetting
        path={[K.parent_control_id]}
        label={t('edit.panel.parentControl')}
        nullLabel={t('edit.panel.parentNone')}
        hint={t('edit.panel.parentHint')}
        options={parents.map((control) => ({ value: control.id, label: control.name }))}
      />
      <ControlDefault key={`${kind}:${fieldId ?? ''}`} kind={kind} field={field} />
      <fieldset aria-labelledby={bindId} className="flex flex-col gap-1">
        <p id={bindId} className="mb-1 text-label text-fg">
          {t('edit.panel.bound')}
        </p>
        {!siblings.saved ? (
          <p className="text-label font-normal text-fg-muted">{t('edit.panel.boundWait')}</p>
        ) : siblings.targets.length === 0 ? (
          <p className="text-label font-normal text-fg-muted">{t('edit.panel.boundNone')}</p>
        ) : (
          siblings.targets.map((target) => (
            <Checkbox
              key={target.key}
              label={target.name}
              checked={target.bound}
              onChange={(event) => {
                siblings.onBind(target.key, event.currentTarget.checked);
              }}
            />
          ))
        )}
      </fieldset>
    </>
  );
}

/** Reads `config` (typed loosely) for a data widget's table id. */
export function tableIdOf(config: Config): string | null {
  return stringAt(config, ['table_id']);
}
