import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { automationsApi } from '../../../lib/api/automations';
import { isApiError } from '../../../lib/api/client';
import { keys } from '../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import type { AutomationDto, AutomationList } from '@cellhive/contracts';

/** Puts the server's answer for one automation into the cached list (`null`: it is gone). */
function replaceInList(
  queryClient: QueryClient,
  baseId: string,
  automationId: string,
  next: AutomationDto | null,
): void {
  queryClient.setQueryData<AutomationList>(keys.automations(baseId), (list) => {
    if (list === undefined) return list;
    const items =
      next === null
        ? list.items.filter((item) => item.id !== automationId)
        : // The answer has no run counts (T518): keep the row's until the list is asked again.
          list.items.map((item) => (item.id === automationId ? { ...item, ...next } : item));
    return { ...list, items, total: list.total - (list.items.length - items.length) };
  });
}

export interface TakeOverInput {
  readonly automation: AutomationDto;
  readonly enable: boolean;
}

/**
 * The list's writes (CONTRACTS §21, ADR-25): turn on/off, take over, delete.
 * Each sends the version on screen (`If-Match`); the answer replaces
 * the row, then the list is asked again (another person may have changed
 * others). `409` (changed elsewhere) and `404` (deleted, or no longer
 * managed) refresh the list with a notice; other refusals — `422
 * AUTOMATION_INVALID` such as `NO_ACTIONS` — are explained by an error toast.
 * Creating happens in the builder (T521).
 */
export function useAutomationActions(baseId: string) {
  const { t } = useTranslation('automation');
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.automations(baseId) }, { cancelRefetch: false });

  const onFailure = (automation: AutomationDto) => async (error: unknown) => {
    if (isApiError(error) && error.status === 409) {
      showToast({ variant: 'warning', message: t('toast.conflict', { name: automation.name }) });
    } else if (isApiError(error) && error.status === 404) {
      showToast({ variant: 'warning', message: t('toast.gone', { name: automation.name }) });
    } else {
      showErrorToast(error);
    }
    await refresh();
  };

  const settle = async (automation: AutomationDto, next: AutomationDto | null) => {
    replaceInList(queryClient, baseId, automation.id, next);
    await refresh();
  };

  const enable = useMutation({
    mutationFn: (automation: AutomationDto) =>
      automationsApi.enable(automation.id, automation.version),
    onSuccess: async (next, automation) => {
      showToast({ variant: 'success', message: t('toast.enabled', { name: next.name }) });
      await settle(automation, next);
    },
    onError: (error, automation) => onFailure(automation)(error),
  });

  const disable = useMutation({
    mutationFn: (automation: AutomationDto) =>
      automationsApi.disable(automation.id, automation.version),
    onSuccess: async (next, automation) => {
      showToast({ variant: 'success', message: t('toast.disabled', { name: next.name }) });
      await settle(automation, next);
    },
    onError: (error, automation) => onFailure(automation)(error),
  });

  const takeOver = useMutation({
    mutationFn: ({ automation, enable: on }: TakeOverInput) =>
      automationsApi.takeOver(automation.id, automation.version, on),
    onSuccess: async (next, { automation }) => {
      showToast({ variant: 'success', message: t('takeOver.done', { name: next.name }) });
      await settle(automation, next);
    },
    onError: (error, { automation }) => onFailure(automation)(error),
  });

  const remove = useMutation({
    mutationFn: (automation: AutomationDto) =>
      automationsApi.remove(automation.id, automation.version),
    onSuccess: async (_, automation) => {
      showToast({ variant: 'success', message: t('delete.done', { name: automation.name }) });
      await settle(automation, null);
    },
    onError: (error, automation) => onFailure(automation)(error),
  });

  /** One write at a time per automation: its controls wait while one is running. */
  const pendingId =
    (enable.isPending ? enable.variables.id : null) ??
    (disable.isPending ? disable.variables.id : null) ??
    (takeOver.isPending ? takeOver.variables.automation.id : null) ??
    (remove.isPending ? remove.variables.id : null);

  return { enable, disable, takeOver, remove, pendingId };
}
