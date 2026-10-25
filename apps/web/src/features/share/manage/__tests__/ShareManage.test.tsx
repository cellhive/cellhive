import { DEFAULT_SHARE_LINK_SETTINGS } from '@cellhive/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultView, json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { clearToasts } from '../../../../lib/toast/toast';
import { viewSessions } from '../../../../lib/views/session';

import type { GridViewProps } from '../../../../grid';

// The canvas grid needs a real browser (E2E): a plain list stands in.
vi.mock('../../../../grid/GridView', () => ({
  GridView: ({ label }: GridViewProps) => <ul aria-label={label} />,
}));

const BASE = 'bse_Sales00000000001';
const TABLE = 'tbl_Orders0000000001';
const NOW = '2026-09-24T00:00:00.000Z';
const MAIN = defaultView(TABLE, { name: 'All orders' });
const FORM = defaultView(TABLE, { id: 'viw_Form000000000001', name: 'Order form', type: 'form' });
const MINE = defaultView(TABLE, {
  id: 'viw_Mine000000000001',
  name: 'Mine',
  is_personal: true,
  owner_id: ME.user.id,
});

type Kind = 'admin' | 'sharer' | 'sales';

function base(kind: Kind) {
  return {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_Sales00000000001',
    owner_id: 'usr_Owner00000000001',
    name: 'Sales',
    icon: null,
    description: null,
    permission_version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    access: {
      role: null,
      is_admin: kind === 'admin',
      base_rule: { copy: true, download: true, share_link: kind !== 'sales' },
      tables:
        kind === 'admin'
          ? {}
          : {
              [TABLE]: {
                perm: 'read_only',
                operations: [],
                view_rule: { allow_edit: false, visible_views: null },
                read_scope: 'all',
                fields: { fld_Title00000000001: 'read' },
                option_edit_fields: [],
                file_download_fields: [],
              },
            },
      dashboards: {},
    },
  };
}

const table = {
  id: TABLE,
  base_id: BASE,
  name: 'Orders',
  description: null,
  primary_field_id: 'fld_Title00000000001',
  position: 0,
  schema_state: 'ready',
  created_at: NOW,
  updated_at: NOW,
};

const fields = {
  items: [
    {
      id: 'fld_Title00000000001',
      table_id: TABLE,
      name: 'Title',
      type: 'text',
      options: {},
      is_primary: true,
      required: false,
      unique_values: false,
      description: null,
      position: 0,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      // Read by the user, hidden in the view: "Not visible" in the warning (T320).
      id: 'fld_Cost000000000001',
      table_id: TABLE,
      name: 'Cost',
      type: 'number',
      options: {},
      is_primary: false,
      required: false,
      unique_values: false,
      description: null,
      position: 1,
      created_at: NOW,
      updated_at: NOW,
    },
  ],
  total: 2,
  offset: 0,
  limit: 1000,
};

const PREVIEW = {
  target_type: 'view',
  record_count: 3,
  record_count_estimated: false,
  fields: [
    { id: 'fld_Title00000000001', name: 'Title', type: 'text', access: 'read' },
    { id: 'fld_Amount0000000001', name: 'Amount', type: 'number', access: 'read' },
  ],
};

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'shl_Link000000000001',
    base_id: BASE,
    table_id: TABLE,
    target_type: 'view',
    target_id: MAIN.id,
    target_name: MAIN.name,
    audience: 'org',
    status: 'active',
    token_prefix: 'Ab3xY_',
    has_password: false,
    expires_at: null,
    enabled: true,
    settings: DEFAULT_SHARE_LINK_SETTINGS,
    created_by: { id: ME.user.id, name: 'An Nguyen' },
    last_accessed_at: null,
    access_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const TOKEN = 'Ab3xY_0123456789abcdefghijklmnopqrstuvwxyz';
const list = (items: unknown[]) => json({ items, total: items.length, offset: 0, limit: 50 });

interface Options {
  kind?: Kind;
  policy?: 'allowed' | 'forms_only' | 'disabled';
  links?: ReturnType<typeof link>[];
  extra?: Record<string, (init: RequestInit | undefined) => Response>;
}

function serve({ kind = 'admin', policy = 'allowed', links = [], extra = {} }: Options = {}) {
  const state = { links, views: { [TABLE]: [MAIN, FORM, MINE] } };
  const fetchMock = stubApi({
    signedIn: true,
    views: state.views,
    routes: {
      [`GET /bases/${BASE}`]: () => json(base(kind)),
      [`GET /bases/${BASE}/tables`]: () =>
        json({ items: [table], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE}`]: () => json(table),
      [`GET /tables/${TABLE}/fields`]: () => json(fields),
      [`POST /tables/${TABLE}/records/query`]: () =>
        json({ records: [], total: 0, offset: 0, limit: 200 }),
      [`GET /orgs/${ORG.id}`]: () =>
        json({ ...ORG, settings: { ...ORG.settings, public_sharing: policy } }),
      [`GET /views/${MAIN.id}/share-links`]: () => list(state.links),
      [`GET /views/${MAIN.id}/share-links/preview`]: () => json(PREVIEW),
      [`GET /views/${FORM.id}/share-links`]: () => list([]),
      [`GET /views/${FORM.id}/share-links/preview`]: () =>
        json({ ...PREVIEW, target_type: 'form', record_count: null }),
      ...extra,
    },
  });
  return { fetchMock, state };
}

function bodyOf(fetchMock: ReturnType<typeof stubApi>, method: string, path: string): unknown {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => init?.method === method && url.includes(path),
  );
  const body = call?.[1]?.body;
  return typeof body === 'string' ? JSON.parse(body) : undefined;
}

function lastBodyOf(fetchMock: ReturnType<typeof stubApi>, method: string, path: string): unknown {
  const call = fetchMock.mock.calls.findLast(
    ([url, init]) => init?.method === method && url.includes(path),
  );
  const body = call?.[1]?.body;
  return typeof body === 'string' ? JSON.parse(body) : undefined;
}

const viewPath = (viewId: string) => `/b/${BASE}/t/${TABLE}/v/${viewId}`;

async function openDialog(name = 'All orders') {
  await userEvent.click(await screen.findByRole('button', { name: `Share view ${name}` }));
  return screen.findByRole('dialog', { name: `Share “${name}”` });
}

beforeEach(() => {
  viewSessions.reset();
});

afterEach(() => {
  window.localStorage.clear();
  clearToasts();
});

const AXE_TIMEOUT = 30_000;

describe('share button (T316, FRONTEND §7)', () => {
  it('is offered to roles with share_link', async () => {
    serve({ kind: 'sharer' });
    await renderApp(viewPath(MAIN.id));
    expect(await screen.findByRole('button', { name: 'Share view All orders' })).toBeVisible();
  });

  it('is not offered on personal views', async () => {
    serve({ kind: 'sharer' });
    await renderApp(viewPath(MINE.id));
    await screen.findByRole('navigation', { name: 'Views of Orders' });
    expect(screen.queryByRole('button', { name: /^Share view/u })).toBeNull();
  });

  it('is hidden without base_rule.share_link', async () => {
    serve({ kind: 'sales' });
    await renderApp(viewPath(MAIN.id));
    await screen.findByRole('navigation', { name: 'Views of Orders' });
    expect(screen.queryByRole('button', { name: /^Share view/u })).toBeNull();
  });

  it('forms also need "add" on the table', async () => {
    serve({ kind: 'sharer' });
    await renderApp(viewPath(FORM.id));
    await screen.findByRole('navigation', { name: 'Views of Orders' });
    expect(screen.queryByRole('button', { name: /^Share view/u })).toBeNull();
  });
});

describe('share dialog: attachment downloads (T419)', () => {
  const FILE_PREVIEW = {
    ...PREVIEW,
    fields: [
      ...PREVIEW.fields,
      { id: 'fld_Photos0000000001', name: 'Photos', type: 'attachment', access: 'read' },
      { id: 'fld_Contract00000001', name: 'Contracts', type: 'attachment', access: 'read' },
    ],
  };
  const withFiles = { [`GET /views/${MAIN.id}/share-links/preview`]: () => json(FILE_PREVIEW) };

  it(
    'a new link: turning downloads on lists the downloadable file fields and asks for the warning again',
    async () => {
      const { fetchMock, state } = serve({
        extra: {
          ...withFiles,
          [`POST /views/${MAIN.id}/share-links`]: () => {
            const created = link();
            state.links = [created];
            return json({ ...created, token: TOKEN, url: `https://ob.test/s/${TOKEN}` }, 201);
          },
        },
      });
      await renderApp(viewPath(MAIN.id));
      const dialog = await openDialog();
      const warning = await within(dialog).findByTestId('share-scope-warning');
      // Off: file fields show thumbnails only.
      expect(within(warning).getByTestId('share-scope-downloads')).toHaveTextContent(
        'The 2 file fields show thumbnails only',
      );
      const acknowledge = within(dialog).getByRole('checkbox', {
        name: 'I understand who will be able to see this data',
      });
      await userEvent.click(acknowledge);
      expect(acknowledge).toBeChecked();
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Download attachments' }));
      const downloads = within(warning).getByTestId('share-scope-downloads');
      expect(downloads).toHaveTextContent('Files anyone with the link can download:');
      expect(
        within(downloads)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Photos', 'Contracts']);
      // The scope grew: the warning must be acknowledged again.
      expect(acknowledge).not.toBeChecked();
      expect(within(dialog).getByRole('button', { name: 'Create link' })).toBeDisabled();
      expect(await axeViolations(document.body)).toEqual([]);
      await userEvent.click(acknowledge);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));
      await within(dialog).findByTestId('share-link-once');
      expect(bodyOf(fetchMock, 'POST', `/views/${MAIN.id}/share-links`)).toMatchObject({
        settings: { allow_download: true },
      });
    },
    AXE_TIMEOUT,
  );

  it('a creator without download rights: the fields stay thumbnails only', async () => {
    serve({ kind: 'sharer', extra: withFiles });
    await renderApp(viewPath(MAIN.id));
    const dialog = await openDialog();
    await within(dialog).findByTestId('share-scope-warning');
    await userEvent.click(
      await within(dialog).findByRole('checkbox', { name: 'Download attachments' }),
    );
    const downloads = within(dialog).getByTestId('share-scope-downloads');
    expect(downloads).toHaveTextContent('Thumbnails only (you cannot download these yourself):');
    expect(downloads).not.toHaveTextContent('Files anyone with the link can download');
  });

  it('an existing link: the switch asks for a confirmation that names the fields', async () => {
    const { fetchMock, state } = serve({
      links: [link()],
      extra: {
        ...withFiles,
        'PATCH /share-links/shl_Link000000000001': () => {
          const updated = link({
            settings: { ...DEFAULT_SHARE_LINK_SETTINGS, allow_download: true },
            updated_at: '2026-09-24T01:00:00.000Z',
          });
          state.links = [updated];
          return json(updated);
        },
      },
    });
    await renderApp(viewPath(MAIN.id));
    const dialog = await openDialog();
    const options = await within(dialog).findByTestId('share-options');
    const downloads = within(options).getByRole('switch', { name: 'Download attachments' });
    await userEvent.click(downloads);
    const confirm = within(dialog).getByRole('alertdialog', {
      name: 'Let people with the link download files?',
    });
    expect(confirm).toHaveTextContent('original files of: Photos, Contracts.');
    expect(bodyOf(fetchMock, 'PATCH', '/share-links/shl_Link000000000001')).toBeUndefined();
    // Escape cancels: nothing is saved.
    await userEvent.keyboard('{Escape}');
    expect(within(dialog).queryByRole('alertdialog')).toBeNull();
    expect(bodyOf(fetchMock, 'PATCH', '/share-links/shl_Link000000000001')).toBeUndefined();

    await userEvent.click(downloads);
    const again = within(dialog).getByRole('alertdialog', {
      name: 'Let people with the link download files?',
    });
    await userEvent.click(within(again).getByRole('button', { name: 'Allow downloads' }));
    await waitFor(() => {
      expect(bodyOf(fetchMock, 'PATCH', '/share-links/shl_Link000000000001')).toEqual({
        settings: { allow_download: true },
      });
    });
    await waitFor(() => {
      expect(within(options).getByRole('switch', { name: 'Download attachments' })).toBeChecked();
    });
  });
});

describe('share dialog (T316)', () => {
  it(
    'shows the scope warning, creates a public link after it is acknowledged, shows the address once',
    async () => {
      const { fetchMock, state } = serve({
        extra: {
          [`POST /views/${MAIN.id}/share-links`]: () => {
            const created = link({ audience: 'public' });
            state.links = [created];
            return json({ ...created, token: TOKEN, url: `https://ob.test/s/${TOKEN}` }, 201);
          },
        },
      });
      await renderApp(viewPath(MAIN.id));
      const dialog = await openDialog();
      const warning = await within(dialog).findByTestId('share-scope-warning');
      expect(warning).toHaveTextContent('People with the link will see 3 records and 2 fields:');
      expect(
        within(within(warning).getByTestId('share-scope-fields'))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Title', 'Amount']);
      expect(
        within(within(warning).getByTestId('share-scope-hidden'))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Cost']);
      // Embeds are not offered (S3 decision 8); downloads are (T419), off by default.
      expect(within(dialog).queryByLabelText(/embed/iu)).toBeNull();
      expect(
        within(dialog).getByRole('checkbox', { name: 'Download attachments' }),
      ).not.toBeChecked();
      expect(await axeViolations(document.body)).toEqual([]);

      const create = within(dialog).getByRole('button', { name: 'Create link' });
      expect(create).toBeDisabled();
      await userEvent.click(within(dialog).getByRole('radio', { name: 'Anyone with the link' }));
      // No link yet: options are check boxes applied by "Create link" (T322b), not switches.
      const options = within(dialog).getByTestId('share-options');
      expect(within(options).queryAllByRole('switch')).toEqual([]);
      await userEvent.click(within(options).getByRole('checkbox', { name: 'Copy cell values' }));
      expect(bodyOf(fetchMock, 'POST', `/views/${MAIN.id}/share-links`)).toBeUndefined();
      await userEvent.click(
        within(dialog).getByRole('checkbox', {
          name: 'I understand who will be able to see this data',
        }),
      );
      expect(create).toBeEnabled();
      await userEvent.click(create);

      expect(await within(dialog).findByTestId('share-link-once')).toHaveTextContent(
        'Copy the link now',
      );
      expect(within(dialog).getByRole('textbox', { name: 'Link address' })).toHaveValue(
        `https://ob.test/s/${TOKEN}`,
      );
      expect(bodyOf(fetchMock, 'POST', `/views/${MAIN.id}/share-links`)).toEqual({
        audience: 'public',
        settings: {
          allow_copy: true,
          allow_download: false,
          allow_export: false,
          allow_search: true,
          allow_viewer_filter_sort: true,
          show_record_detail: true,
        },
      });
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Copy link' }));
      expect(writeText).toHaveBeenCalledWith(`https://ob.test/s/${TOKEN}`);
      expect(await screen.findByText('Link copied.')).toBeVisible();
    },
    AXE_TIMEOUT,
  );

  it('shows only the prefix of an existing link; regenerate after a confirmation', async () => {
    const { fetchMock, state } = serve({
      links: [link()],
      extra: {
        'POST /share-links/shl_Link000000000001/regenerate': () => {
          const created = link({ id: 'shl_Link000000000002' });
          state.links = [created];
          return json({ ...created, token: TOKEN, url: `https://ob.test/s/${TOKEN}` }, 201);
        },
      },
    });
    await renderApp(viewPath(MAIN.id));
    const dialog = await openDialog();
    const address = await within(dialog).findByRole('textbox', { name: 'Link address' });
    expect(address).toHaveValue(`${window.location.origin}/s/Ab3xY_…`);
    // Reopened: the prefix is read-only, never focused nor selected (T320 QA).
    expect(address).toHaveAttribute('readonly');
    expect(address).not.toHaveFocus();
    address.focus();
    const input = address as HTMLInputElement;
    expect(input.selectionEnd).toBe(input.selectionStart);
    expect(within(dialog).getByTestId('share-link-stats')).toHaveTextContent('Not opened yet');
    expect(within(dialog).queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(within(dialog).getByText('Active')).toBeVisible();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Create new link' }));
    const confirm = within(dialog).getByRole('alertdialog', { name: 'Create a new link?' });
    expect(confirm).toHaveTextContent('The current link stops working at once.');
    const confirmButton = within(confirm).getByRole('button', { name: 'Create new link' });
    expect(confirmButton).toHaveFocus();
    await userEvent.click(confirmButton);
    await waitFor(() => {
      expect(within(dialog).getByRole('textbox', { name: 'Link address' })).toHaveValue(
        `https://ob.test/s/${TOKEN}`,
      );
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => init?.method === 'POST' && url.includes('/regenerate'),
      ),
    ).toBe(true);
  });

  it('an existing link: viewer settings are switches saved at once; password and expiry wait for Save (T322b)', async () => {
    const { fetchMock, state } = serve({
      links: [link()],
      extra: {
        'PATCH /share-links/shl_Link000000000001': () => {
          const updated = link({
            settings: { ...DEFAULT_SHARE_LINK_SETTINGS, allow_copy: true },
            updated_at: '2026-09-24T01:00:00.000Z',
          });
          state.links = [updated];
          return json(updated);
        },
      },
    });
    await renderApp(viewPath(MAIN.id));
    const dialog = await openDialog();
    const options = await within(dialog).findByTestId('share-options');
    // Values that need input stay check boxes of the form.
    expect(within(options).getByRole('checkbox', { name: 'Require a password' })).not.toBeChecked();
    const copy = within(options).getByRole('switch', { name: 'Copy cell values' });
    expect(copy).not.toBeChecked();
    await userEvent.click(copy);
    await waitFor(() => {
      expect(bodyOf(fetchMock, 'PATCH', '/share-links/shl_Link000000000001')).toEqual({
        settings: { allow_copy: true },
      });
    });
    await waitFor(() => {
      expect(within(options).getByRole('switch', { name: 'Copy cell values' })).toBeChecked();
    });
    // Nothing waits for "Save": the footer offers "Done".
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeVisible();
    expect(within(dialog).getByTestId('share-dialog-footer')).toHaveClass('sticky');
  });

  it(
    'the Embed tab: blocked for an organization link; sites, switch and code for a public one (T814)',
    async () => {
      const origin = 'https://intranet.example.com';
      const { fetchMock, state } = serve({
        links: [link({ audience: 'public' })],
        extra: {
          'PATCH /share-links/shl_Link000000000001': (init) => {
            const body = JSON.parse(init?.body as string) as {
              settings: { embed: Record<string, unknown> };
            };
            const current = state.links[0] ?? link({ audience: 'public' });
            const updated = link({
              audience: 'public',
              settings: {
                ...DEFAULT_SHARE_LINK_SETTINGS,
                embed: { ...current.settings.embed, ...body.settings.embed },
              },
              updated_at: '2026-09-24T01:00:00.000Z',
            });
            state.links = [updated];
            return json(updated);
          },
        },
      });
      await renderApp(viewPath(MAIN.id));
      const dialog = await openDialog();
      await userEvent.click(await within(dialog).findByRole('tab', { name: 'Embed' }));
      const panel = await within(dialog).findByTestId('share-embed');
      expect(within(panel).queryByTestId('share-embed-blocked')).toBeNull();
      const enable = within(panel).getByRole('switch', { name: 'Allow embedding' });
      // No site yet: embedding cannot be turned on.
      expect(enable).toBeDisabled();
      const input = within(panel).getByTestId('embed-origin-input');
      await userEvent.type(input, 'https://intranet.example.com/page{Enter}');
      expect(await within(panel).findByTestId('embed-origin-error')).toHaveTextContent(
        'without a path',
      );
      await userEvent.clear(input);
      await userEvent.type(input, 'https://Intranet.Example.com{Enter}');
      await waitFor(() => {
        expect(bodyOf(fetchMock, 'PATCH', '/share-links/shl_Link000000000001')).toEqual({
          settings: { embed: { allowed_origins: [origin] } },
        });
      });
      expect(await within(panel).findByTestId('embed-origins')).toHaveTextContent(origin);
      await waitFor(() => {
        expect(within(panel).getByRole('switch', { name: 'Allow embedding' })).toBeEnabled();
      });
      await userEvent.click(within(panel).getByRole('switch', { name: 'Allow embedding' }));
      await waitFor(() => {
        expect(lastBodyOf(fetchMock, 'PATCH', '/share-links/shl_Link000000000001')).toEqual({
          settings: { embed: { enabled: true } },
        });
      });
      // The code needs the full address, pasted back by its owner.
      expect(within(panel).queryByTestId('embed-code')).toBeNull();
      const full = `Ab3xY_${'a'.repeat(37)}`;
      await userEvent.type(
        within(panel).getByTestId('embed-paste-link'),
        `https://ob.test/s/${full}`,
      );
      const area: HTMLTextAreaElement = await within(panel).findByTestId('embed-code');
      const code = area.value;
      expect(code).toContain(`src="https://ob.test/s/${full}?embed=1"`);
      expect(code).toContain('title="All orders"');
      expect(await axeViolations(document.body)).toEqual([]);
    },
    AXE_TIMEOUT,
  );

  it('the Embed tab says why an organization link cannot be embedded (T814)', async () => {
    serve({ links: [link()] });
    await renderApp(viewPath(MAIN.id));
    const dialog = await openDialog();
    await userEvent.click(await within(dialog).findByRole('tab', { name: 'Embed' }));
    expect(await within(dialog).findByTestId('share-embed-blocked')).toHaveTextContent(
      'Only a link anyone can open can be embedded',
    );
    expect(within(dialog).getByRole('switch', { name: 'Allow embedding' })).toBeDisabled();
  });

  it('turning a link on needs the warning acknowledged; revoke asks first', async () => {
    const { fetchMock, state } = serve({
      links: [link({ enabled: false, status: 'disabled' })],
      extra: {
        'PATCH /share-links/shl_Link000000000001': () => {
          const updated = link({ updated_at: '2026-09-24T01:00:00.000Z' });
          state.links = [updated];
          return json(updated);
        },
        'DELETE /share-links/shl_Link000000000001': () => {
          state.links = [];
          return new Response(null, { status: 204 });
        },
      },
    });
    await renderApp(viewPath(MAIN.id));
    const dialog = await openDialog();
    expect(
      await within(dialog).findByText(
        'This link is turned off. Nobody can open it until you turn it on.',
      ),
    ).toBeVisible();
    const turnOn = within(dialog).getByRole('button', { name: 'Turn on' });
    expect(turnOn).toBeDisabled();
    await userEvent.click(
      await within(dialog).findByRole('checkbox', {
        name: 'I understand who will be able to see this data',
      }),
    );
    await userEvent.click(turnOn);
    await waitFor(() => {
      expect(bodyOf(fetchMock, 'PATCH', '/share-links/shl_Link000000000001')).toEqual({
        enabled: true,
      });
    });
    expect(await within(dialog).findByRole('button', { name: 'Turn off' })).toBeVisible();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    const confirm = within(dialog).getByRole('alertdialog', { name: 'Revoke this link?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Revoke link' }));
    expect(await within(dialog).findByRole('button', { name: 'Create link' })).toBeVisible();
  });

  it('disables the public option when the organization forbids it; a blocked link says why', async () => {
    serve({ policy: 'disabled', links: [link({ audience: 'public', status: 'blocked' })] });
    await renderApp(viewPath(MAIN.id));
    const dialog = await openDialog();
    const publicOption = await within(dialog).findByRole('radio', { name: 'Anyone with the link' });
    await waitFor(() => {
      expect(publicOption).toBeDisabled();
    });
    expect(publicOption).toHaveAccessibleDescription(
      /Your organization does not allow public links/u,
    );
    expect(within(dialog).getByText('Blocked by policy')).toBeVisible();
    expect(within(dialog).getByText(/This public link does not work/u)).toBeVisible();
  });

  it('forms_only: public stays possible for a form, not for a grid view', async () => {
    serve({ policy: 'forms_only' });
    await renderApp(viewPath(FORM.id));
    const dialog = await openDialog('Order form');
    expect(await within(dialog).findByTestId('share-scope-warning')).toHaveTextContent(
      'People can create records filling in these 2 fields:',
    );
    await waitFor(() => {
      expect(within(dialog).getByRole('radio', { name: 'Anyone with the link' })).toBeEnabled();
    });
    // Form links have no view settings.
    expect(within(dialog).queryByRole('switch', { name: 'Search' })).toBeNull();
  });
});

describe('share link settings pages (T316)', () => {
  const links = [
    link(),
    link({
      id: 'shl_Link000000000002',
      target_type: 'form',
      target_name: 'Order form',
      audience: 'public',
      status: 'blocked',
      last_accessed_at: NOW,
      access_count: 4,
    }),
    link({ id: 'shl_Link000000000003', target_name: null, status: 'expired' }),
  ];

  it(
    'lists the links of a base and revokes the selected ones after a confirmation',
    async () => {
      const { fetchMock } = serve({
        extra: {
          [`GET /bases/${BASE}/share-links`]: () => list(links),
          [`POST /bases/${BASE}/share-links/revoke`]: () =>
            json({ revoked: ['shl_Link000000000001', 'shl_Link000000000003'] }),
        },
      });
      await renderApp(`/b/${BASE}/settings/share-links`);
      expect(await screen.findByRole('heading', { name: 'Share links' })).toBeVisible();
      const table = await screen.findByRole('table', { name: 'Share links' });
      const rows = within(table).getAllByRole('row').slice(1);
      expect(rows).toHaveLength(3);
      expect(rows[1]).toHaveTextContent('Order form');
      expect(rows[1]).toHaveTextContent('Public');
      expect(rows[1]).toHaveTextContent('Blocked by policy');
      expect(rows[2]).toHaveTextContent('Deleted view');
      expect(rows[2]).toHaveTextContent('Expired');
      expect(await axeViolations(document.body)).toEqual([]);

      await userEvent.click(
        within(table).getByRole('checkbox', { name: 'Select link to All orders' }),
      );
      await userEvent.click(
        within(table).getByRole('checkbox', { name: 'Select link to Deleted view' }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Revoke selected' }));
      const confirm = screen.getByRole('alertdialog', { name: 'Revoke 2 links?' });
      await userEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
      expect(await screen.findByText('2 links revoked.')).toBeVisible();
      expect(bodyOf(fetchMock, 'POST', `/bases/${BASE}/share-links/revoke`)).toEqual({
        ids: ['shl_Link000000000001', 'shl_Link000000000003'],
      });
    },
    AXE_TIMEOUT,
  );

  it('filters on the server', async () => {
    const { fetchMock } = serve({
      extra: { [`GET /bases/${BASE}/share-links`]: () => list(links) },
    });
    await renderApp(`/b/${BASE}/settings/share-links`);
    await screen.findByRole('table', { name: 'Share links' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Audience' }), 'public');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'false');
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([url]) => url);
      expect(
        urls.some((url) => url.includes('audience=public') && url.includes('enabled=false')),
      ).toBe(true);
    });
  });

  it('is the 404 screen for members who are not base admins', async () => {
    serve({ kind: 'sharer' });
    await renderApp(`/b/${BASE}/settings/share-links`);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it(
    'organization page: shows the impact of a stricter policy before saving it',
    async () => {
      const { fetchMock } = serve({
        extra: {
          [`GET /orgs/${ORG.id}/share-links`]: () => list(links),
          [`PATCH /orgs/${ORG.id}`]: () =>
            json({ ...ORG, settings: { ...ORG.settings, public_sharing: 'disabled' } }),
        },
      });
      await renderApp(`/o/${ORG.slug}/settings/share-links`);
      expect(await screen.findByRole('heading', { name: 'Public sharing' })).toBeVisible();
      await screen.findByRole('table', { name: 'Share links' });
      const disabled = await screen.findByRole('radio', { name: 'Not allowed' });
      await userEvent.click(disabled);
      expect(
        await screen.findByText(/3 public links that are turned on will be blocked/u),
      ).toBeVisible();
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            url.includes(`/orgs/${ORG.id}/share-links`) &&
            url.includes('audience=public') &&
            url.includes('enabled=true'),
        ),
      ).toBe(true);
      expect(await axeViolations(document.body)).toEqual([]);
      await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
      expect(await screen.findByText('Public sharing policy saved.')).toBeVisible();
      expect(bodyOf(fetchMock, 'PATCH', `/orgs/${ORG.id}`)).toEqual({
        settings: { public_sharing: 'disabled' },
      });
    },
    AXE_TIMEOUT,
  );

  it('organization page: saving cancels the impact refetch; the page stays and the base filter answers (T700, N14)', async () => {
    const workspace = 'wsp_0123456789ABCDEF';
    const fetchMock = serve({
      extra: {
        [`GET /orgs/${ORG.id}/share-links`]: () => list(links),
        [`PATCH /orgs/${ORG.id}`]: () =>
          json({ ...ORG, settings: { ...ORG.settings, public_sharing: 'disabled' } }),
        [`GET /orgs/${ORG.id}/workspaces`]: () =>
          json({
            items: [
              {
                id: workspace,
                organization_id: ORG.id,
                name: 'Main',
                slug: 'main',
                role: 'admin',
                created_at: NOW,
                updated_at: NOW,
              },
            ],
            total: 1,
            offset: 0,
            limit: 1000,
          }),
        [`GET /workspaces/${workspace}/bases`]: () =>
          json({
            items: [{ ...base('admin'), access: undefined }],
            total: 1,
            offset: 0,
            limit: 1000,
          }),
      },
    }).fetchMock;
    // The E2E trace of N14: the impact count answers, then its refetch started by saving is
    // cancelled (−1) right after the PATCH. Here it hangs until aborted; the base filter answers.
    let impactCalls = 0;
    let aborted = 0;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      if (input.includes('enabled=true') && input.includes('limit=1') && ++impactCalls > 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted += 1;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      if (input.includes(`base_id=${BASE}`)) return Promise.resolve(list([links[1]]));
      return fetchMock(input, init);
    });

    await renderApp(`/o/${ORG.slug}/settings/share-links`);
    const heading = await screen.findByRole('heading', { name: 'Share links', level: 1 });
    await screen.findByRole('table', { name: 'Share links' });
    // Any Suspense fallback from here on: the root one, or the page hidden behind another.
    const fallbacks: string[] = [];
    const observer = new MutationObserver(() => {
      if (document.querySelector('div[role="status"].min-h-dvh') !== null) fallbacks.push('root');
      if (heading.closest('[style*="display: none"]') !== null) fallbacks.push('page hidden');
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });

    await userEvent.click(screen.getByRole('radio', { name: 'Not allowed' }));
    expect(
      await screen.findByText(/3 public links that are turned on will be blocked/u),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(await screen.findByText('Public sharing policy saved.')).toBeVisible();
    await waitFor(() => {
      expect(aborted).toBe(1);
    });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Base' }), BASE);
    const table = screen.getByRole('table', { name: 'Share links' });
    await waitFor(() => {
      expect(within(table).getAllByRole('row')).toHaveLength(2);
    });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Blocked by policy');
    expect(heading).toBeVisible();
    observer.disconnect();
    expect(fallbacks).toEqual([]);
  });
});
