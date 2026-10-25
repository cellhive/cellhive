import { cn } from '@cellhive/ui';
import { Cog, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Avatar } from '../../../grid/display/Avatar';
import { initialsOf } from '../../../grid/display/text';
import { useFormatters } from '../../../lib/i18n/format';
import { DAYS_LEFT_WARNING, daysLeft } from '../restore';

/** Shared look of the trash tables (records and fields). */
export const TABLE_CLASS = 'w-full min-w-[40rem] border-collapse text-left';
export const TH_CLASS = 'border-b border-line px-3 py-2 text-label font-medium text-fg-muted';
export const TD_CLASS = 'border-b border-line px-3 py-2 align-middle';

/** When a deletion happened: relative, with the absolute date and time in the user's time zone. */
export function DeletedAt({ value, now }: { value: string; now: Date }) {
  const format = useFormatters();
  const absolute = format.dateTime(value);
  return (
    <span className="flex flex-col">
      <time dateTime={value} title={absolute}>
        {format.relative(value, now)}
      </time>
      <span className="text-label font-normal text-fg-muted">{absolute}</span>
    </span>
  );
}

/** Days until the deletion is purged; a warning (icon + color) when little time is left. */
export function DaysLeft({ deletedAt, now }: { deletedAt: string; now: Date }) {
  const { t } = useTranslation('trash');
  const left = daysLeft(deletedAt, now);
  const urgent = left <= DAYS_LEFT_WARNING;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap',
        urgent ? 'font-medium text-warning' : 'text-fg-muted',
      )}
    >
      {urgent ? <TriangleAlert aria-hidden="true" className="size-4 shrink-0" /> : null}
      {t('daysLeft', { count: left })}
    </span>
  );
}

/** Who deleted a record: avatar and name, "System" when the deletion was automatic. */
export function DeletedBy({ user }: { user: { id: string; name: string | null } | null }) {
  const { t } = useTranslation('trash');
  if (user === null) {
    return (
      <span className="flex items-center gap-2 text-fg-muted">
        <Avatar colorKey={null} size="md">
          <Cog className="size-3.5" />
        </Avatar>
        {t('system')}
      </span>
    );
  }
  const name = user.name ?? t('unknownUser');
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar colorKey={user.id} size="md">
        {initialsOf(name)}
      </Avatar>
      <span className="truncate">{name}</span>
    </span>
  );
}
