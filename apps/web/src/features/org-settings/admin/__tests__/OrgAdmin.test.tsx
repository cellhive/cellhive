import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { clearToasts } from '../../../../lib/toast/toast';

/** Organization administration: General, Members (+ invitations), Groups (T830). */

type Role = 'owner' | 'admin' | 'member';

const NOW = '2026-10-28T03:00:00.000Z';
const BINH = 'usr_Binh000000000001';
const CHI = 'usr_Chi0000000000001';
const DUNG = 'usr_Dung000000000001';
const SALES = 'grp_Sales00000000001';

function user(id: string, name: string) {
  return {
    id,
    email: `${name.toLowerCase()}@example.test`,
    display_name: name,
    avatar_url: null,
  };
}

function member(id: string, name: string, role: Role) {
  return { user: user(id, name), role, joined_at: NOW };
}

const page = <T,>(items: T[]) => ({ items, total: items.length, offset: 0, limit: 1000 });

function serve({
  role = 'owner',
  others,
}: { role?: Role; others?: ReturnType<typeof member>[] } = {}) {
  const calls: [string, unknown][] = [];
  const body = (init: RequestInit | undefined) =>
    typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
  let org = { ...ORG, role };
  let members = [
    { user: ME.user, role, joined_at: NOW },
    ...(others ?? [member(BINH, 'Binh', 'admin'), member(CHI, 'Chi', 'member')]),
  ];
  let invitations: Record<string, unknown>[] = [];
  let groups: Record<string, unknown>[] = [];
  const groupMembers = new Map<string, ReturnType<typeof member>['user'][]>();
  const memberPath = /^\/orgs\/[^/]+\/members\/(usr_[^/]+)(\/password-reset)?$/u;
  stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role }] }),
      [`GET /orgs/${ORG.id}`]: () => json(org),
      [`PATCH /orgs/${ORG.id}`]: (init) => {
        calls.push(['PATCH org', body(init)]);
        org = { ...org, ...(body(init) as object) };
        return json(org);
      },
      [`GET /orgs/${ORG.id}/members`]: () => json(page(members)),
      [`GET /orgs/${ORG.id}/invitations`]: () => json(page(invitations)),
      [`POST /orgs/${ORG.id}/invitations`]: (init) => {
        const input = body(init) as { email: string; role: string };
        calls.push(['invite', input]);
        const invitation = {
          id: 'inv_Invite0000000001',
          organization_id: ORG.id,
          email: input.email,
          role: input.role,
          workspace_id: null,
          inviter_id: ME.user.id,
          status: 'pending',
          expires_at: '2026-11-04T03:00:00.000Z',
          accepted_at: null,
          revoked_at: null,
          created_at: NOW,
        };
        invitations = [invitation];
        return json(
          {
            ...invitation,
            invite_url: 'http://localhost/invite/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
            email_sent: false,
          },
          201,
        );
      },
      [`DELETE /orgs/${ORG.id}/invitations/inv_Invite0000000001`]: () => {
        calls.push(['revoke', undefined]);
        invitations = [];
        return new Response(null, { status: 204 });
      },
      [`GET /orgs/${ORG.id}/groups`]: () => json(page(groups)),
      [`POST /orgs/${ORG.id}/groups`]: (init) => {
        const { name } = body(init) as { name: string };
        calls.push(['create group', name]);
        const group = {
          id: SALES,
          organization_id: ORG.id,
          name,
          member_count: 0,
          created_at: NOW,
          updated_at: NOW,
        };
        groups = [group];
        groupMembers.set(SALES, []);
        return json(group, 201);
      },
      [`GET /groups/${SALES}/members`]: () =>
        json(page((groupMembers.get(SALES) ?? []).map((item) => ({ user: item, added_at: NOW })))),
      [`POST /groups/${SALES}/members`]: (init) => {
        const { user_id: userId } = body(init) as { user_id: string };
        calls.push(['add to group', userId]);
        const added = members.find((item) => item.user.id === userId);
        if (added === undefined) return problem('NOT_FOUND', 404);
        groupMembers.set(SALES, [...(groupMembers.get(SALES) ?? []), added.user]);
        groups = groups.map((group) => ({ ...group, member_count: 1 }));
        return json({ user: added.user, added_at: NOW }, 201);
      },
    },
  });
  // Member routes carry the user ID: answered by a wrapper around the stub.
  const stubbed = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
    const match = memberPath.exec(path);
    if (match === null) return stubbed(input, init);
    const [, userId, reset] = match;
    const target = members.find((item) => item.user.id === userId);
    if (target === undefined) return Promise.resolve(problem('NOT_FOUND', 404));
    if (reset !== undefined) {
      calls.push(['reset', userId]);
      return Promise.resolve(
        userId === BINH
          ? problem('PERMISSION_DENIED', 403)
          : json(
              {
                reset_url: 'http://localhost/reset/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
                expires_at: '2026-10-29T03:00:00.000Z',
              },
              201,
            ),
      );
    }
    if (init?.method === 'PATCH') {
      calls.push(['role', { userId, ...(body(init) as object) }]);
      const updated = { ...target, role: (body(init) as { role: Role }).role };
      members = members.map((item) => (item.user.id === userId ? updated : item));
      return Promise.resolve(json(updated));
    }
    if (init?.method === 'DELETE') {
      calls.push(['remove', { userId, ...(body(init) as object) }]);
      members = members.filter((item) => item.user.id !== userId);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(json(target));
  });
  return { calls };
}

function row(userId: string): HTMLElement {
  const found = screen
    .getAllByTestId('org-member-row')
    .find((element) => element.dataset['userId'] === userId);
  if (found === undefined) throw new Error(`no row for ${userId}`);
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('organization settings (T830)', () => {
  it('groups the nav and saves the organization name (only when changed)', async () => {
    const { calls } = serve();
    await renderApp(`/o/${ORG.slug}/settings`);
    const nav = await screen.findByRole('navigation', { name: 'Organization settings' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'General',
      'Members',
      'Groups',
      'Email settings',
      'Sender identities',
      'Telegram bots',
      'Integrations',
      'Share links',
      'Audit log',
    ]);
    expect(within(nav).getByRole('link', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('list', { name: 'Members & groups' })).toBeInTheDocument();
    expect(within(nav).getByRole('list', { name: 'Data' })).toBeInTheDocument();

    const form = await screen.findByTestId('org-info-form');
    const save = within(form).getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    const name = within(form).getByLabelText('Organization name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Acme Corp');
    await userEvent.click(save);
    expect(await screen.findByText('Saved.')).toBeVisible();
    expect(calls).toEqual([['PATCH org', { name: 'Acme Corp' }]]);
    expect(screen.getByText(ORG.id)).toBeVisible();
    expect(screen.getByText(`/o/${ORG.slug}`)).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('changes a member role and removes a member, whose bases go to the caller', async () => {
    const { calls } = serve();
    await renderApp(`/o/${ORG.slug}/settings/members`);
    await screen.findByTestId('org-member-table');
    // The caller's own row is read-only.
    expect(within(row(ME.user.id)).queryByRole('combobox')).toBeNull();

    await userEvent.selectOptions(
      within(row(CHI)).getByRole('combobox', { name: 'Role of Chi' }),
      'admin',
    );
    expect(await screen.findByText('Changed the role of Chi to Admin.')).toBeVisible();

    await userEvent.click(within(row(BINH)).getByRole('button', { name: 'Actions for Binh' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Remove from organization' }),
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Binh from Acme?' });
    expect(within(dialog).getByLabelText('Bases they own go to')).toHaveValue(ME.user.id);
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove member' }));
    expect(await screen.findByText('Removed Binh from the organization.')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByText('binh@example.test')).toBeNull();
    });
    expect(calls).toEqual([
      ['role', { userId: CHI, role: 'admin' }],
      ['remove', { userId: BINH, transfer_bases_to: ME.user.id }],
    ]);
  });

  it('never offers what the API refuses: an admin cannot touch an owner', async () => {
    serve({
      role: 'admin',
      others: [member(DUNG, 'Dung', 'owner'), member(CHI, 'Chi', 'member')],
    });
    await renderApp(`/o/${ORG.slug}/settings/members`);
    await screen.findByTestId('org-member-table');
    expect(within(row(DUNG)).queryByRole('combobox')).toBeNull();
    expect(within(row(DUNG)).getByText('Only owner')).toBeVisible();
    expect(within(row(DUNG)).queryByRole('button', { name: 'Actions for Dung' })).toBeNull();
    const options = within(within(row(CHI)).getByRole('combobox')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Admin', 'Member']);
  });

  it('shows a password reset link once, and explains the CLI when the API refuses', async () => {
    const { calls } = serve();
    await renderApp(`/o/${ORG.slug}/settings/members`);
    await screen.findByTestId('org-member-table');

    await userEvent.click(within(row(BINH)).getByRole('button', { name: 'Actions for Binh' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Create password reset link' }),
    );
    let dialog = await screen.findByRole('dialog', { name: 'Password reset link for Binh' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));
    expect(
      await within(dialog).findByText(/Reset their password with the server CLI/u),
    ).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(within(row(CHI)).getByRole('button', { name: 'Actions for Chi' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Create password reset link' }),
    );
    dialog = await screen.findByRole('dialog', { name: 'Password reset link for Chi' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));
    expect(await within(dialog).findByTestId('reset-link')).toHaveValue(
      'http://localhost/reset/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    );
    expect(await axeViolations(document.body)).toEqual([]);
    expect(calls).toEqual([
      ['reset', BINH],
      ['reset', CHI],
    ]);
  });

  it('invites by email: the link is shown once, the invitation is listed and can be revoked', async () => {
    const { calls } = serve();
    await renderApp(`/o/${ORG.slug}/settings/members`);
    expect(await screen.findByTestId('invitations-empty')).toBeVisible();

    await userEvent.click(screen.getByTestId('invite-open'));
    const form = await screen.findByTestId('invite-form');
    await userEvent.type(within(form).getByLabelText('Email'), 'dao@example.test');
    await userEvent.selectOptions(within(form).getByLabelText('Role'), 'admin');
    await userEvent.click(within(form).getByRole('button', { name: 'Create invitation' }));

    const created = await screen.findByTestId('invite-created');
    expect(within(created).getByTestId('invite-link')).toHaveValue(
      'http://localhost/invite/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    );
    expect(
      within(created).getByText('This server sends no email: send the link yourself.'),
    ).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(created).getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('invite-link')).toBeNull();

    const invitations = screen.getByTestId('invitations');
    expect(await within(invitations).findByText('dao@example.test')).toBeVisible();
    await userEvent.click(
      within(invitations).getByRole('button', {
        name: 'Revoke the invitation of dao@example.test',
      }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Revoke the invitation of dao@example.test?',
    });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Invitation revoked.')).toBeVisible();
    expect(await screen.findByTestId('invitations-empty')).toBeVisible();
    expect(calls).toEqual([
      ['invite', { email: 'dao@example.test', role: 'admin' }],
      ['revoke', undefined],
    ]);
  });

  it('creates a group, then adds a member of the organization to it', async () => {
    const { calls } = serve();
    await renderApp(`/o/${ORG.slug}/settings/groups`);
    expect(await screen.findByTestId('groups-empty')).toBeVisible();

    await userEvent.click(screen.getByTestId('group-new'));
    const form = await screen.findByTestId('group-name-form');
    await userEvent.type(within(form).getByLabelText('Group name'), 'Sales');
    await userEvent.click(within(form).getByRole('button', { name: 'Create group' }));

    const dialog = await screen.findByRole('dialog', { name: 'Members of Sales' });
    expect(await within(dialog).findByText('No one in this group yet.')).toBeVisible();
    await userEvent.selectOptions(await within(dialog).findByLabelText('Add a person'), CHI);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText('chi@example.test')).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    const table = await screen.findByTestId('group-table');
    expect(await within(table).findByText('1 member')).toBeVisible();
    expect(calls).toEqual([
      ['create group', 'Sales'],
      ['add to group', CHI],
    ]);
  });

  it('gives a member who is not an owner/admin the 404 screen and no entry points', async () => {
    serve({ role: 'member' });
    await renderApp(`/o/${ORG.slug}/settings/members`);
    expect(await screen.findByText(/not found/iu)).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Organization settings' })).toBeNull();
    expect(screen.queryByTestId('org-member-table')).toBeNull();
    expect(screen.queryByTestId('sidebar-org-settings')).toBeNull();
  });

  it('links the organization home, sidebar and account menu to the settings', async () => {
    serve();
    const { router } = await renderApp(`/o/${ORG.slug}`);
    expect(await screen.findByTestId('org-settings-open')).toHaveAttribute(
      'href',
      `/o/${ORG.slug}/settings`,
    );
    expect(screen.getAllByTestId('sidebar-org-settings')[0]).toHaveAttribute(
      'href',
      `/o/${ORG.slug}/settings`,
    );
    const menu = (await screen.findAllByRole('button', { name: 'Account menu for An Nguyen' }))[0];
    if (menu === undefined) throw new Error('no account menu');
    await userEvent.click(menu);
    expect(await screen.findByRole('menuitem', { name: 'Organization settings' })).toBeVisible();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Notification settings' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/o/${ORG.slug}/settings/notifications`);
    });
  });
});
