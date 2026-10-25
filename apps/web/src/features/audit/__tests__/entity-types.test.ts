import { describe, expect, it } from 'vitest';

import en from '../../../locales/en/audit.json';
import vi from '../../../locales/vi/audit.json';

/**
 * Every `entity_type` the API writes to the audit log (T720: `role_assignment`,
 * `session`, … showed as raw keys in the viewer). Keep in step with the
 * `entityType:` values of `apps/api/src` and `apps/worker/src`.
 */
const WRITTEN = [
  'record',
  'table',
  'field',
  'view',
  'form',
  'attachment',
  'base',
  'workspace',
  'workspace_member',
  'org',
  'org_member',
  'invitation',
  'user',
  'session',
  'group',
  'group_member',
  'role',
  'role_assignment',
  'share_link',
  'api_token',
  'automation',
  'automation_run',
  'incoming_webhook',
  'http_allowlist',
  'secret',
  'email_identity',
  'job',
] as const;

describe('audit entity type labels', () => {
  it.each([
    ['en', en.entityTypes],
    ['vi', vi.entityTypes],
  ] as const)('%s names every entity type the API writes', (_language, labels) => {
    const missing = WRITTEN.filter(
      (type) => typeof (labels as Record<string, unknown>)[type] !== 'string',
    );
    expect(missing).toEqual([]);
  });
});
