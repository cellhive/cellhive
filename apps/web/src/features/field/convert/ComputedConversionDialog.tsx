import { Button, Dialog, Spinner } from '@cellhive/ui';
import { ArrowLeft, History } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useConvertField } from '../mutations';

import { ConversionPane, type ConsentState } from './ConversionPane';
import { isRefused, requiredConsents } from './model';
import { useConversionPreview } from './use-conversion-preview';

import type { ConvertFieldPreviewRequest, FieldDto } from '@cellhive/contracts';

export interface ComputedConversionDialogProps {
  readonly field: FieldDto;
  readonly tableId: string;
  readonly baseId: string | undefined;
  /** `{ type: 'lookup', options }` built by the lookup editor. */
  readonly request: ConvertFieldPreviewRequest;
  /** Back to the lookup editor (the definition is kept there). */
  readonly onBack: () => void;
  readonly onDone: () => void;
}

const NO_CONSENTS: ConsentState = { confirm: false, acceptDataLoss: false };

/**
 * (T469; CONTRACTS §4.1, §4.4) The second step of turning a saved field
 * into a lookup: the lookup editor built the definition, this step shows
 * what the conversion does (`convert-preview`: values replaced by the
 * computed ones, kept 7 days for an undo; samples; formula/lookup fields
 * that break) and starts it (`PUT /fields/:id`) once confirmed. Formulas
 * go through the field dialog's own preview pane.
 */
export function ComputedConversionDialog({
  field,
  tableId,
  baseId,
  request,
  onBack,
  onDone,
}: ComputedConversionDialogProps) {
  const { t } = useTranslation(['field', 'common']);
  const preview = useConversionPreview(field.id, request);
  const convert = useConvertField(tableId);
  const [consents, setConsents] = useState<ConsentState>(NO_CONSENTS);
  const data = preview.preview;
  const required = data === undefined ? null : requiredConsents(data);
  const ready =
    data !== undefined &&
    !preview.stale &&
    !isRefused(data) &&
    required !== null &&
    (!required.confirm || consents.confirm) &&
    (!required.acceptDataLoss || consents.acceptDataLoss);
  const target = t(`field:types.${request.type}`);

  const submit = () => {
    if (!ready) return;
    convert.mutate(
      {
        fieldId: field.id,
        body: { ...request, ...(required.confirm ? { confirm: true } : {}) },
      },
      {
        onSuccess: onDone,
        onError: (failure) => {
          if (isApiError(failure) && failure.code === 'CONVERSION_REQUIRES_CONFIRM') {
            setConsents(NO_CONSENTS);
            preview.retry();
          }
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !convert.isPending) onDone();
      }}
      title={t('field:convert.computed.confirmTitle', { name: field.name, type: target })}
      closeLabel={t('common:actions.close')}
      className="max-w-[640px]"
      layout="sheet"
    >
      <div className="flex flex-col gap-4" data-testid="computed-conversion-dialog">
        <ConversionPane
          mode="type"
          tableId={tableId}
          baseId={baseId}
          targetType={request.type}
          targetLabel={target}
          preview={data}
          loading={preview.loading}
          stale={preview.stale}
          error={preview.error}
          onRetry={preview.retry}
          required={required}
          consents={consents}
          onConsents={setConsents}
        />
        {convert.error === null ? null : <ErrorAlert error={convert.error} />}
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label font-normal text-fg-muted">
            <History aria-hidden="true" className="size-3.5 shrink-0" />
            {t('field:convert.footer')}
          </span>
          <Button variant="secondary" disabled={convert.isPending} onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            {t('field:convert.computed.back')}
          </Button>
          <Button
            disabled={!ready || convert.isPending}
            data-testid="computed-conversion-submit"
            onClick={submit}
          >
            {convert.isPending ? <Spinner /> : null}
            {t('field:convert.submit.toComputed', { type: target })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
