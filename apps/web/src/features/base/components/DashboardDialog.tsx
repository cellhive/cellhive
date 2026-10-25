import {
  MAX_DASHBOARD_NAME_LENGTH,
  type DashboardSummaryDto,
  DashboardList,
} from '@cellhive/contracts';
import { Button, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { dashboardsApi } from '../../../lib/api/dashboards';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { dashboardPath } from '../../../lib/query/dashboards';
import { keys } from '../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

/** What the sidebar asked for. */
export type DashboardDialogRequest =
  | { readonly kind: 'create' }
  | { readonly kind: 'rename'; readonly dashboard: DashboardSummaryDto }
  | { readonly kind: 'delete'; readonly dashboard: DashboardSummaryDto };

export interface DashboardDialogProps {
  readonly baseId: string;
  readonly request: DashboardDialogRequest;
  readonly onClose: () => void;
}

/**
 * (T811) Dialogs of the sidebar's "Dashboards" group, base admins only:
 * create (name → `POST /bases/:id/dashboards`, then open it), rename
 * (`PATCH` with the version the list showed: `409` when changed meanwhile)
 * and delete (alert dialog → `DELETE`, 30 days in the base trash, "Undo" in
 * the toast). Name conflicts show under the field (`409 NAME_CONFLICT`).
 */
export function DashboardDialog({ baseId, request, onClose }: DashboardDialogProps) {
  return request.kind === 'delete' ? (
    <DeleteDashboard baseId={baseId} dashboard={request.dashboard} onClose={onClose} />
  ) : (
    <NameDashboard baseId={baseId} request={request} onClose={onClose} />
  );
}

function NameDashboard({
  baseId,
  request,
  onClose,
}: {
  readonly baseId: string;
  readonly request: Exclude<DashboardDialogRequest, { kind: 'delete' }>;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation(['base', 'common']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(
    request.kind === 'rename' ? request.dashboard.name : t('base:dashboards.defaultName'),
  );
  const save = useMutation({
    mutationFn: () =>
      request.kind === 'rename'
        ? dashboardsApi.rename(request.dashboard.id, name.trim(), request.dashboard.version)
        : dashboardsApi.create(baseId, { name: name.trim() }),
    onSuccess: async (dashboard) => {
      await queryClient.invalidateQueries({ queryKey: keys.dashboards(baseId) });
      if (request.kind === 'rename') {
        queryClient.setQueryData(keys.dashboard(dashboard.id), dashboard);
      } else {
        await navigate(dashboardPath(baseId, dashboard.id));
      }
      onClose();
    },
  });
  const empty = name.trim() === '';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
      title={t(
        request.kind === 'rename' ? 'base:dashboards.renameTitle' : 'base:dashboards.createTitle',
      )}
      closeLabel={t('common:actions.close')}
      className="max-w-md"
    >
      <form
        className="flex flex-col gap-4"
        data-testid="dashboard-name-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!empty) save.mutate();
        }}
      >
        <FormField label={t('base:dashboards.name')}>
          {(control) => (
            <Input
              {...control}
              autoFocus
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              maxLength={MAX_DASHBOARD_NAME_LENGTH}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </FormField>
        {save.isError ? <ErrorAlert error={save.error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={save.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" disabled={empty || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            {t(request.kind === 'rename' ? 'base:dashboards.save' : 'base:dashboards.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDashboard({
  baseId,
  dashboard,
  onClose,
}: {
  readonly baseId: string;
  readonly dashboard: DashboardSummaryDto;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation(['base', 'common']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const path = dashboardPath(baseId, dashboard.id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.dashboards(baseId) });

  const restore = async () => {
    try {
      await dashboardsApi.restore(dashboard.id);
      await refresh();
      showToast({
        variant: 'success',
        message: t('base:dashboards.restored', { name: dashboard.name }),
      });
    } catch (error) {
      showErrorToast(error);
    }
  };

  const remove = useMutation({
    mutationFn: () => dashboardsApi.remove(dashboard.id),
    onSuccess: async () => {
      queryClient.setQueryData(keys.dashboards(baseId), (list: DashboardList | undefined) =>
        list === undefined
          ? list
          : { ...list, items: list.items.filter((item) => item.id !== dashboard.id) },
      );
      if (location.pathname === path) {
        await navigate(`/b/${encodeURIComponent(baseId)}`, { replace: true });
      }
      onClose();
      await refresh();
      showToast({
        variant: 'success',
        message: t('base:dashboards.deleted', { name: dashboard.name }),
        actions: [
          {
            label: t('base:dashboards.undo'),
            primary: true,
            onClick: () => {
              void restore();
            },
          },
        ],
      });
    },
  });

  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
      title={t('base:dashboards.deleteTitle', { name: dashboard.name })}
      description={t('base:dashboards.deleteDescription')}
      closeLabel={t('common:actions.close')}
      className="max-w-md"
    >
      <div className="flex flex-col gap-4" data-testid="delete-dashboard-dialog">
        {remove.isError ? <ErrorAlert error={remove.error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={remove.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            data-testid="delete-dashboard-confirm"
            onClick={() => {
              remove.mutate();
            }}
          >
            {remove.isPending ? <Spinner /> : null}
            {t('base:dashboards.deleteSubmit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export default DashboardDialog;
