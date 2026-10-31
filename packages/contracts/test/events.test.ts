import { describe, expect, it } from 'vitest';

import {
  ACTOR_TYPES,
  actorTypeSchema,
  AUDIT_ACTIONS,
  AUDIT_ONLY_ACTIONS,
  auditActionSchema,
  EVENT_TYPES,
  eventTypeSchema,
  isAuditAction,
  isEventType,
} from '../src/events.js';

describe('event catalogue', () => {
  it.each([
    'record.created',
    'record.updated',
    'field.converted',
    'table.purged',
    'org_member.role_changed',
    'workspace_member.role_changed',
    'role_assignment.changed',
    'permission.changed',
    'automation.run.succeeded',
    'automation.run.failed',
    'automation.run_as_changed',
    'incoming_webhook.deleted',
    'dashboard.deleted',
    'email_identity.created',
    'email_identity.verification_sent',
    'email_identity.verified',
    'email_identity.updated',
    'email_identity.credentials_changed',
    'email_identity.error',
    'email_identity.disabled',
    'email_identity.enabled',
    'email_identity.deleted',
  ])('%s is an event and an audit action', (name) => {
    expect(isEventType(name)).toBe(true);
    expect(eventTypeSchema.safeParse(name).success).toBe(true);
    expect(isAuditAction(name)).toBe(true);
  });

  it.each([
    'auth.login_failed',
    'auth.password_reset_requested',
    'schema.compacted',
    'setup.completed',
    'base.exported',
    'share_link.unlock_failed',
    'share_link.file_downloaded',
    'audit.redacted',
    'secret.created',
    'secret.deleted',
    'http_allowlist.created',
    'http_allowlist.deleted',
    'incoming_webhook.secret_rotated',
    'incoming_webhook.token_regenerated',
    'ai_settings.updated',
    'automation.run.rerun',
    'automation.run.cancelled',
    'user_channel.linked',
    'user_channel.unlinked',
    'auth.identity_linked',
    'auth.identity_unlinked',
    'auth.password_changed',
    'user.updated',
  ])('%s is audit-only', (name) => {
    expect(isEventType(name)).toBe(false);
    expect(isAuditAction(name)).toBe(true);
    expect(auditActionSchema.safeParse(name).success).toBe(true);
  });

  it.each(['record.added', 'record.removed_from_view', 'schema.changed', 'Record.Created', '', 1])(
    'rejects %j',
    (name) => {
      expect(isEventType(name)).toBe(false);
      expect(isAuditAction(name)).toBe(false);
    },
  );

  it('has the expected size and no duplicates', () => {
    expect(EVENT_TYPES).toHaveLength(83);
    expect(AUDIT_ONLY_ACTIONS).toHaveLength(39);
    expect(new Set(AUDIT_ACTIONS).size).toBe(EVENT_TYPES.length + AUDIT_ONLY_ACTIONS.length);
  });

  it('uses lower-case dotted names with snake_case segments', () => {
    for (const name of AUDIT_ACTIONS)
      expect(name).toMatch(/^[a-z]+(?:_[a-z]+)*(?:\.[a-z]+(?:_[a-z]+)*)+$/);
  });
});

describe('actor types', () => {
  it('matches CONTRACTS §8', () => {
    expect(ACTOR_TYPES).toEqual([
      'user',
      'api_token',
      'automation',
      'share_link',
      'system',
      'webhook',
    ]);
    expect(actorTypeSchema.safeParse('bot').success).toBe(false);
  });
});
