import { describe, expect, it } from 'vitest';

import { AUTOMATION_STEP_ERROR_CODES } from '../src/automation-runs.js';
import { ERROR_DETAIL_CODES, SECRET_DETAIL_CODES } from '../src/error-details.js';
import {
  createSecretRequestSchema,
  SECRET_HOST_NOT_ALLOWED,
  SECRET_HOSTS_REQUIRED,
  SECRET_MAX_ALLOWED_HOSTS,
  TOO_MANY_ALLOWED_HOSTS,
  updateSecretRequestSchema,
} from '../src/secrets.js';

import type { z } from 'zod';

/** `[path, detail code]` of each issue, as the API maps them (custom → `params.code`). */
function issuesOf(result: z.ZodSafeParseResult<unknown>): [string, string][] {
  return (result.error?.issues ?? []).map((issue) => [
    issue.path.map(String).join('.'),
    issue.code === 'custom' ? String(issue.params?.['code']) : issue.code,
  ]);
}

const header = { kind: 'http_header', name: 'CRM', value: 'Bearer x' } as const;

/** BACKLOG T701 (ADR-36 §4, CONTRACTS §24): `allowed_hosts` of HTTP secrets. */
describe('secret allowed_hosts (T701)', () => {
  it('requires 1–20 host patterns for http_header and webhook_signing when created', () => {
    expect(issuesOf(createSecretRequestSchema.safeParse(header))).toEqual([
      ['allowed_hosts', SECRET_HOSTS_REQUIRED],
    ]);
    expect(
      issuesOf(
        createSecretRequestSchema.safeParse({
          kind: 'webhook_signing',
          name: 'n8n',
          generate: true,
          allowed_hosts: [],
        }),
      ),
    ).toEqual([['allowed_hosts', SECRET_HOSTS_REQUIRED]]);
    const many = Array.from(
      { length: SECRET_MAX_ALLOWED_HOSTS + 1 },
      (_, i) => `h${String(i)}.test`,
    );
    expect(
      issuesOf(createSecretRequestSchema.safeParse({ ...header, allowed_hosts: many })),
    ).toEqual([['allowed_hosts', TOO_MANY_ALLOWED_HOSTS]]);
    expect(
      createSecretRequestSchema.safeParse({ ...header, allowed_hosts: many.slice(0, 20) }).success,
    ).toBe(true);
  });

  it('refuses entries that are not host patterns (IP, CIDR, *.com, scheme, path)', () => {
    const result = createSecretRequestSchema.safeParse({
      ...header,
      allowed_hosts: [
        'api.crm.test',
        '10.0.0.1',
        '10.0.0.0/8',
        '*.com',
        'https://a.test',
        'a.test/x',
      ],
    });
    expect(issuesOf(result)).toEqual([
      ['allowed_hosts.1', 'INVALID_ALLOWLIST_PATTERN'],
      ['allowed_hosts.2', 'INVALID_ALLOWLIST_PATTERN'],
      ['allowed_hosts.3', 'INVALID_ALLOWLIST_PATTERN'],
      ['allowed_hosts.4', 'INVALID_ALLOWLIST_PATTERN'],
      ['allowed_hosts.5', 'INVALID_ALLOWLIST_PATTERN'],
    ]);
  });

  it('accepts no allowed_hosts on a telegram_bot secret', () => {
    const bot = {
      kind: 'telegram_bot',
      name: 'Bot',
      value: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0',
    } as const;
    expect(createSecretRequestSchema.safeParse(bot).success).toBe(true);
    expect(
      issuesOf(createSecretRequestSchema.safeParse({ ...bot, allowed_hosts: ['a.test'] })),
    ).toEqual([['allowed_hosts', 'UNRECOGNIZED_KEY']]);
  });

  it('PATCH: allowed_hosts alone is a change, still 1–20 patterns', () => {
    expect(
      updateSecretRequestSchema.safeParse({ allowed_hosts: ['*.crm.test:8443'] }).success,
    ).toBe(true);
    expect(issuesOf(updateSecretRequestSchema.safeParse({ allowed_hosts: [] }))).toEqual([
      ['allowed_hosts', SECRET_HOSTS_REQUIRED],
    ]);
    expect(issuesOf(updateSecretRequestSchema.safeParse({ allowed_hosts: ['::1'] }))).toEqual([
      ['allowed_hosts.0', 'INVALID_ALLOWLIST_PATTERN'],
    ]);
  });

  it('lists the new detail and step codes', () => {
    for (const code of [SECRET_HOSTS_REQUIRED, TOO_MANY_ALLOWED_HOSTS, SECRET_HOST_NOT_ALLOWED]) {
      expect(SECRET_DETAIL_CODES).toContain(code);
      expect(ERROR_DETAIL_CODES).toContain(code);
    }
    expect(AUTOMATION_STEP_ERROR_CODES).toContain('secret_host_not_allowed');
  });
});
