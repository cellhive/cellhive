import { Button, Dialog, Spinner } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';

import type { ReactNode } from 'react';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string | undefined;
  readonly children?: ReactNode;
  readonly confirmLabel: string;
  /** `danger`: breaks integrations (new URL, new token, removed check, delete). */
  readonly tone?: 'danger' | 'primary';
  readonly pending?: boolean;
  readonly error?: unknown;
  readonly confirmDisabled?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly 'data-testid'?: string;
}

/**
 * Confirmation of an action on a webhook (WAI-ARIA `alertdialog`): what
 * changes for the sending system, Cancel, and the action named on its button.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  tone = 'danger',
  pending = false,
  error,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  'data-testid': testId,
}: ConfirmDialogProps) {
  const { t } = useTranslation('incomingWebhooks');
  return (
    <Dialog
      open={open}
      role="alertdialog"
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={title}
      description={description}
      closeLabel={t('common.close')}
    >
      <div className="flex flex-col gap-4" data-testid={testId}>
        {children}
        {error === undefined || error === null ? null : <ErrorAlert error={error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={pending || confirmDisabled}
            data-testid={testId === undefined ? undefined : `${testId}-confirm`}
            onClick={onConfirm}
          >
            {pending ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
