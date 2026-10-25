import { Button, cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { translateError } from '../../../lib/errors/translate';
import { useFormatters } from '../../../lib/i18n/format';
import { tableRecordCountQuery } from '../../../lib/query/queries';
import { optionChipClass } from '../components/options/SelectOptionsEditor';
import { OPTION_PALETTE_SIZE } from '../draft';

import { sampleNames, sampleText, type RequiredConsents } from './model';
import { DependentsList, Notice, PreviewSkeleton, Stat } from './parts';
import { useRecordTitles } from './use-record-titles';

import type { ConvertFieldPreview, FieldConversionSample } from '@cellhive/contracts';

/** What the right pane of the field dialog previews (T414, T415). */
export type PaneMode = 'type' | 'style' | 'to_two_way' | 'to_single';

export interface ConsentState {
  readonly confirm: boolean;
  readonly acceptDataLoss: boolean;
}

export interface ConversionPaneProps {
  readonly mode: PaneMode;
  readonly tableId: string;
  readonly baseId: string | undefined;
  /** Name of the target type (translated), e.g. "Select". */
  readonly targetLabel: string;
  readonly targetType: string;
  /** Select target: its options as they will be (colors of the "after" chips). */
  readonly targetOptions?: readonly { readonly name: string; readonly color: number }[];
  /** Text style checked (`style` mode): `email` or `phone`. */
  readonly style?: 'email' | 'phone';
  readonly preview: ConvertFieldPreview | undefined;
  readonly loading: boolean;
  readonly stale: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly required: RequiredConsents | null;
  readonly consents: ConsentState;
  readonly onConsents: (next: ConsentState) => void;
  /** Link fields (T415): the linked table. */
  readonly linkedTable?: { readonly id: string; readonly name: string } | undefined;
  readonly tableName?: string | undefined;
  /** (T469) The field is a formula/lookup becoming a stored type ("convert to static values"). */
  readonly fromComputed?: boolean | undefined;
}

/** How many new options are drawn as chips before "and N more". */
const NEW_OPTION_CHIPS = 6;

function SamplesTable({
  samples,
  titles,
  renderTo,
  caption,
}: {
  samples: readonly FieldConversionSample[];
  titles: ReadonlyMap<string, string>;
  renderTo: (sample: FieldConversionSample) => ReactNode;
  caption: string;
}) {
  const { t } = useTranslation('field');
  if (samples.length === 0) return null;
  return (
    // Keyboard users scroll the samples too (axe scrollable-region-focusable).
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className="max-h-72 overflow-auto rounded-lg border border-line bg-surface focus-visible:outline-2 focus-visible:outline-accent"
    >
      <table
        className="w-full table-fixed border-collapse text-body"
        data-testid="conversion-samples"
      >
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface-sunken text-label font-medium text-fg">
          <tr className="h-[30px]">
            <th scope="col" className="w-[38%] px-2.5 text-left font-medium">
              {t('convert.samples.record')}
            </th>
            <th scope="col" className="px-2.5 text-left font-medium">
              {t('convert.samples.before')}
            </th>
            <th scope="col" className="px-2.5 text-left font-medium">
              {t('convert.samples.after')}
            </th>
          </tr>
        </thead>
        <tbody>
          {samples.map((sample) => (
            <tr
              key={sample.record_id}
              className="h-[34px] border-t border-line"
              data-outcome={sample.outcome}
            >
              <td className="truncate px-2.5">
                {titles.get(sample.record_id) || (
                  <span className="text-fg-muted">{t('convert.samples.untitled')}</span>
                )}
              </td>
              <td className="truncate px-2.5 font-mono text-mono">{sampleText(sample.from)}</td>
              <td className="px-2.5">{renderTo(sample)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyChip({ label }: { label: string }) {
  return (
    <span className="inline-flex h-[22px] items-center rounded-sm bg-danger/5 px-2 text-label font-semibold text-danger">
      {label}
    </span>
  );
}

/**
 * Right pane of the field dialog for a conversion (board "Đổi kiểu field";
 * T415 boards for links): counters, new options, 20 samples before →
 * after, dependents, and the notices whose boxes must be ticked before the
 * change runs (`confirm`, `accept_data_loss`). The last preview stays
 * (dimmed) while a newer choice loads.
 */
export function ConversionPane(props: ConversionPaneProps) {
  const { t } = useTranslation(['field', 'errors']);
  const { i18n } = useTranslation('errors');
  const format = useFormatters();
  const { mode, preview, required, consents, onConsents } = props;
  const n = (value: number) => format.number(value);
  const sampleIds = useMemo(
    () => (preview?.samples ?? []).map((sample) => sample.record_id),
    [preview?.samples],
  );
  const titles = useRecordTitles(props.tableId, sampleIds);
  const overIds = useMemo(
    () => (preview?.over_limit_samples ?? []).map((sample) => sample.record_id),
    [preview?.over_limit_samples],
  );
  const overTitles = useRecordTitles(
    mode === 'to_two_way' ? props.linkedTable?.id : undefined,
    overIds,
  );
  const linkedCount = useQuery({
    ...tableRecordCountQuery(props.linkedTable?.id ?? ''),
    enabled: mode === 'to_two_way' && props.linkedTable !== undefined,
  });

  const heading = t(`convert.pane.${mode}`);
  const headingId = `conversion-pane-${mode}`;

  let body: ReactNode;
  if (preview === undefined && props.error !== null && props.error !== undefined) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <Notice tone="danger">
          <p>
            <strong>{t('convert.previewFailed')}</strong>{' '}
            {translateError(props.error, i18n).message}
          </p>
        </Notice>
        <Button variant="secondary" size="sm" onClick={props.onRetry}>
          <RefreshCw aria-hidden="true" />
          {t('field:retry')}
        </Button>
      </div>
    );
  } else if (preview === undefined) {
    body = <PreviewSkeleton label={t('convert.loading')} />;
  } else {
    body = (
      <PreviewBody
        {...props}
        preview={preview}
        titles={titles}
        overTitles={overTitles}
        linkedCount={linkedCount.data?.count}
        n={n}
        required={required}
        consents={consents}
        onConsents={onConsents}
      />
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={props.loading || props.stale}
      data-testid="conversion-pane"
      className="flex min-w-0 flex-col gap-3.5"
    >
      <h3 id={headingId} className="text-body font-semibold text-fg">
        {heading}
      </h3>
      <div
        className={cn(
          'flex flex-col gap-3.5 transition-opacity motion-reduce:transition-none',
          props.stale && preview !== undefined && 'opacity-60',
        )}
      >
        {body}
      </div>
    </section>
  );
}

interface BodyProps extends ConversionPaneProps {
  readonly preview: ConvertFieldPreview;
  readonly titles: ReadonlyMap<string, string>;
  readonly overTitles: ReadonlyMap<string, string>;
  readonly linkedCount: number | undefined;
  readonly n: (value: number) => string;
}

function PreviewBody(props: BodyProps) {
  const { t } = useTranslation('field');
  const format = useFormatters();
  const { mode, preview, n, required, consents, onConsents } = props;
  const refused = !preview.allowed || preview.kind === 'forbidden';
  // (T469) To a formula/lookup: every value is replaced by the computed one (kept 7 days).
  const toComputed = props.targetType === 'formula' || props.targetType === 'lookup';

  const optionColor = (name: string): number => {
    const known = props.targetOptions?.find((option) => option.name === name);
    if (known !== undefined) return known.color;
    const created = preview.new_options.indexOf(name);
    return ((props.targetOptions?.length ?? 0) + Math.max(created, 0)) % OPTION_PALETTE_SIZE;
  };
  const renderTo = (sample: FieldConversionSample) => {
    if (toComputed) {
      const text = sampleText(sample.to);
      return text === '' ? (
        <span className="text-fg-muted">{t('convert.computed.emptyValue')}</span>
      ) : (
        <span className="truncate">{text}</span>
      );
    }
    if (sample.outcome === 'lost') return <EmptyChip label={t('convert.samples.empty')} />;
    if (sample.outcome === 'invalid') {
      return (
        <span className="inline-flex min-w-0 items-center gap-1 text-warning">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">
            {t(`convert.style.invalidShort.${props.style ?? 'email'}`)}
          </span>
        </span>
      );
    }
    if (props.targetType === 'select') {
      return (
        <span className="flex min-w-0 flex-wrap gap-1">
          {sampleNames(sample.to).map((name) => (
            <span
              key={name}
              className={cn(
                'inline-flex h-[22px] max-w-full items-center truncate rounded-sm px-2 text-label font-medium',
                optionChipClass(optionColor(name)),
              )}
            >
              {name}
            </span>
          ))}
        </span>
      );
    }
    if (props.targetType === 'datetime' && typeof sample.to === 'string') {
      return <span className="truncate">{format.dateTime(sample.to)}</span>;
    }
    if (props.targetType === 'number' && typeof sample.to === 'number') {
      return <span className="tabular-nums">{format.number(sample.to)}</span>;
    }
    if (props.targetType === 'checkbox') {
      return (
        <span>
          {t(sample.to === true ? 'convert.samples.checked' : 'convert.samples.unchecked')}
        </span>
      );
    }
    return <span className="truncate">{sampleText(sample.to)}</span>;
  };
  const samplesCaption = t('convert.samples.caption');

  const consentNotices: ReactNode[] = [];
  if (refused) {
    consentNotices.push(
      <Notice key="refused" tone="danger" data-testid="conversion-refused">
        <p>
          <strong>{t('convert.refused.title')}</strong>{' '}
          {preview.reason === 'TOO_MANY_OPTIONS'
            ? t('convert.refused.tooManyOptions')
            : t('convert.refused.notAllowed')}
        </p>
      </Notice>,
    );
  } else if (required?.acceptDataLoss === true) {
    consentNotices.push(
      <Notice
        key="loss"
        tone="danger"
        data-testid="conversion-data-loss"
        consent={{
          label: t('convert.consent.acceptDataLoss', {
            count: preview.affected,
            formatted: n(preview.affected),
          }),
          checked: consents.acceptDataLoss,
          onChange: (checked) => {
            onConsents({ ...consents, acceptDataLoss: checked });
          },
        }}
      >
        <p>
          <strong>{t('convert.dataLoss.title', { type: props.targetLabel })}</strong>{' '}
          {t('convert.dataLoss.body', { count: preview.affected, formatted: n(preview.affected) })}
        </p>
      </Notice>,
    );
  } else if (required?.confirm === true) {
    const lost = preview.lost;
    const truncated = preview.truncated;
    const key =
      mode === 'to_single'
        ? 'single'
        : toComputed
          ? 'replaced'
          : lost > 0 && truncated > 0
            ? 'both'
            : lost > 0
              ? 'lost'
              : truncated > 0
                ? 'truncated'
                : 'dependents';
    const values = {
      lost: n(lost),
      truncated: n(truncated),
      count: key === 'truncated' || key === 'single' ? truncated : lost,
      type: props.targetLabel,
    };
    consentNotices.push(
      <Notice
        key="confirm"
        tone={key === 'dependents' || key === 'replaced' ? 'warning' : 'danger'}
        data-testid="conversion-confirm"
        consent={{
          label: t(`convert.consent.${key}`, values),
          checked: consents.confirm,
          onChange: (checked) => {
            onConsents({ ...consents, confirm: checked });
          },
        }}
      >
        <p>
          <strong>{t(`convert.confirm.${key}.title`, values)}</strong>{' '}
          {t(`convert.confirm.${key}.body`, values)}
        </p>
      </Notice>,
    );
  }

  if (mode === 'style') {
    const invalid = preview.invalid ?? 0;
    const style = props.style ?? 'email';
    return (
      <>
        <div className="grid grid-cols-2 gap-2">
          <Stat
            data-testid="stat-invalid"
            value={n(invalid)}
            label={t(`convert.style.invalid.${style}`, { count: invalid })}
            tone={invalid > 0 ? 'warning' : 'neutral'}
          />
          <Stat
            value={n(preview.affected)}
            label={t('convert.stats.filled', { count: preview.affected })}
          />
        </div>
        <SamplesTable
          samples={preview.samples.filter((sample) => sample.outcome === 'invalid')}
          titles={props.titles}
          renderTo={renderTo}
          caption={samplesCaption}
        />
        <Notice tone="info">
          <p>
            <strong>{t('convert.style.keepTitle')}</strong> {t('convert.style.keepBody')}
          </p>
        </Notice>
      </>
    );
  }

  if (mode === 'to_two_way') {
    const over = preview.over_limit ?? 0;
    const linked = props.linkedTable?.name ?? '';
    return (
      <>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Stat
            value={n(preview.affected)}
            label={t('convert.twoWay.linkedRecords', { count: preview.affected })}
          />
          <Stat
            value={props.linkedCount === undefined ? '–' : n(props.linkedCount)}
            label={t('convert.twoWay.newField', { table: linked, count: props.linkedCount ?? 0 })}
          />
          <Stat
            data-testid="stat-over-limit"
            value={n(over)}
            label={t('convert.twoWay.overLimit', { count: over })}
            tone={over > 0 ? 'warning' : 'neutral'}
          />
        </div>
        {over > 0 ? (
          <>
            <div
              role="region"
              aria-label={t('convert.twoWay.overLimitCaption', { table: linked })}
              tabIndex={0}
              className="max-h-56 overflow-auto rounded-lg border border-line bg-surface focus-visible:outline-2 focus-visible:outline-accent"
            >
              <table className="w-full border-collapse text-body" data-testid="over-limit-samples">
                <caption className="sr-only">
                  {t('convert.twoWay.overLimitCaption', { table: linked })}
                </caption>
                <thead className="bg-surface-sunken text-label font-medium">
                  <tr className="h-[30px]">
                    <th scope="col" className="px-2.5 text-left font-medium">
                      {t('convert.twoWay.recordOf', { table: linked })}
                    </th>
                    <th scope="col" className="px-2.5 text-right font-medium">
                      {t('convert.twoWay.links')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(preview.over_limit_samples ?? []).map((sample) => (
                    <tr key={sample.record_id} className="h-[34px] border-t border-line">
                      <td className="truncate px-2.5">
                        {props.overTitles.get(sample.record_id) || t('convert.samples.untitled')}
                      </td>
                      <td className="px-2.5 text-right text-warning tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          <TriangleAlert aria-hidden="true" className="size-3.5" />
                          {t('convert.twoWay.linkCount', {
                            count: sample.links,
                            formatted: n(sample.links),
                          })}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Notice tone="warning" data-testid="over-limit-notice">
              <p>
                <strong>
                  {t('convert.twoWay.overTitle', {
                    count: over,
                    formatted: n(over),
                    table: linked,
                  })}
                </strong>{' '}
                {t('convert.twoWay.overBody')}
              </p>
            </Notice>
          </>
        ) : null}
        <Notice tone="info">
          <p>
            <strong>{t('convert.twoWay.noCopyTitle')}</strong>{' '}
            {t('convert.twoWay.noCopyBody', { table: linked })}
          </p>
        </Notice>
        <Notice tone="info">
          <p>
            <strong>
              {t('convert.twoWay.rightsTitle', { source: props.tableName ?? '', target: linked })}
            </strong>{' '}
            {t('convert.twoWay.rightsBody')}
          </p>
        </Notice>
        {consentNotices}
      </>
    );
  }

  if (mode === 'to_single') {
    return (
      <>
        <div className="grid grid-cols-2 gap-2">
          <Stat
            value={n(preview.affected)}
            label={t('convert.single.linked', { count: preview.affected })}
          />
          <Stat
            data-testid="stat-truncated"
            value={n(preview.truncated)}
            label={t('convert.single.truncated', { count: preview.truncated })}
            tone={preview.truncated > 0 ? 'danger' : 'neutral'}
          />
        </div>
        <SamplesTable
          samples={preview.samples}
          titles={props.titles}
          renderTo={renderTo}
          caption={samplesCaption}
        />
        <DependentsList
          dependents={preview.dependents}
          tableId={props.tableId}
          baseId={props.baseId}
          title={t('convert.dependents.title')}
        />
        {consentNotices}
      </>
    );
  }

  // A type conversion (keep, truncate, blacklist).
  const newOptions = preview.new_options;
  const computedNotice = toComputed ? (
    <Notice tone="info" data-testid="conversion-to-computed">
      <p>
        <strong>{t('convert.computed.toTitle', { type: props.targetLabel })}</strong>{' '}
        {t('convert.computed.toBody')}
      </p>
    </Notice>
  ) : props.fromComputed === true ? (
    <Notice tone="info" data-testid="conversion-static">
      <p>
        <strong>{t('convert.computed.staticTitle')}</strong>{' '}
        {t('convert.computed.staticBody', { type: props.targetLabel })}
      </p>
    </Notice>
  ) : null;
  return (
    <>
      {computedNotice}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          data-testid="stat-affected"
          value={n(preview.affected)}
          label={t('convert.stats.affected', { count: preview.affected })}
        />
        <Stat
          data-testid="stat-lost"
          value={n(preview.lost)}
          label={
            toComputed
              ? t('convert.stats.replaced', { count: preview.lost })
              : t('convert.stats.lost', { count: preview.lost })
          }
          tone={preview.lost > 0 ? (toComputed ? 'warning' : 'danger') : 'neutral'}
        />
        <Stat
          data-testid="stat-truncated"
          value={n(preview.truncated)}
          label={t('convert.stats.truncated', { count: preview.truncated })}
          tone={preview.truncated > 0 ? 'warning' : 'neutral'}
        />
        {props.targetType === 'select' ? (
          <Stat
            data-testid="stat-new-options"
            value={n(newOptions.length)}
            label={t('convert.stats.newOptions', { count: newOptions.length })}
          />
        ) : (
          <Stat
            value={n(preview.dependents.length)}
            label={t('convert.stats.dependents', { count: preview.dependents.length })}
          />
        )}
      </div>
      {newOptions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="new-options">
          {newOptions.slice(0, NEW_OPTION_CHIPS).map((name) => (
            <span
              key={name}
              className={cn(
                'inline-flex h-[22px] max-w-40 items-center truncate rounded-sm px-2 text-label font-medium',
                optionChipClass(optionColor(name)),
              )}
            >
              {name}
            </span>
          ))}
          {newOptions.length > NEW_OPTION_CHIPS ? (
            <span className="text-label font-normal text-fg-muted">
              {t('convert.moreOptions', { count: newOptions.length - NEW_OPTION_CHIPS })}
            </span>
          ) : null}
        </div>
      ) : null}
      <SamplesTable
        samples={preview.samples}
        titles={props.titles}
        renderTo={renderTo}
        caption={samplesCaption}
      />
      {preview.kind === 'blacklist' && preview.affected === 0 && !refused ? (
        <Notice tone="info">
          <p>{t('convert.emptyColumn')}</p>
        </Notice>
      ) : null}
      <DependentsList
        dependents={preview.dependents}
        tableId={props.tableId}
        baseId={props.baseId}
        title={t('convert.dependents.title')}
      />
      {preview.unique_values_reset ? (
        <Notice tone="info" data-testid="unique-reset">
          <p>
            <strong>{t('convert.uniqueReset.title')}</strong> {t('convert.uniqueReset.body')}
          </p>
        </Notice>
      ) : null}
      {consentNotices}
    </>
  );
}
