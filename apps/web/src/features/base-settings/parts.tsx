import { Button, cn, Dialog, Spinner } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../lib/errors/ErrorAlert';

import type { ReactNode } from 'react';

/** A tinted note with an icon (the recipe of FRONTEND §15.3/§16.1, tokens only). */
export function Note({
  icon,
  title,
  children,
  'data-testid': testId,
}: {
  readonly icon: ReactNode;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
}) {
  return (
    <div
      role="note"
      data-testid={testId}
      className="flex gap-2.5 rounded-lg border border-line bg-surface-sunken px-3 py-2.5 text-label font-normal text-fg"
    >
      <span aria-hidden="true" className="mt-0.5 flex shrink-0 text-fg-muted [&>svg]:size-4">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {title === undefined ? null : <strong className="font-semibold">{title}</strong>}
        {children === undefined ? null : <div className="leading-relaxed">{children}</div>}
      </div>
    </div>
  );
}

/**
 * A confirmation of a destructive action (`alertdialog`, S6-research §4 #4):
 * what is lost, Cancel, and the action named on its button. Without
 * `onConfirm` it only explains (e.g. a role still assigned) and offers Close.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  pending = false,
  error,
  children,
  onConfirm,
  onCancel,
  'data-testid': testId,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel?: string;
  readonly pending?: boolean;
  readonly error?: unknown;
  readonly children?: ReactNode;
  readonly onConfirm?: () => void;
  readonly onCancel: () => void;
  readonly 'data-testid'?: string;
}) {
  const { t } = useTranslation('baseSettings');
  return (
    <Dialog
      open
      role="alertdialog"
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={title}
      description={description}
      closeLabel={t('page.close')}
    >
      <div className="flex flex-col gap-4" data-testid={testId}>
        {children}
        {error === undefined || error === null ? null : <ErrorAlert error={error} />}
        <div className={cn('flex flex-wrap justify-end gap-2')}>
          <Button variant="secondary" onClick={onCancel}>
            {onConfirm === undefined ? t('page.close') : t('page.cancel')}
          </Button>
          {onConfirm === undefined || confirmLabel === undefined ? null : (
            <Button
              variant="danger"
              disabled={pending}
              data-testid={testId === undefined ? undefined : `${testId}-confirm`}
              onClick={onConfirm}
            >
              {pending ? <Spinner /> : null}
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
