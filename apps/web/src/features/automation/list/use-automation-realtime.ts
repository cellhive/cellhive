import { userChannel, type AutomationDto, type AutomationList, type Id } from '@cellhive/contracts';
import { useQueryClient } from '@tanstack/react-query';

import { keys } from '../../../lib/query/keys';
import { useRealtimeChannel } from '../../../lib/realtime/channels';

import { newlyDisabled } from './model/filter';

/**
 * (T520, board "S5 · Automation list - trạng thái": "Realtime") There is no
 * automation message on `base:`; the system turning one off (circuit
 * breaker, `run_as` lost access — ADR-25 §5, ADR-26 §5) sends the
 * `automation.disabled` notification to the base's admins (CONTRACTS §22),
 * announced on their `user:` channel (`notification.created`, §7). For this
 * base, the list is asked again at once and `onDisabled` gets the
 * automations that went from on to off with a reason. Reconnecting asks the
 * list again (messages missed meanwhile).
 */
export function useAutomationRealtime(
  baseId: string,
  userId: string | null,
  onDisabled: (automations: readonly AutomationDto[]) => void,
): void {
  const queryClient = useQueryClient();
  const refresh = async () => {
    const key = keys.automations(baseId);
    const before = queryClient.getQueryData<AutomationList>(key)?.items ?? [];
    await queryClient.refetchQueries({ queryKey: key, exact: true });
    const after = queryClient.getQueryData<AutomationList>(key)?.items ?? [];
    const disabled = newlyDisabled(before, after);
    if (disabled.length > 0) onDisabled(disabled);
  };
  useRealtimeChannel(userId === null ? null : userChannel(userId as Id<'usr'>), {
    onMessage: (message) => {
      if (
        message.type === 'notification.created' &&
        message.notification_type === 'automation.disabled' &&
        message.base_id === baseId
      ) {
        void refresh();
      }
    },
    onReconnect: () => {
      void refresh();
    },
  });
}
