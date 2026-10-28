import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { clearToasts } from '../../../lib/toast/toast';

/** "General" of the base settings: name, description, ID, delete (FRONTEND §17). */

const BASE = 'bse_General000000001';
const NOW = '2026-10-26T03:00:00.000Z';

function serve({
  orgRole = 'owner',
  description = 'Tickets of the support team',
}: { orgRole?: 'owner' | 'member'; description?: string | null } = {}) {
  let base = {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_General000000001',
    owner_id: 'usr_Owner00000000001',
    name: 'Support',
    icon: null,
    description,
    permission_version: 1,
    settings: { strict_computed_permissions: false },
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    access: {
      role: null,
      is_admin: true,
      base_rule: { copy: true, download: true, share_link: true },
      tables: {},
      dashboards: {},
    },
  };
  const calls: [string, unknown][] = [];
  const body = (init: RequestInit | undefined) =>
    typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
  stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role: orgRole }] }),
      [`GET /bases/${BASE}`]: () => json(base),
      [`GET /bases/${BASE}/tables`]: () => json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /bases/${BASE}/tables/trash`]: () => json({ items: [] }),
      [`GET /bases/${BASE}/dashboards`]: () => json({ items: [] }),
      [`PATCH /bases/${BASE}`]: (init) => {
        calls.push(['PATCH', body(init)]);
        base = { ...base, ...(body(init) as object) };
        return json(base);
      },
      [`DELETE /bases/${BASE}`]: () => {
        calls.push(['DELETE', undefined]);
        return new Response(null, { status: 204 });
      },
      [`POST /bases/${BASE}/restore`]: () => {
        calls.push(['RESTORE', undefined]);
        return json(base);
      },
    },
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('base settings › General', () => {
  it('saves only what changed; an emptied description becomes null', async () => {
    const { calls } = serve();
    await renderApp(`/b/${BASE}/settings`);
    const form = await screen.findByTestId('base-info-form');
    const save = within(form).getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await userEvent.clear(within(form).getByLabelText('Description'));
    await userEvent.click(save);
    expect(await screen.findByText('Saved.')).toBeVisible();

    const name = within(screen.getByTestId('base-info-form')).getByLabelText('Base name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Support desk');
    await userEvent.click(
      within(screen.getByTestId('base-info-form')).getByRole('button', { name: 'Save changes' }),
    );
    await waitFor(() => {
      expect(calls).toEqual([
        ['PATCH', { description: null }],
        ['PATCH', { name: 'Support desk' }],
      ]);
    });
    expect(await screen.findByText(BASE)).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('picks a tile for the base: glyph and color, saved as icon', async () => {
    const { calls } = serve();
    await renderApp(`/b/${BASE}/settings`);
    const picker = await screen.findByTestId('base-icon-picker');
    await userEvent.click(within(picker).getByRole('radio', { name: 'Support' }));
    await userEvent.click(within(picker).getByRole('radio', { name: 'Teal' }));
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(
      within(screen.getByTestId('base-info-form')).getByRole('button', { name: 'Save changes' }),
    );
    await waitFor(() => {
      expect(calls).toEqual([['PATCH', { icon: 'support:5' }]]);
    });
    // Saved: the form starts again from the stored value, nothing left to save.
    await waitFor(() => {
      expect(
        within(screen.getByTestId('base-info-form')).getByRole('button', { name: 'Save changes' }),
      ).toBeDisabled();
    });
  });

  it('deletes the base once its name is typed, and Undo restores it', async () => {
    const { calls } = serve();
    const { router } = await renderApp(`/b/${BASE}/settings`);
    await userEvent.click(await screen.findByTestId('delete-base-open'));
    const dialog = await screen.findByTestId('delete-base-dialog');
    const confirm = within(dialog).getByTestId('delete-base-confirm');
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Type Support to confirm'), 'Support');
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(confirm);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/o/${ORG.slug}`);
    });
    expect(await screen.findByText('Deleted base Support.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE}`);
    });
    expect(calls).toEqual([
      ['DELETE', undefined],
      ['RESTORE', undefined],
    ]);
  });

  it('shows Delete base only to the owner or an organization owner/admin', async () => {
    serve({ orgRole: 'member' });
    await renderApp(`/b/${BASE}/settings`);
    expect(await screen.findByTestId('base-info-form')).toBeVisible();
    expect(screen.queryByTestId('delete-base-open')).toBeNull();
  });
});
