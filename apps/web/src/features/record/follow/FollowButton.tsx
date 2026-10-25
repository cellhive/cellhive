import { Button, cn, Tooltip } from '@cellhive/ui';
import { Bell, BellRing } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { useRecordFollow } from '../../../lib/records/follow';

export interface FollowButtonProps {
  readonly tableId: string;
  readonly recordId: string;
  /**
   * The record was deleted or is no longer readable (`404` on a toggle):
   * the panel says so and closes, as when loading it fails.
   */
  readonly onGone: () => void;
}

/**
 * "Follow" / "Following" of the record panel header (T553, FRONTEND §10.1;
 * CONTRACTS §22.5): a toggle button (`aria-pressed`) with a bell, the
 * reason of the follow in its tooltip and description ("You created this
 * record", "You were assigned to it", followed by hand). Toggled
 * optimistically; a failure puts it back with an error toast
 * (`TOO_MANY_FOLLOWS` translated by its code). Below 640 px only the bell
 * shows (44 px), the label stays its accessible name. Both labels take the
 * same room, so the header does not move when it toggles.
 */
export function FollowButton({ tableId, recordId, onGone }: FollowButtonProps) {
  const { t } = useTranslation('record');
  const descriptionId = useId();
  const follow = useRecordFollow(tableId, recordId);
  const following = follow.state?.following === true;
  const source = following ? (follow.state.source ?? 'manual') : null;
  const hint = source === null ? t('follow.hint.none') : t(`follow.hint.${source}`);
  const label = following ? t('follow.following') : t('follow.follow');
  const other = following ? t('follow.follow') : t('follow.following');
  return (
    <>
      <Tooltip content={hint}>
        <Button
          variant="secondary"
          size="toolbar"
          data-testid="record-follow"
          data-state={follow.loading ? 'loading' : following ? 'on' : 'off'}
          aria-pressed={following}
          aria-describedby={descriptionId}
          className={cn(
            'px-2.5',
            following && 'border-accent bg-accent-soft text-accent hover:bg-accent-soft',
          )}
          onClick={() => {
            void follow.set(!following).then((outcome) => {
              if (outcome === 'gone') onGone();
            });
          }}
        >
          {following ? <BellRing aria-hidden="true" /> : <Bell aria-hidden="true" />}
          {/* Both labels in one grid cell: the wider one sets the width (no shift on toggle). */}
          <span className="grid max-sm:sr-only">
            <span className="col-start-1 row-start-1">{label}</span>
            <span aria-hidden="true" className="invisible col-start-1 row-start-1">
              {other}
            </span>
          </span>
        </Button>
      </Tooltip>
      <span id={descriptionId} className="sr-only">
        {hint}
      </span>
    </>
  );
}
