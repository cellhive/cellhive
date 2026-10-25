import { FIELD_CONVERSION_REVERT_WINDOW_DAYS } from '@cellhive/contracts';
import { Button, cn, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { History, RefreshCw, Undo2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../lib/api';
import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { translateError } from '../../../lib/errors/translate';
import { useFormatters } from '../../../lib/i18n/format';
import { dismissFieldConversion } from '../../../lib/realtime/field-conversions';
import { daysLeft } from '../../../lib/schema/conversion';
import { showToast } from '../../../lib/toast/toast';
import { useRevertConversion } from '../mutations';

import { Notice, Stat } from './parts';

import type { FieldDto, RevertConversionMode } from '@cellhive/contracts';

export interface RevertConversionDialogProps {
  readonly field: FieldDto;
  readonly tableId: string;
  readonly tableName: string;
  readonly onClose: () => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Undo the last type conversion of a field (T414; board "Đổi kiểu, xong và
 * hoàn tác", BACKLOG S4 design decision #7): by default only the cells not
 * edited since go back (later edits are kept); "restore as a new field"
 * keeps the converted field and brings the old version next to it; the
 * edited cells are overwritten only when the user picks it, with the
 * count, and ticks the box. The counts come from the revert preview.
 */
export function RevertConversionDialog({
  field,
  tableId,
  tableName,
  onClose,
}: RevertConversionDialogProps) {
  const { t } = useTranslation(['field', 'common']);
  const { i18n } = useTranslation('errors');
  const format = useFormatters();
  const group = useId();
  const preview = useQuery({
    queryKey: ['field', field.id, 'revert-preview'] as const,
    queryFn: ({ signal }) => api.fields.revertPreview(field.id, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const revert = useRevertConversion(tableId);
  const [mode, setMode] = useState<RevertConversionMode>('keep_later_edits');
  const [confirmed, setConfirmed] = useState(false);
  const [name, setName] = useState(() =>
    t('field:convert.revert.newFieldName', { name: field.name }),
  );
  const data = preview.data;
  const n = (value: number) => format.number(value);
  const linkChange = data?.link_change?.change;
  const linkedTableId = data?.link_change?.partner_table_id;

  const expired = isApiError(preview.error) && preview.error.status === 404;
  const running = isApiError(preview.error) && preview.error.status === 409;
  const edited = data?.edited ?? 0;
  const unconvertible = data?.edited_unconvertible ?? 0;
  const needsConfirm =
    data !== undefined &&
    ((mode === 'overwrite_later_edits' && edited > 0) ||
      (mode === 'keep_later_edits' && unconvertible > 0));
  const nameEmpty = mode === 'new_field' && name.trim() === '';
  const ready = data !== undefined && (!needsConfirm || confirmed) && !nameEmpty;
  const fromLabel =
    data === undefined ? '' : t(`field:types.${data.from_type}`, { defaultValue: data.from_type });
  const until = data?.revertible_until ?? field.conversion?.revertible_until;
  const convertedAt =
    until === undefined
      ? undefined
      : new Date(Date.parse(until) - FIELD_CONVERSION_REVERT_WINDOW_DAYS * DAY_MS);
  const nameConflict = isApiError(revert.error) && revert.error.code === 'NAME_CONFLICT';

  const submit = () => {
    if (!ready) return;
    revert.mutate(
      {
        fieldId: field.id,
        body: {
          mode,
          ...(needsConfirm ? { confirm: true } : {}),
          ...(mode === 'new_field' ? { name: name.trim() } : {}),
        },
        linkedTableId,
      },
      {
        onSuccess: (result) => {
          dismissFieldConversion(field.id);
          showToast({
            variant: 'success',
            message:
              mode === 'new_field'
                ? t('field:convert.revert.doneNewField', { name: result.name })
                : t('field:convert.revert.done', { name: field.name }),
          });
          onClose();
        },
        onError: (failure) => {
          if (isApiError(failure) && failure.code === 'CONVERSION_REQUIRES_CONFIRM') {
            setConfirmed(false);
            void preview.refetch();
          }
        },
      },
    );
  };

  const option = (value: RevertConversionMode, title: string, hint: string) => {
    const id = `${group}-${value}`;
    const selected = mode === value;
    return (
      <label
        key={value}
        htmlFor={id}
        className={cn(
          'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 leading-snug',
          selected ? 'border-accent bg-accent-soft/60' : 'border-line',
        )}
      >
        <input
          id={id}
          type="radio"
          name={group}
          value={value}
          checked={selected}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-hint`}
          className="mt-0.5 size-4 shrink-0"
          onChange={() => {
            setMode(value);
            setConfirmed(false);
          }}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span id={`${id}-title`} className="font-medium text-fg">
            {title}
          </span>
          <span id={`${id}-hint`} className="text-label font-normal text-fg-muted">
            {hint}
          </span>
        </span>
      </label>
    );
  };

  let body;
  if (expired) {
    body = (
      <div className="flex flex-col gap-2" data-testid="revert-expired">
        <p className="flex items-center gap-2 font-medium text-fg">
          <Undo2 aria-hidden="true" className="size-4 text-fg-muted" />
          {t('field:convert.revert.expiredTitle')}
        </p>
        <p className="text-fg-muted">
          {convertedAt === undefined
            ? t('field:convert.revert.expiredBody')
            : t('field:convert.revert.expiredSince', { date: format.date(convertedAt) })}
        </p>
      </div>
    );
  } else if (running) {
    body = (
      <Notice tone="info">
        <p>{t('field:convert.revert.running')}</p>
      </Notice>
    );
  } else if (data === undefined && preview.error !== null) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <Notice tone="danger">
          <p>{translateError(preview.error, i18n).message}</p>
        </Notice>
        <Button variant="secondary" size="sm" onClick={() => void preview.refetch()}>
          <RefreshCw aria-hidden="true" />
          {t('field:retry')}
        </Button>
      </div>
    );
  } else if (data === undefined) {
    body = (
      <p role="status" className="flex items-center gap-2 text-fg-muted">
        <Spinner />
        {t('field:convert.loading')}
      </p>
    );
  } else if (linkChange === 'to_two_way' || linkChange === 'to_one_way') {
    body = (
      <p className="leading-relaxed" data-testid="revert-summary">
        {t(`field:convert.revert.link.${linkChange}`, {
          field: field.name,
          table: tableName,
        })}
      </p>
    );
  } else {
    const newFieldAvailable = data.new_field_available && linkChange === undefined;
    body = (
      <>
        <p className="leading-relaxed" data-testid="revert-summary">
          {linkChange === 'to_single'
            ? t('field:convert.revert.link.to_single', { field: field.name })
            : t('field:convert.revert.summary', {
                field: field.name,
                type: fromLabel,
                date: convertedAt === undefined ? '' : format.dateTime(convertedAt),
              })}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Stat
            data-testid="revert-unchanged"
            value={n(data.unchanged)}
            label={t('field:convert.revert.unchanged', { count: data.unchanged })}
          />
          <Stat
            data-testid="revert-edited"
            value={n(edited)}
            label={t('field:convert.revert.edited', { count: edited })}
            tone={edited > 0 ? 'warning' : 'neutral'}
          />
        </div>
        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-label text-fg">{t('field:convert.revert.how')}</legend>
          {option(
            'keep_later_edits',
            t('field:convert.revert.keep'),
            t('field:convert.revert.keepHint', {
              count: edited,
              formatted: n(edited),
              type: fromLabel,
            }),
          )}
          {newFieldAvailable
            ? option(
                'new_field',
                t('field:convert.revert.newField'),
                t('field:convert.revert.newFieldHint'),
              )
            : null}
          {edited > 0
            ? option(
                'overwrite_later_edits',
                t('field:convert.revert.overwrite'),
                t('field:convert.revert.overwriteHint', { count: edited, formatted: n(edited) }),
              )
            : null}
        </fieldset>
        {mode === 'new_field' ? (
          <FormField
            label={t('field:convert.revert.newFieldLabel')}
            error={nameConflict ? t('field:validation.NAME_CONFLICT') : undefined}
          >
            {(control) => (
              <Input
                {...control}
                autoComplete="off"
                maxLength={255}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (revert.error !== null) revert.reset();
                }}
              />
            )}
          </FormField>
        ) : null}
        {mode === 'overwrite_later_edits' && edited > 0 ? (
          <Notice
            tone="warning"
            data-testid="revert-confirm"
            consent={{
              label: t('field:convert.revert.overwriteConsent', {
                count: edited,
                formatted: n(edited),
              }),
              checked: confirmed,
              onChange: setConfirmed,
            }}
          >
            <p>
              <strong>
                {t('field:convert.revert.overwriteTitle', { count: edited, formatted: n(edited) })}
              </strong>{' '}
              {t('field:convert.revert.overwriteBody')}
            </p>
          </Notice>
        ) : null}
        {mode === 'keep_later_edits' && unconvertible > 0 ? (
          <Notice
            tone="warning"
            data-testid="revert-confirm"
            consent={{
              label: t('field:convert.revert.unconvertibleConsent', {
                count: unconvertible,
                formatted: n(unconvertible),
              }),
              checked: confirmed,
              onChange: setConfirmed,
            }}
          >
            <p>
              <strong>
                {t('field:convert.revert.unconvertibleTitle', {
                  count: unconvertible,
                  formatted: n(unconvertible),
                  type: fromLabel,
                })}
              </strong>{' '}
              {t('field:convert.revert.unconvertibleBody')}
            </p>
          </Notice>
        ) : null}
        {data.from_type === 'formula' || data.from_type === 'lookup' ? (
          // (T469) Back to a formula/lookup: its values are computed again, edits do not stay.
          <Notice tone="info" data-testid="revert-to-computed">
            <p>
              <strong>{t('field:convert.revert.toComputedTitle', { type: fromLabel })}</strong>{' '}
              {t('field:convert.revert.toComputedBody')}
            </p>
          </Notice>
        ) : null}
        {linkChange === undefined ? (
          <Notice tone="info">
            <p>
              <strong>{t('field:convert.revert.dependentsTitle')}</strong>{' '}
              {t('field:convert.revert.dependentsBody', { type: fromLabel })}
            </p>
          </Notice>
        ) : null}
      </>
    );
  }

  const left = until === undefined ? 0 : daysLeft(until);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {t('field:convert.revert.title')}
          <span className="text-label font-normal text-fg-muted">
            {tableName} · {field.name}
          </span>
        </span>
      }
      closeLabel={t('common:actions.close')}
      className="max-w-[520px]"
    >
      <div className="-mx-6 flex flex-col gap-3.5 border-t border-line px-5 pt-5 text-body">
        {body}
        {revert.error !== null && !nameConflict ? <ErrorAlert error={revert.error} /> : null}
      </div>
      <div className="-mx-6 -mb-6 flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        {until === undefined || expired ? (
          <span className="flex-1" />
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label font-normal text-fg-muted">
            <History aria-hidden="true" className="size-3.5 shrink-0" />
            {t('field:convert.revert.footer', {
              count: left,
              date: format.date(until),
            })}
          </span>
        )}
        <Button variant="secondary" onClick={onClose}>
          {expired ? t('common:actions.close') : t('common:actions.cancel')}
        </Button>
        {expired || running ? null : (
          <Button
            variant={mode === 'overwrite_later_edits' ? 'danger' : 'primary'}
            disabled={!ready || revert.isPending}
            onClick={submit}
            data-testid="revert-submit"
          >
            {revert.isPending ? <Spinner /> : null}
            {t('field:convert.revert.submit')}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
