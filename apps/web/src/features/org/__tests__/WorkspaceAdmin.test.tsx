import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { clearToasts } from '../../../lib/toast/toast';

/** The workspace page: rename, delete, bases in the trash (T832, T833). */

const WSP = 'wsp_Workspace0000001';
const NOW = '2026-10-28T03:00:00.000Z';

function baseOf(id: string, name: string, deletedAt: string | null) {
  return {
    id,
    organization_id: ORG.id,
    workspace_id: WSP,
    owner_id: ME.user.id,
    name,
    icon: null,
    description: null,
    permission_version: 1,
    settings: { strict_computed_permissions: false },
    created_at: NOW,
    updated_at: NOW,
    deleted_at: deletedAt,
  };
}

function serve({ orgRole = 'owner' }: { orgRole?: 'owner' | 'member' } = {}) {
  let workspace = {
    id: WSP,
    organization_id: ORG.id,
    name: 'Sales',
    slug: 'sales',
    role: null,
    created_at: NOW,
    updated_at: NOW,
  };
  const live = [baseOf('bse_Live000000000001', 'Pipeline', null)];
  const trash = [baseOf('bse_Trash00000000001', 'Old leads', NOW)];
  const calls: string[] = [];
  const list = (items: unknown[]) => json({ items, total: items.length, offset: 0, limit: 1000 });
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role: orgRole }] }),
      [`GET /orgs/${ORG.id}/workspaces`]: () => list([workspace]),
      [`GET /orgs/${ORG.id}/workspaces/${WSP}`]: () => json(workspace),
      [`GET /workspaces/${WSP}/bases`]: () => list(live),
      [`PATCH /orgs/${ORG.id}/workspaces/${WSP}`]: (init) => {
        calls.push(`PATCH ${init?.body as string}`);
        workspace = { ...workspace, ...(JSON.parse(init?.body as string) as object) };
        return json(workspace);
      },
      [`DELETE /orgs/${ORG.id}/workspaces/${WSP}`]: () => {
        calls.push('DELETE');
        return problem('VALIDATION_FAILED', 422);
      },
      'POST /bases/bse_Trash00000000001/restore': () => {
        calls.push('RESTORE');
        const restored = trash.splice(0, 1)[0];
        if (restored !== undefined) live.push({ ...restored, deleted_at: null });
        return json({
          ...restored,
          deleted_at: null,
          access: {
            role: null,
            is_admin: true,
            base_rule: { copy: true, download: true, share_link: true },
            tables: {},
            dashboards: {},
          },
        });
      },
    },
  });
  // The stub routes by path only: `include_deleted` is the trash list.
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
    input.includes('include_deleted=true')
      ? Promise.resolve(list([...live, ...trash]))
      : fetchMock(input, init),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('workspace page', () => {
  it('renames the workspace from its menu', async () => {
    const { calls } = serve();
    await renderApp(`/o/${ORG.slug}/w/${WSP}`);
    await userEvent.click(await screen.findByTestId('workspace-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByTestId('rename-workspace-dialog');
    const name = within(dialog).getByLabelText('Workspace name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Sales VN');
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sales VN' })).toBeVisible();
    expect(calls).toEqual(['PATCH {"name":"Sales VN"}']);
  });

  it('explains why a workspace with bases cannot be deleted', async () => {
    const { calls } = serve();
    await renderApp(`/o/${ORG.slug}/w/${WSP}`);
    await userEvent.click(await screen.findByTestId('workspace-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete workspace' }));
    const dialog = await screen.findByTestId('delete-workspace-dialog');
    await userEvent.click(within(dialog).getByTestId('delete-workspace-confirm'));
    expect(await within(dialog).findByRole('alert')).toBeVisible();
    expect(calls).toEqual(['DELETE']);
  });

  it('lists the bases in the trash and restores one', async () => {
    const { calls } = serve();
    await renderApp(`/o/${ORG.slug}/w/${WSP}`);
    const row = await screen.findByTestId('deleted-base-bse_Trash00000000001');
    expect(row).toHaveTextContent('Old leads');
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(row).getByRole('button', { name: 'Restore Old leads' }));
    expect(await screen.findByText('Restored Old leads.')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByTestId('deleted-base-bse_Trash00000000001')).toBeNull();
    });
    expect(calls).toEqual(['RESTORE']);
  });

  it('shows no menu to a member without a workspace role', async () => {
    serve({ orgRole: 'member' });
    await renderApp(`/o/${ORG.slug}/w/${WSP}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sales' })).toBeVisible();
    expect(screen.queryByTestId('workspace-menu')).toBeNull();
  });
});
