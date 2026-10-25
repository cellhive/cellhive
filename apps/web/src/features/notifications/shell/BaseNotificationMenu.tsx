import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { MoreHorizontal } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

const MuteItem = lazy(() => import('./BaseMuteItem'));

/**
 * The "…" menu of a base in the sidebar tree (T524, board "S5 ·
 * Notification settings": "Mute from the base menu in the sidebar"). Its
 * item — mute / unmute notifications of the base — is a lazy chunk loaded
 * when the menu opens (it reads the caller's settings), so the shell only
 * carries the button.
 */
export function BaseNotificationMenu({
  orgId,
  base,
}: {
  readonly orgId: string;
  readonly base: { readonly id: string; readonly name: string };
}) {
  const { t } = useTranslation('common');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('nav.baseMenu', { name: base.name })}
        data-testid={`base-menu-${base.id}`}
        className={cn(
          'absolute top-1/2 right-0.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg',
          'focus-visible:outline-2 focus-visible:outline-accent',
          'max-lg:right-0 max-lg:size-control',
          'lg:opacity-0 lg:group-focus-within/base:opacity-100 lg:group-hover/base:opacity-100 lg:data-[state=open]:opacity-100',
        )}
      >
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <Suspense fallback={<DropdownMenuItem disabled>{t('loading')}</DropdownMenuItem>}>
          <MuteItem orgId={orgId} base={base} />
        </Suspense>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
