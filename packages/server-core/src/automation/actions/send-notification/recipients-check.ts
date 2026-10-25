import {
  NOTIFICATION_GROUP_NOT_FOUND,
  NOTIFICATION_USER_NOT_FOUND,
  type AutomationAction,
  type AutomationBranchAction,
  type AutomationDefinition,
  type Id,
  type ProblemErrorItem,
} from '@cellhive/contracts';

import { GroupsRepository } from '../../../db/repositories/groups.repository.js';
import { flattenActions } from '../../definition/validate.js';
import { RecipientMembersRepository } from '../send-email/recipient-members.repository.js';

import type { Db } from '../../../db/create-db.js';
import type { OrgScope } from '../../../db/repository.js';

type AnyAction = AutomationAction | AutomationBranchAction;

/** The `send_notification` steps of a definition with their path. */
export function sendNotificationSteps(
  definition: AutomationDefinition,
): { action: Extract<AnyAction, { type: 'send_notification' }>; path: string }[] {
  return flattenActions(definition.actions).flatMap(({ action, path }) =>
    action.type === 'send_notification' ? [{ action, path }] : [],
  );
}

/**
 * Save-time checks of `send_notification` that need the database (BACKLOG
 * T515) — the rest is `validateAutomationDefinition`: fixed recipients must
 * be active members of the organization (`USER_NOT_FOUND`) and groups must
 * exist in it (`GROUP_NOT_FOUND`); a user or group of another organization
 * answers the same. Paths under `definition.`.
 */
export async function checkSendNotificationRecipients(
  db: Db,
  scope: OrgScope,
  definition: AutomationDefinition,
): Promise<ProblemErrorItem[]> {
  const steps = sendNotificationSteps(definition);
  if (steps.length === 0) return [];
  const userIds = new Set<Id<'usr'>>();
  const groupIds = new Set<Id<'grp'>>();
  for (const { action } of steps) {
    for (const value of action.config.recipients) {
      if ('user_ids' in value) for (const id of value.user_ids) userIds.add(id);
      if ('group_id' in value) groupIds.add(value.group_id);
    }
  }
  const [members, groups] = await Promise.all([
    new RecipientMembersRepository(db).activeMembers(scope, [...userIds]),
    new GroupsRepository(db).listByIds(scope, [...groupIds]),
  ]);
  const knownGroups = new Set<string>(groups.map((group) => group.id));
  const errors: ProblemErrorItem[] = [];
  for (const { action, path } of steps) {
    action.config.recipients.forEach((value, index) => {
      const at = `${path}.config.recipients[${String(index)}]`;
      if ('user_ids' in value) {
        value.user_ids.forEach((id, item) => {
          if (members.has(id)) return;
          errors.push({
            path: `${at}.user_ids[${String(item)}]`,
            code: NOTIFICATION_USER_NOT_FOUND,
            message: 'Not an active member of the organization',
          });
        });
      }
      if ('group_id' in value && !knownGroups.has(value.group_id)) {
        errors.push({
          path: `${at}.group_id`,
          code: NOTIFICATION_GROUP_NOT_FOUND,
          message: 'Unknown group',
        });
      }
    });
  }
  return errors;
}
