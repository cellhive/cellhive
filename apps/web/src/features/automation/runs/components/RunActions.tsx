import { Button, Dialog, Spinner } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../../lib/api/client';
import { keys } from '../../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../../lib/toast/toast';
import { automationRunsApi } from '../api';

import type { AutomationRunDto } from '@cellhive/contracts';

function Footer({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2 pt-1">{children}</div>;
}

/**
 * "Re-run?" (BACKLOG T523; Quyết định S5 thiết kế #4): the new run uses the
 * automation's **current** definition; steps that succeeded and are still
 * in it are not repeated (CONTRACTS §21). When the definition changed since
 * the run, the dialog says so.
 */
export function RerunDialog({
  runVersion,
  currentVersion,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly runVersion: number;
  /** Current version of the automation, `null` when unknown (list row). */
  readonly currentVersion: number | null;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation('automationRuns');
  const changed = currentVersion !== null && currentVersion !== runVersion;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      title={t('rerun.title')}
      closeLabel={t('rerun.cancel')}
      className="max-w-[480px]"
      layout="sheet"
    >
      <div className="flex flex-col gap-3" data-testid="rerun-dialog">
        <p className="text-body">{t('rerun.body')}</p>
        <p className="text-body text-fg-muted">{t('rerun.reuse')}</p>
        {changed ? (
          <div
            role="note"
            className="flex gap-2.5 rounded-lg border border-warning/50 bg-option-3 px-3 py-2.5 text-label font-normal text-fg"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>{t('rerun.changed', { from: runVersion, to: currentVersion })}</span>
          </div>
        ) : null}
        <Footer>
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            {t('rerun.cancel')}
          </Button>
          <Button disabled={pending} onClick={onConfirm} data-testid="rerun-confirm">
            {pending ? <Spinner /> : <RotateCcw aria-hidden="true" />}
            {t('rerun.confirm')}
          </Button>
        </Footer>
      </div>
    </Dialog>
  );
}

/** "Cancel this run?": a destructive confirmation (alert dialog, red button). */
export function CancelRunDialog({
  status,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly status: AutomationRunDto['status'];
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation('automationRuns');
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      title={t('cancelRun.title')}
      closeLabel={t('cancelRun.keep')}
      className="max-w-[480px]"
      layout="sheet"
    >
      <div className="flex flex-col gap-3" data-testid="cancel-run-dialog">
        <p className="text-body">
          {t(status === 'waiting' ? 'cancelRun.bodyWaiting' : 'cancelRun.bodyQueued')}
        </p>
        <Footer>
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            {t('cancelRun.keep')}
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={onConfirm}
            data-testid="cancel-run-confirm"
          >
            {pending ? <Spinner /> : null}
            {t('cancelRun.confirm')}
          </Button>
        </Footer>
      </div>
    </Dialog>
  );
}

export type RunAction =
  | {
      readonly kind: 'rerun';
      readonly run: AutomationRunDto;
      readonly currentVersion: number | null;
    }
  | { readonly kind: 'cancel'; readonly run: AutomationRunDto };

/**
 * Re-run and cancel with their confirmations. Afterwards the run lists of
 * the base and the run are asked again; `409 RUN_STATE_CONFLICT` (the run
 * changed meanwhile, or a re-run is still going) → a warning and fresh data;
 * `404` → the run is gone or no longer theirs to manage.
 */
export function useRunActions(baseId: string, onRerun: (run: AutomationRunDto) => void) {
  const { t } = useTranslation('automationRuns');
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<RunAction | null>(null);

  const refresh = (runId: string) => {
    void queryClient.invalidateQueries({ queryKey: keys.automationRunsOfBase(baseId) });
    void queryClient.invalidateQueries({ queryKey: keys.automationRun(runId) });
    // The list's last run and errors in 24 h.
    void queryClient.invalidateQueries({ queryKey: keys.automations(baseId), exact: true });
  };
  const onError = (error: unknown, runId: string) => {
    setAsking(null);
    if (isApiError(error) && error.status === 409) {
      showToast({ variant: 'warning', message: t('toast.conflict') });
      refresh(runId);
      return;
    }
    if (isApiError(error) && error.status === 404) {
      showToast({ variant: 'warning', message: t('toast.gone') });
      refresh(runId);
      return;
    }
    showErrorToast(error);
  };

  const rerun = useMutation({
    mutationFn: (run: AutomationRunDto) => automationRunsApi.rerun(run.id),
    onSuccess: (created, run) => {
      setAsking(null);
      refresh(run.id);
      showToast({ variant: 'success', message: t('toast.rerun') });
      onRerun(created);
    },
    onError: (error, run) => {
      onError(error, run.id);
    },
  });
  const cancel = useMutation({
    mutationFn: (run: AutomationRunDto) => automationRunsApi.cancel(run.id),
    onSuccess: (_, run) => {
      setAsking(null);
      refresh(run.id);
      showToast({ variant: 'success', message: t('toast.cancelled') });
    },
    onError: (error, run) => {
      onError(error, run.id);
    },
  });

  const dialog =
    asking === null ? null : asking.kind === 'rerun' ? (
      <RerunDialog
        runVersion={asking.run.automation_version}
        currentVersion={asking.currentVersion}
        pending={rerun.isPending}
        onCancel={() => {
          setAsking(null);
        }}
        onConfirm={() => {
          rerun.mutate(asking.run);
        }}
      />
    ) : (
      <CancelRunDialog
        status={asking.run.status}
        pending={cancel.isPending}
        onCancel={() => {
          setAsking(null);
        }}
        onConfirm={() => {
          cancel.mutate(asking.run);
        }}
      />
    );

  return {
    ask: setAsking,
    pendingId: rerun.isPending ? rerun.variables.id : cancel.isPending ? cancel.variables.id : null,
    dialog,
  };
}
