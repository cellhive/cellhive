import { DropdownMenuItem } from '@cellhive/ui';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';

import { showToast } from '../toast/toast';

import { setRecordFollow, useRecordFollow, type FollowOutcome } from './follow';

/** Texts of the item and its toasts, translated by the menu that shows it (grid, kanban). */
export interface FollowMenuMessages {
  readonly follow: string;
  readonly unfollow: string;
  /** Toast after a follow, e.g. "You follow “Printer jam”." */
  readonly followed: string;
  /** Toast after an unfollow. */
  readonly unfollowed: string;
  /** Button of those toasts that turns the change back. */
  readonly undo: string;
  /** The record was deleted or is no longer readable (`404`). */
  readonly gone: string;
}

/**
 * Follows or unfollows from a menu (T553): the menu closes at once, so a
 * toast says what changed, with "Undo"; `404` says the record is gone.
 * Errors already have their toast ({@link setRecordFollow}).
 */
export async function toggleFollowFromMenu(
  client: QueryClient,
  tableId: string,
  recordId: string,
  following: boolean,
  messages: FollowMenuMessages,
): Promise<FollowOutcome> {
  const outcome = await setRecordFollow(client, tableId, recordId, following);
  if (outcome === 'gone') {
    showToast({ message: messages.gone });
  } else if (outcome === 'done') {
    showToast({
      variant: 'success',
      message: following ? messages.followed : messages.unfollowed,
      actions: [
        {
          label: messages.undo,
          onClick: () => {
            void setRecordFollow(client, tableId, recordId, !following).then((undone) => {
              if (undone === 'gone') showToast({ message: messages.gone });
            });
          },
        },
      ],
    });
  }
  return outcome;
}

export interface FollowMenuItemProps {
  readonly tableId: string;
  readonly recordId: string;
  readonly messages: FollowMenuMessages;
}

/**
 * "Follow" / "Unfollow" of a record's menu (grid cell or tree row, kanban
 * card; T553, FRONTEND §10.1). The state is read when the menu opens (the
 * item waits, disabled, until it is known) and shared with the panel's
 * follow button.
 */
export function FollowMenuItem({ tableId, recordId, messages }: FollowMenuItemProps) {
  const client = useQueryClient();
  const follow = useRecordFollow(tableId, recordId);
  const following = follow.state?.following === true;
  return (
    <DropdownMenuItem
      data-testid="follow-menu-item"
      disabled={follow.loading || follow.gone}
      aria-busy={follow.loading}
      onSelect={() => {
        void toggleFollowFromMenu(client, tableId, recordId, !following, messages);
      }}
    >
      {following ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />}
      {following ? messages.unfollow : messages.follow}
    </DropdownMenuItem>
  );
}
