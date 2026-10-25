import { z } from 'zod';

import { idOf } from '../../ids.js';
import {
  markNotificationsReadResultSchema,
  markNotificationsReadSchema,
  notificationListQuerySchema,
  notificationListSchema,
  notificationPreferencesSchema,
  notificationSettingsSchema,
  notificationUnreadCountSchema,
  updateNotificationPreferencesSchema,
  updateNotificationSettingsSchema,
} from '../../notifications.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });
const muteParams = z.object({ orgId: idOf('org'), baseId: idOf('bse') });

const OWN =
  "The caller's own notifications in the organization (any member; a non-member gets `404`).";

/** In-app notifications, preferences, base mutes, email frequency (CONTRACTS §22; T511). */
export const registerNotificationRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/me/notifications',
    operationId: 'listMyNotifications',
    tag: 'notifications',
    summary: 'List my in-app notifications, newest first',
    description:
      `${OWN} Cursor pagination. Titles of records and automations are rendered now with the ` +
      "caller's current access: `entity.title = null` (and `base = null` for a base the caller " +
      'cannot open any more) means the item stays listed without a link.',
    params: orgParams,
    query: notificationListQuerySchema,
    status: 200,
    response: notificationListSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/me/notifications/unread-count',
    operationId: 'countMyUnreadNotifications',
    tag: 'notifications',
    summary: 'Count my unread in-app notifications (capped at 1000)',
    description: OWN,
    params: orgParams,
    status: 200,
    response: notificationUnreadCountSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/me/notifications/read',
    operationId: 'markMyNotificationsRead',
    tag: 'notifications',
    summary: 'Mark notifications as read (by id, or all)',
    description:
      `${OWN} Ids that are not the caller's, unknown or already read are ignored (counted out ` +
      'of `updated`).',
    params: orgParams,
    body: markNotificationsReadSchema,
    status: 200,
    response: markNotificationsReadResultSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/me/notification-preferences',
    operationId: 'getMyNotificationPreferences',
    tag: 'notifications',
    summary: 'My channel preferences per notification type',
    description:
      `${OWN} Every produced type × channel, with the type default when unset (the Telegram ` +
      'default is the email default of the type). The `telegram` channel is listed only while ' +
      'the organization has a notification bot (T550).',
    params: orgParams,
    status: 200,
    response: notificationPreferencesSchema,
  });
  add({
    method: 'put',
    path: '/api/v1/orgs/{orgId}/me/notification-preferences',
    operationId: 'updateMyNotificationPreferences',
    tag: 'notifications',
    summary: 'Change channel preferences (only the items given)',
    description:
      `${OWN} Turning off the in-app channel of a mandatory type (\`automation.disabled\`, ` +
      '`approval.task_assigned`) is `422 VALIDATION_FAILED` with `errors[].code = NOT_ALLOWED`. ' +
      'A `telegram` preference is stored even while the organization has no notification bot ' +
      '(the response then leaves the channel out).',
    params: orgParams,
    body: updateNotificationPreferencesSchema,
    status: 200,
    response: notificationPreferencesSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/me/notification-settings',
    operationId: 'getMyNotificationSettings',
    tag: 'notifications',
    summary: 'My email frequency, daily digest hour, muted bases and auto-follow switches',
    description: OWN,
    params: orgParams,
    status: 200,
    response: notificationSettingsSchema,
  });
  add({
    method: 'put',
    path: '/api/v1/orgs/{orgId}/me/notification-settings',
    operationId: 'updateMyNotificationSettings',
    tag: 'notifications',
    summary: 'Change my email frequency, daily digest hour or auto-follow switches',
    description: OWN,
    params: orgParams,
    body: updateNotificationSettingsSchema,
    status: 200,
    response: notificationSettingsSchema,
  });
  add({
    method: 'put',
    path: '/api/v1/orgs/{orgId}/me/notification-mutes/bases/{baseId}',
    operationId: 'muteBaseNotifications',
    tag: 'notifications',
    summary: 'Mute a base: no email for its notifications (in-app still recorded)',
    description:
      'Needs read access to the base (`404` otherwise). Mandatory types are never muted. ' +
      'Idempotent.',
    params: muteParams,
    status: 204,
  });
  add({
    method: 'delete',
    path: '/api/v1/orgs/{orgId}/me/notification-mutes/bases/{baseId}',
    operationId: 'unmuteBaseNotifications',
    tag: 'notifications',
    summary: 'Unmute a base',
    description: `${OWN} Idempotent; works for a base the caller cannot open any more.`,
    params: muteParams,
    status: 204,
  });
};
