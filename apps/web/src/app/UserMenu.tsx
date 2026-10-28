import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Bell, Code, KeyRound, LogOut, Settings, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Avatar } from '../grid/display/Avatar';
import { isOrgAdmin } from '../lib/permissions/org';
import { setupStatusQuery, signOut } from '../lib/session/session';

import { PreferenceMenuItems } from './preferences-controls';

import type { MeResponse } from '@cellhive/contracts';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/**
 * Account menu at the bottom of the sidebar (design "Grid - Tickets"): who
 * is signed in, connected accounts (T715, when the server has OIDC
 * providers), API tokens (T714), language, theme, sign out.
 */
export function UserMenu({ me, orgSlug }: { me: MeResponse; orgSlug?: string | undefined }) {
  const { t } = useTranslation('common');
  const setup = useQuery(setupStatusQuery());
  const hasProviders = (setup.data?.auth_config.providers ?? []).length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 px-2"
          aria-label={t('userMenu.label', { name: me.user.display_name })}
        >
          <Avatar colorKey={me.user.id} size="lg">
            {initials(me.user.display_name)}
          </Avatar>
          <span className="min-w-0 truncate">{me.user.display_name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-body font-medium text-fg">{me.user.display_name}</span>
          <span className="truncate font-normal">{me.user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account">
            <UserRound aria-hidden="true" />
            {t('userMenu.profile')}
          </Link>
        </DropdownMenuItem>
        {hasProviders ? (
          <DropdownMenuItem asChild>
            <Link to="/account/connections">
              <KeyRound aria-hidden="true" />
              {t('userMenu.connections')}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {/* T714: the caller's API tokens in the organization on screen. */}
        {orgSlug === undefined ? null : (
          <DropdownMenuItem asChild>
            <Link to={`/o/${encodeURIComponent(orgSlug)}/settings/api-tokens`}>
              <Code aria-hidden="true" />
              {t('userMenu.apiTokens')}
            </Link>
          </DropdownMenuItem>
        )}
        {/* T830: the caller's notification settings in that organization, its settings for owners/admins. */}
        {orgSlug === undefined ? null : (
          <DropdownMenuItem asChild>
            <Link to={`/o/${encodeURIComponent(orgSlug)}/settings/notifications`}>
              <Bell aria-hidden="true" />
              {t('userMenu.notifications')}
            </Link>
          </DropdownMenuItem>
        )}
        {orgSlug !== undefined && isOrgAdmin(me.orgs.find((org) => org.slug === orgSlug)?.role) ? (
          <DropdownMenuItem asChild>
            <Link to={`/o/${encodeURIComponent(orgSlug)}/settings`}>
              <Settings aria-hidden="true" />
              {t('nav.orgSettings')}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <PreferenceMenuItems />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void signOut();
          }}
        >
          <LogOut aria-hidden="true" />
          {t('actions.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
