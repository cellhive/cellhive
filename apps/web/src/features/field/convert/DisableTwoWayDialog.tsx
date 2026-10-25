import { Button, cn, Dialog, Spinner } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, History, Link2, RefreshCw, Table2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { translateError } from '../../../lib/errors/translate';
import { useFormatters } from '../../../lib/i18n/format';
import { fieldsQuery } from '../../../lib/query/queries';
import { useConvertField } from '../mutations';

import { DependentsList, Notice, PreviewSkeleton, Stat } from './parts';
import { useConversionPreview } from './use-conversion-preview';

import type { ConvertFieldPreviewRequest, FieldDto } from '@cellhive/contracts';

export interface DisableTwoWayDialogProps {
  /** The two-way link field being edited. */
  readonly field: FieldDto;
  readonly tableId: string;
  readonly tableName: string;
  readonly baseId: string | undefined;
  readonly linkedTable: { readonly id: string; readonly name: string };
  /** Back to the field dialog, two-way still on. */
  readonly onCancel: () => void;
  /** Done (the conversion started) or closed. */
  readonly onClose: () => void;
}

const ONE_WAY: ConvertFieldPreviewRequest = { type: 'link', options: { bidirectional: false } };

type Side = 'this' | 'partner';

/**
 * Turning a two-way link into a one-way link (T415, ADR-28 §2; board "Tắt
 * liên kết hai chiều"): the user picks the side that stays, the other side
 * goes to the trash (30 days, the conversion can be undone for 7). The
 * preview lists what uses the removed side; with dependents the red button
 * needs the box ticked. `PUT` on the field that stays (CONTRACTS §4.4).
 */
export function DisableTwoWayDialog({
  field,
  tableId,
  tableName,
  baseId,
  linkedTable,
  onCancel,
  onClose,
}: DisableTwoWayDialogProps) {
  const { t } = useTranslation(['field', 'common']);
  const { i18n } = useTranslation('errors');
  const format = useFormatters();
  const group = useId();
  const partnerId =
    typeof field.options['symmetric_field_id'] === 'string'
      ? field.options['symmetric_field_id']
      : null;
  const linkedFields = useQuery(fieldsQuery(linkedTable.id));
  const partner = linkedFields.data?.items.find((item) => item.id === partnerId);
  const [keep, setKeep] = useState<Side>('this');
  const [confirmed, setConfirmed] = useState(false);
  const kept = keep === 'this' ? field : partner;
  const removed = keep === 'this' ? partner : field;
  const keptTable = keep === 'this' ? { id: tableId, name: tableName } : linkedTable;
  const removedTable = keep === 'this' ? linkedTable : { id: tableId, name: tableName };
  const { preview, loading, stale, error, retry } = useConversionPreview(
    kept?.id ?? field.id,
    kept === undefined ? null : ONE_WAY,
  );
  const convertHere = useConvertField(tableId);
  const convertThere = useConvertField(linkedTable.id);
  const convert = keep === 'this' ? convertHere : convertThere;
  const dependents = useMemo(() => preview?.dependents ?? [], [preview]);
  const needsConfirm = preview !== undefined && (preview.requires_confirm || dependents.length > 0);
  const refused = preview !== undefined && !preview.allowed;
  const ready = preview !== undefined && !stale && !refused && (!needsConfirm || confirmed);
  const partnerName = partner?.name ?? t('field:link.reverseUnknown');
  const n = (value: number) => format.number(value);

  const submit = () => {
    if (!ready || kept === undefined) return;
    convert.mutate(
      {
        fieldId: kept.id,
        body: { ...ONE_WAY, ...(needsConfirm ? { confirm: true } : {}) },
        linkedTableId: removedTable.id,
      },
      {
        onSuccess: onClose,
        onError: (failure) => {
          if (isApiError(failure) && failure.code === 'CONVERSION_REQUIRES_CONFIRM') {
            setConfirmed(false);
            retry();
          }
        },
      },
    );
  };

  const choice = (side: Side) => {
    const selected = keep === side;
    const keptName = side === 'this' ? field.name : partnerName;
    const keptIn = side === 'this' ? tableName : linkedTable.name;
    const goneName = side === 'this' ? partnerName : field.name;
    const goneIn = side === 'this' ? linkedTable.name : tableName;
    const id = `${group}-${side}`;
    return (
      <label
        htmlFor={id}
        className={cn(
          'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 leading-snug',
          selected ? 'border-accent bg-accent-soft/60' : 'border-line',
          side === 'partner' && partner === undefined && 'cursor-not-allowed opacity-60',
        )}
      >
        <input
          id={id}
          type="radio"
          name={group}
          className="mt-0.5 size-4 shrink-0"
          checked={selected}
          disabled={side === 'partner' && partner === undefined}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-hint`}
          onChange={() => {
            setKeep(side);
            setConfirmed(false);
          }}
        />
        <span className="flex flex-col gap-0.5">
          <span id={`${id}-title`} className="font-medium text-fg">
            {t('field:convert.oneWay.keep', { field: keptName, table: keptIn })}
          </span>
          <span id={`${id}-hint`} className="text-label font-normal text-fg-muted">
            {t('field:convert.oneWay.keepHint', { field: goneName, table: goneIn })}
          </span>
        </span>
      </label>
    );
  };

  const busy = convert.isPending;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {t('field:convert.oneWay.title')}
          <span className="text-label font-normal text-fg-muted">
            {t('field:convert.oneWay.tables', { source: tableName, target: linkedTable.name })}
          </span>
        </span>
      }
      closeLabel={t('common:actions.close')}
      className="max-w-[1000px]"
    >
      <div className="-mx-6 grid border-y border-line md:grid-cols-[minmax(0,420px)_minmax(0,1fr)] md:max-h-[min(680px,calc(100dvh-12rem))] md:overflow-hidden">
        <div className="flex flex-col gap-4 p-5 md:border-r md:border-line md:overflow-y-auto">
          <fieldset className="flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-label text-fg">
              {t('field:convert.oneWay.which')}
            </legend>
            {choice('this')}
            {choice('partner')}
          </fieldset>
          <section aria-labelledby={`${group}-after`} className="flex flex-col gap-2">
            <h4 id={`${group}-after`} className="text-label font-medium text-fg">
              {t('field:convert.oneWay.after')}
            </h4>
            <div className="flex items-center gap-2" data-testid="one-way-diagram">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border border-line bg-surface p-2.5">
                <span className="flex items-center gap-1.5 text-label text-fg-muted">
                  <Table2 aria-hidden="true" className="size-3.5" />
                  {keptTable.name}
                </span>
                <span className="flex items-center gap-1.5 truncate font-medium text-fg">
                  <Link2 aria-hidden="true" className="size-3.5" />
                  {kept?.name ?? ''}
                </span>
              </div>
              <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border border-dashed border-danger/50 bg-danger/5 p-2.5">
                <span className="flex items-center gap-1.5 text-label text-fg-muted">
                  <Table2 aria-hidden="true" className="size-3.5" />
                  {removedTable.name}
                </span>
                <span className="flex items-center gap-1.5 truncate font-medium text-danger line-through">
                  <Link2 aria-hidden="true" className="size-3.5" />
                  {removed?.name ?? partnerName}
                  <span className="sr-only">{t('field:convert.oneWay.removed')}</span>
                </span>
              </div>
            </div>
            <p className="text-label font-normal text-fg-muted">
              {t('field:convert.oneWay.linksKept', { table: removedTable.name })}
            </p>
          </section>
        </div>
        <section
          aria-labelledby={`${group}-preview`}
          aria-busy={loading || stale}
          data-testid="conversion-pane"
          className="flex min-w-0 flex-col gap-3.5 bg-surface-sunken/40 p-5 md:overflow-y-auto"
        >
          <h3 id={`${group}-preview`} className="text-body font-semibold text-fg">
            {t('field:convert.pane.to_one_way')}
          </h3>
          {preview === undefined && error !== null ? (
            <div className="flex flex-col items-start gap-3">
              <Notice tone="danger">
                <p>
                  <strong>{t('field:convert.previewFailed')}</strong>{' '}
                  {translateError(error, i18n).message}
                </p>
              </Notice>
              <Button variant="secondary" size="sm" onClick={retry}>
                <RefreshCw aria-hidden="true" />
                {t('field:retry')}
              </Button>
            </div>
          ) : preview === undefined ? (
            <PreviewSkeleton label={t('field:convert.loading')} />
          ) : (
            <div className={cn('flex flex-col gap-3.5', stale && 'opacity-60')}>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Stat
                  data-testid="stat-dependents"
                  value={n(dependents.length)}
                  label={t('field:convert.oneWay.broken', { count: dependents.length })}
                  tone={dependents.length > 0 ? 'danger' : 'neutral'}
                />
                <Stat
                  value={n(preview.affected)}
                  label={t('field:convert.oneWay.cells', { count: preview.affected })}
                />
                <Stat value={n(0)} label={t('field:convert.oneWay.noLinkLost')} />
              </div>
              <DependentsList
                dependents={dependents}
                tableId={removedTable.id}
                baseId={baseId}
                computedToken="#REF!"
                title={t('field:convert.oneWay.usedBy', {
                  field: removed?.name ?? partnerName,
                  table: removedTable.name,
                })}
              />
              {dependents.length === 0 ? (
                <Notice tone="info">
                  <p>{t('field:convert.oneWay.noDependents')}</p>
                </Notice>
              ) : null}
              {refused ? (
                <Notice tone="danger">
                  <p>{t('field:convert.refused.notAllowed')}</p>
                </Notice>
              ) : needsConfirm ? (
                <Notice
                  tone="danger"
                  data-testid="conversion-confirm"
                  consent={{
                    label: t('field:convert.oneWay.consent', {
                      count: dependents.length,
                      formatted: n(dependents.length),
                    }),
                    checked: confirmed,
                    onChange: setConfirmed,
                  }}
                >
                  <p>
                    <strong>
                      {t('field:convert.oneWay.brokenTitle', {
                        count: dependents.length,
                        formatted: n(dependents.length),
                      })}
                    </strong>{' '}
                    {t('field:convert.oneWay.brokenBody')}
                  </p>
                </Notice>
              ) : null}
            </div>
          )}
          {convert.error === null ? null : isApiError(convert.error) &&
            convert.error.code === 'SCHEMA_LOCKED' ? (
            <Notice tone="danger">
              <p>{t('field:locked')}</p>
            </Notice>
          ) : (
            <ErrorAlert error={convert.error} />
          )}
        </section>
      </div>
      <div className="-mx-6 -mt-4 -mb-6 flex flex-wrap items-center gap-2 px-5 py-3">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label font-normal text-fg-muted">
          <History aria-hidden="true" className="size-3.5 shrink-0" />
          {t('field:convert.oneWay.footer')}
        </span>
        <Button variant="secondary" onClick={onCancel}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          variant="danger"
          disabled={!ready || busy}
          onClick={submit}
          data-testid="disable-two-way"
        >
          {busy ? <Spinner /> : null}
          {t('field:convert.oneWay.submit')}
        </Button>
      </div>
    </Dialog>
  );
}
