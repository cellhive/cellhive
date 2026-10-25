import { Button, Dialog } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { automationsApi } from '../../../lib/api/automations';
import { isApiError, type ApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { keys } from '../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import { duplicateFailureOf, type DuplicateFailure } from './model/duplicate';

import type { AutomationDto } from '@cellhive/contracts';

interface Failure {
  readonly automation: Pick<AutomationDto, 'id' | 'name'>;
  readonly error: ApiError;
  readonly kind: Exclude<DuplicateFailure, 'gone' | 'other'>;
}

/**
 * "Could not duplicate «X»" (T556): why, in words — a button runs only one
 * automation (`BUTTON_IN_USE`, `reason = duplicate`), the copy would run
 * with the caller's permissions and the source uses tables or fields
 * outside them (P43), the definition no longer saves, or the caller no
 * longer manages it — with the server's details and a way on.
 */
function DuplicateFailedDialog({
  failure,
  baseId,
  linkToSource,
  onClose,
}: {
  readonly failure: Failure;
  readonly baseId: string;
  readonly linkToSource: boolean;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation(['automation', 'errors']);
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('duplicate.failedTitle', { name: failure.automation.name })}
      closeLabel={t('duplicate.close')}
      className="max-w-[520px]"
      layout="sheet"
    >
      <div className="flex flex-col gap-3" data-testid="duplicate-failed-dialog">
        {failure.kind === 'button' ? (
          <p className="text-body text-fg" data-testid="duplicate-failed-reason">
            {t('errors:detail.BUTTON_IN_USE', { context: 'duplicate' })}
          </p>
        ) : (
          <>
            <p className="text-body text-fg" data-testid="duplicate-failed-reason">
              {t(`duplicate.failure.${failure.kind}`)}
            </p>
            {failure.kind === 'forbidden' ? null : <ErrorAlert error={failure.error} />}
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {linkToSource && failure.kind !== 'forbidden' ? (
            <Button asChild variant="secondary" className="max-sm:h-11">
              <Link to={`/b/${baseId}/automations/${failure.automation.id}`} onClick={onClose}>
                {t('duplicate.openSource')}
              </Link>
            </Button>
          ) : null}
          <Button className="max-sm:h-11" onClick={onClose} data-testid="duplicate-failed-close">
            {t('duplicate.close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * (T556) "Duplicate" of the automation list's row menu and of the builder's
 * header: `POST /automations/:id/duplicate` (T551) — the copy is created
 * turned off, runs with the caller's permissions, and opens in the builder.
 * `404` (deleted meanwhile) is a toast and refreshes the list; other
 * refusals open a dialog that explains them (`dialog`, rendered by the page).
 * `linkToSource`: the dialog offers to open the source (the list; the
 * builder is already on it).
 */
export function useDuplicateAutomation(baseId: string, options: { linkToSource: boolean }) {
  const { t } = useTranslation('automation');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [failure, setFailure] = useState<Failure | null>(null);
  const mutation = useMutation({
    mutationFn: (automation: Pick<AutomationDto, 'id' | 'name'>) =>
      automationsApi.duplicate(automation.id),
    onSuccess: async (copy) => {
      queryClient.setQueryData(keys.automation(baseId, copy.id), copy);
      showToast({ variant: 'success', message: t('duplicate.done', { name: copy.name }) });
      await navigate(`/b/${baseId}/automations/${copy.id}`);
      void queryClient.invalidateQueries(
        { queryKey: keys.automations(baseId) },
        { cancelRefetch: false },
      );
    },
    onError: (error, automation) => {
      if (!isApiError(error)) {
        showErrorToast(error);
        return;
      }
      const kind = duplicateFailureOf(error);
      if (kind === 'gone') {
        showToast({ variant: 'warning', message: t('toast.gone', { name: automation.name }) });
        void queryClient.invalidateQueries({ queryKey: keys.automations(baseId) });
        return;
      }
      if (kind === 'other') {
        showErrorToast(error);
        return;
      }
      setFailure({ automation, error, kind });
    },
  });
  const dialog =
    failure === null ? null : (
      <DuplicateFailedDialog
        failure={failure}
        baseId={baseId}
        linkToSource={options.linkToSource}
        onClose={() => {
          setFailure(null);
        }}
      />
    );
  return {
    duplicate: (automation: Pick<AutomationDto, 'id' | 'name'>) => {
      mutation.mutate(automation);
    },
    pendingId: mutation.isPending ? mutation.variables.id : null,
    dialog,
  };
}
