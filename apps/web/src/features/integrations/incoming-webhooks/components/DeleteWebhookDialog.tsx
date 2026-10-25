import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { incomingWebhooksApi } from '../api';
import { useHookCache } from '../cache';
import { usagesOfInUseError } from '../model';

import { ConfirmDialog } from './ConfirmDialog';
import { UsageList } from './UsageList';

import type { IncomingWebhookDto } from '@cellhive/contracts';

/**
 * Deleting a webhook: refused while automations are triggered by it
 * (`409 WEBHOOK_IN_USE`, CONTRACTS §25.1). The automations known from the
 * list are shown first and disable "Delete"; a `409` (an automation added
 * meanwhile) shows the server's list instead of a bare error.
 */
export function DeleteWebhookDialog({
  baseId,
  hook,
  onClose,
  onDeleted,
}: {
  readonly baseId: string;
  readonly hook: IncomingWebhookDto | null;
  readonly onClose: () => void;
  readonly onDeleted: (hook: IncomingWebhookDto) => void;
}) {
  const { t } = useTranslation('incomingWebhooks');
  const { refresh } = useHookCache(baseId);
  const remove = useMutation({
    mutationFn: (target: IncomingWebhookDto) => incomingWebhooksApi.remove(target.id),
    onSuccess: (_result, target) => {
      onDeleted(target);
    },
    onError: () => {
      refresh();
    },
  });
  const inUse = usagesOfInUseError(remove.error);
  const usages = inUse ?? hook?.usages ?? [];
  return (
    <ConfirmDialog
      open={hook !== null}
      title={hook === null ? '' : t('delete.title', { name: hook.name })}
      description={t('delete.body')}
      confirmLabel={t('delete.confirm')}
      pending={remove.isPending}
      confirmDisabled={usages.length > 0}
      data-testid="hook-delete-dialog"
      onCancel={() => {
        remove.reset();
        onClose();
      }}
      onConfirm={() => {
        if (hook !== null) remove.mutate(hook);
      }}
    >
      {usages.length > 0 ? (
        <div className="flex flex-col gap-2" role={inUse === null ? undefined : 'alert'}>
          <p className="text-body text-fg">{t('delete.inUse', { count: usages.length })}</p>
          <UsageList baseId={baseId} usages={usages} data-testid="hook-delete-usages" />
        </div>
      ) : null}
      {remove.isError && inUse === null ? <ErrorAlert error={remove.error} /> : null}
    </ConfirmDialog>
  );
}
