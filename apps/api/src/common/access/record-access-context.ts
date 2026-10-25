import { firstTimeZone, settingOf } from './time-zone.js';

import type { BaseAccess } from './access.service.js';
import type { ResolvedBaseAccess } from '@cellhive/permissions';
import type {
  AppConfig,
  GroupMembersRepository,
  RecordAccessContext,
  User,
} from '@cellhive/server-core';

const isLocale = (locale: unknown): locale is string => typeof locale === 'string' && locale !== '';

/**
 * Record access context of `user` on a base, with `resolved` as the
 * effective access (default: the user's own). Share links act with the
 * access of the link, the variables (`current_user`, groups, zone) of the
 * link's creator (SPEC §15A.2).
 */
export async function recordAccessContextOf(
  deps: { readonly groupMembers: GroupMembersRepository; readonly config: AppConfig },
  user: Pick<User, 'id' | 'locale' | 'timezone'>,
  base: BaseAccess,
  resolved: ResolvedBaseAccess = base.resolved,
): Promise<RecordAccessContext> {
  const settings = base.org.membership.settings;
  const baseLocales = [settingOf(base.base.settings, 'locale'), settingOf(settings, 'locale')];
  const zones = [user.timezone, settingOf(settings, 'timezone')];
  return {
    baseId: base.base.id,
    resolved,
    userId: user.id,
    groupMemberUserIds: await deps.groupMembers.userIdsOfGroups(base.org.scope, base.groupIds),
    timeZone: firstTimeZone(zones, deps.config.defaults.timezone),
    locale:
      [user.locale, settingOf(settings, 'locale')].find(isLocale) ?? deps.config.defaults.locale,
    typecastLocale: baseLocales.find(isLocale) ?? deps.config.defaults.locale,
  };
}
