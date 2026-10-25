import { describe, expect, it } from 'vitest';

import { updateApiTokenPolicySchema } from '../src/api-tokens.js';
import { runN8nWorkflowConfigSchema } from '../src/automation-actions/run-n8n-workflow.js';
import { automationRunListQuerySchema } from '../src/automation-runs.js';
import { formSubmitRequestSchema, MAX_FORM_SUBMISSION_FIELDS } from '../src/forms.js';
import { updateBaseRequestSchema, updateOrganizationRequestSchema } from '../src/orgs.js';
import { recordChildrenQuerySchema } from '../src/record-tree.js';
import {
  assignRoleRequestSchema,
  removeRoleAssignmentRequestSchema,
  updateRoleRequestSchema,
} from '../src/roles.js';
import { updateShareLinkRequestSchema } from '../src/share-links.js';
import { updateFieldRequestSchema, updateTableRequestSchema } from '../src/tables.js';
import {
  MAX_LINK_COLUMN_ENTRIES,
  recordDetailSettingsSchema,
  updateViewRequestSchema,
} from '../src/views.js';

import type { z } from 'zod';

const USR = 'usr_A1b2C3d4E5f6G7h8';
const GRP = 'grp_A1b2C3d4E5f6G7h8';
const ROL = 'rol_A1b2C3d4E5f6G7h8';
const fld = (n: number): string => `fld_A1b2C3d4E5f6${String(n).padStart(4, '0')}`;

/** PATCH bodies: an empty object is refused, any one key is enough (CONTRACTS §1). */
describe('update requests need at least one property', () => {
  const cases: [string, z.ZodType, unknown][] = [
    ['api token policy', updateApiTokenPolicySchema, { enabled: false }],
    ['organization', updateOrganizationRequestSchema, { name: 'Acme' }],
    ['organization settings', updateOrganizationRequestSchema, { settings: { locale: 'vi' } }],
    ['base', updateBaseRequestSchema, { name: 'CRM' }],
    ['table', updateTableRequestSchema, { name: 'Leads' }],
    ['field', updateFieldRequestSchema, { required: true }],
    ['share link', updateShareLinkRequestSchema, { enabled: false }],
    ['view', updateViewRequestSchema, { name: 'Open deals' }],
    ['role', updateRoleRequestSchema, { name: 'Sales' }],
  ];

  it.each(cases)('%s: one key is accepted', (_, schema, body) => {
    expect(schema.safeParse(body).success).toBe(true);
  });

  it.each(cases)('%s: no key is refused', (_, schema) => {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'At least one property is required',
    );
  });

  it.each([
    ['organization settings', updateOrganizationRequestSchema, { settings: {} }],
    ['base settings', updateBaseRequestSchema, { settings: {} }],
    ['api token policy', updateApiTokenPolicySchema, { enabled: undefined }],
  ] as [string, z.ZodType, unknown][])('%s: only undefined keys are refused', (_, schema, body) => {
    expect(schema.safeParse(body).success).toBe(false);
  });
});

describe('role assignments: principal_id matches principal_type', () => {
  it.each([
    ['user', USR, true],
    ['group', GRP, true],
    ['user', GRP, false],
    ['group', USR, false],
  ])('%s %s → %s', (principal_type, principal_id, expected) => {
    expect(
      assignRoleRequestSchema.safeParse({ principal_type, principal_id, role_id: ROL }).success,
    ).toBe(expected);
    expect(
      removeRoleAssignmentRequestSchema.safeParse({ principal_type, principal_id }).success,
    ).toBe(expected);
  });
});

describe('list query parameters', () => {
  it.each([
    [{}, undefined],
    [{ fields: 'Name' }, ['Name']],
    [{ fields: ['Name', 'Owner'] }, ['Name', 'Owner']],
  ])('children fields %j → %j', (query, expected) => {
    expect(recordChildrenQuerySchema.parse(query).fields).toEqual(expected);
  });

  it.each([
    ['failed', ['failed']],
    ['failed,cancelled', ['failed', 'cancelled']],
    ['failed,failed', ['failed']],
  ])('run status %s → %j', (status, expected) => {
    expect(automationRunListQuerySchema.parse({ status }).status).toEqual(expected);
  });

  it('refuses an unknown run status', () => {
    expect(automationRunListQuerySchema.safeParse({ status: 'failed,bogus' }).success).toBe(false);
  });
});

describe('collection size limits', () => {
  const fields = (count: number): Record<string, unknown> =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [fld(i), 'x']));

  it.each([
    [MAX_FORM_SUBMISSION_FIELDS, true],
    [MAX_FORM_SUBMISSION_FIELDS + 1, false],
  ])('form submission with %i fields → %s', (count, expected) => {
    expect(formSubmitRequestSchema.safeParse({ fields: fields(count) }).success).toBe(expected);
  });

  it.each([
    [[fld(1), fld(2)], true],
    [[fld(1), fld(1)], false],
  ])('run_n8n_workflow fields %j → %s', (ids, expected) => {
    const config = {
      url: { literal: 'https://n8n.example.com/webhook/x' },
      signing_secret_id: 'sec_A1b2C3d4E5f6G7h8',
      fields: ids,
    };
    expect(runN8nWorkflowConfigSchema.safeParse(config).success).toBe(expected);
  });

  it('record detail settings: link columns of at most MAX_LINK_COLUMN_ENTRIES link fields', () => {
    expect(
      recordDetailSettingsSchema.safeParse({ link_columns: { [fld(1)]: [fld(2)] } }).success,
    ).toBe(true);
    const many = Object.fromEntries(
      Array.from({ length: MAX_LINK_COLUMN_ENTRIES + 1 }, (_, i) => [fld(i), []]),
    );
    expect(recordDetailSettingsSchema.safeParse({ link_columns: many }).success).toBe(false);
  });
});
