import { describe, expect, it } from 'vitest';

import { canCreateBase, canCreateWorkspace } from '../org';

describe('UX permission hints (SPEC §14.1)', () => {
  it.each([
    ['owner', true],
    ['admin', true],
    ['member', false],
    [undefined, false],
  ] as const)('org %s can create workspaces: %s', (role, expected) => {
    expect(canCreateWorkspace(role)).toBe(expected);
  });

  it.each([
    ['owner', null, true],
    ['admin', 'member', true],
    ['member', 'admin', true],
    ['member', 'member', false],
    ['member', null, false],
  ] as const)('org %s + workspace %s can create bases: %s', (orgRole, workspaceRole, expected) => {
    expect(canCreateBase(orgRole, workspaceRole)).toBe(expected);
  });
});
