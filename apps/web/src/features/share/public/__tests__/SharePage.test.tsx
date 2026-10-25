import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, problem, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';

import type { GridViewProps } from '../../../../grid';

// The canvas grid needs a real browser (E2E): a plain list stands in, laying its columns out.
vi.mock('../../../../grid/GridView', async () => {
  const { useEffect } = await import('react');
  return {
    GridView: ({ label, rowCount, fields, onColumnLayout }: GridViewProps) => {
      useEffect(() => {
        onColumnLayout?.({
          gutter: 48,
          columns: fields.map((field) => ({ fieldId: field.field.id, width: 160 })),
          frozen: 1,
          scroller: () => null,
        });
      }, [fields, onColumnLayout]);
      return <ul aria-label={label} data-rows={rowCount} />;
    },
  };
});

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE';
const PATH = `/s/${TOKEN}`;
const API = `/shares/${TOKEN}`;

const FIELDS = [
  {
    id: 'fld_Name000000000001',
    name: 'Name',
    type: 'text',
    options: {},
    is_primary: true,
    description: null,
  },
  {
    id: 'fld_Amount0000000001',
    name: 'Amount',
    type: 'number',
    options: {},
    is_primary: false,
    description: null,
  },
];

const CONFIG = {
  sort: [],
  group: [],
  hidden_fields: [],
  field_order: [],
  column_widths: {},
  frozen_count: 1,
  row_height: 'short',
  tree: { enabled: false, show_ancestors: false },
};

function meta(
  type: 'grid' | 'form',
  settings: Partial<Record<string, boolean>> = {},
): Record<string, unknown> {
  return {
    target_type: type === 'form' ? 'form' : 'view',
    table: { id: 'tbl_Orders0000000001', name: 'Orders', primary_field_id: FIELDS[0]?.id },
    view: {
      id: 'viw_Sales00000000001',
      name: type === 'form' ? 'Order form' : 'Sales',
      type,
      config:
        type === 'form'
          ? {
              ...CONFIG,
              form: {
                title: 'Tell us',
                description: '',
                cover_attachment_id: null,
                fields: [{ field: FIELDS[0]?.id, label: null, help: null, required: true }],
                success_message: 'Thanks!',
                redirect_url: null,
                allow_multiple_submissions: true,
                require_login: false,
                submission_limit: 'none',
              },
            }
          : CONFIG,
    },
    fields: FIELDS,
    settings: {
      allow_copy: false,
      allow_download: false,
      allow_export: false,
      allow_search: true,
      allow_viewer_filter_sort: true,
      show_record_detail: true,
      ...settings,
    },
    download_fields: [],
    expires_at: null,
    csrf_token: null,
  };
}

function locked(seconds: number): Response {
  const response = problem('RATE_LIMITED', 429);
  response.headers.set('Retry-After', String(seconds));
  return response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('share page /s/:token (T317)', () => {
  it('shows "not found" for an unknown link and "no longer available" for a gone one', async () => {
    stubApi({ routes: { [`GET ${API}/meta`]: () => problem('NOT_FOUND', 404) } });
    await renderApp(PATH);
    expect(await screen.findByRole('heading', { name: 'Link not found' })).toBeVisible();
    // Nothing of the app shell (no navigation, no account menu).
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('shows the gone screen for a revoked link', async () => {
    stubApi({ routes: { [`GET ${API}/meta`]: () => problem('SHARE_LINK_GONE', 410) } });
    await renderApp(PATH);
    expect(
      await screen.findByRole('heading', { name: 'This link is no longer available' }),
    ).toBeVisible();
  });

  it('asks the password, says when it is wrong and when the IP is locked out', async () => {
    const user = userEvent.setup();
    let unlocked = false;
    const answers = [problem('SHARE_PASSWORD_INVALID', 403), locked(900)];
    stubApi({
      routes: {
        [`GET ${API}/meta`]: () =>
          unlocked
            ? json({ ...meta('grid'), csrf_token: 'csrf-1' })
            : problem('SHARE_PASSWORD_REQUIRED', 403),
        [`POST ${API}/unlock`]: (init) => {
          const body = JSON.parse(init?.body as string) as { password: string };
          if (body.password === 'right-one') {
            unlocked = true;
            return json({ expires_at: '2026-09-26T00:00:00.000Z', csrf_token: 'csrf-1' });
          }
          return answers.shift() ?? locked(900);
        },
        [`POST ${API}/records/query`]: () => json({ records: [], total: 0, offset: 0, limit: 200 }),
      },
    });
    await renderApp(PATH);
    expect(await screen.findByRole('heading', { name: 'This link is protected' })).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
    const input = screen.getByLabelText('Password');
    await user.type(input, 'wrong{Enter}');
    expect(await screen.findByText('Wrong password. Try again.')).toBeVisible();
    await user.type(input, 'wrong again{Enter}');
    expect(
      await screen.findByText('Too many wrong passwords. Try again in 15 minutes.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    expect(input).toBeDisabled();
  });

  it('unlocks and sends the CSRF token of the link on later POSTs', async () => {
    const user = userEvent.setup();
    let unlocked = false;
    const fetchMock = stubApi({
      routes: {
        [`GET ${API}/meta`]: () =>
          unlocked
            ? json({ ...meta('grid'), csrf_token: 'csrf-1' })
            : problem('SHARE_PASSWORD_REQUIRED', 403),
        [`POST ${API}/unlock`]: () => {
          unlocked = true;
          return json({ expires_at: '2026-09-26T00:00:00.000Z', csrf_token: 'csrf-1' });
        },
        [`POST ${API}/records/query`]: () => json({ records: [], total: 0, offset: 0, limit: 200 }),
      },
    });
    await renderApp(PATH);
    await user.type(await screen.findByLabelText('Password'), 'right-one{Enter}');
    expect(await screen.findByRole('heading', { name: 'Sales', level: 1 })).toBeVisible();
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url.includes('/records/query'));
      expect(new Headers(call?.[1]?.headers).get('x-share-csrf-token')).toBe('csrf-1');
    });
  });

  it('shows a read-only grid; no filter or search when the link does not allow them', async () => {
    const fetchMock = stubApi({
      routes: {
        [`GET ${API}/meta`]: () =>
          json(meta('grid', { allow_viewer_filter_sort: false, allow_search: false })),
        [`POST ${API}/records/query`]: () =>
          json({
            records: [
              {
                id: 'rec_One0000000000001',
                created_at: '2026-09-25T00:00:00.000Z',
                updated_at: '2026-09-25T00:00:00.000Z',
                version: 1,
                fields: { fld_Name000000000001: 'r1', fld_Amount0000000001: 10 },
              },
            ],
            total: 1,
            offset: 0,
            limit: 200,
          }),
      },
    });
    await renderApp(PATH);
    expect(await screen.findByRole('heading', { name: 'Sales', level: 1 })).toBeVisible();
    expect(await screen.findByText('1 record')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeVisible();
    expect(screen.queryByTestId('filter-button')).toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    // T470: no summaries saved on the view, no summary bar.
    expect(screen.queryByTestId('summary-bar')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
    // T421b: a public link never asks for the session (no 401 in the console).
    const paths = fetchMock.mock.calls.map(
      ([input]) => new URL(input, 'http://localhost').pathname,
    );
    expect(paths).not.toContain('/api/v1/me');
  });

  it.each([
    [true, 1],
    [false, 0],
  ] as const)('a download button with allow_export = %s (T814)', async (allowExport, buttons) => {
    stubApi({
      routes: {
        [`GET ${API}/meta`]: () => json(meta('grid', { allow_export: allowExport })),
        [`POST ${API}/records/query`]: () => json({ records: [], total: 0, offset: 0, limit: 200 }),
      },
    });
    await renderApp(PATH);
    expect(await screen.findByRole('heading', { name: 'Sales', level: 1 })).toBeVisible();
    if (allowExport) {
      const button = await screen.findByTestId('share-export');
      await userEvent.click(button);
      expect(await screen.findByRole('menuitem', { name: 'CSV' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Excel (XLSX)' })).toBeVisible();
    }
    expect(screen.queryAllByTestId('share-export')).toHaveLength(buttons);
  });

  it('shows the summary bar of the view read-only (T470); none without summaries', async () => {
    const record = {
      id: 'rec_One0000000000001',
      created_at: '2026-09-25T00:00:00.000Z',
      updated_at: '2026-09-25T00:00:00.000Z',
      version: 1,
      fields: { fld_Name000000000001: 'r1', fld_Amount0000000001: 10 },
    };
    const withSummaries = meta('grid');
    const view = withSummaries['view'] as { config: Record<string, unknown> };
    view.config = { ...view.config, summaries: { fld_Amount0000000001: 'sum' } };
    const summaries = vi.fn(() =>
      json({
        count: 1,
        summaries: { fld_Amount0000000001: { fn: 'sum', value: 1234 } },
        group: [],
        groups: [],
        truncated: false,
      }),
    );
    const fetchMock = stubApi({
      routes: {
        [`GET ${API}/meta`]: () => json(withSummaries),
        [`POST ${API}/records/query`]: () =>
          json({ records: [record], total: 1, offset: 0, limit: 200 }),
        [`POST ${API}/records/summaries`]: summaries,
      },
    });
    await renderApp(PATH);
    const bar = await screen.findByTestId('summary-bar');
    await waitFor(() => {
      expect(bar).toHaveTextContent('Sum1234');
    });
    // Nothing to change through a link: no menu buttons on the cells.
    const cells = screen.queryAllByRole('button', { name: /^Summary of/u });
    expect(cells.filter((cell) => cell.hasAttribute('aria-haspopup'))).toEqual([]);
    const call = fetchMock.mock.calls.find(([input]) => input.includes('/summaries'));
    // The view's saved summaries, no viewer filter or search.
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({});
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('shows the public form of a form link', async () => {
    stubApi({
      routes: {
        [`GET ${API}/meta`]: () => json(meta('form')),
        [`GET ${API}/submit-token`]: () =>
          json({
            submit_token: 'v1.token',
            not_before: '2026-09-25T00:00:00.000Z',
            expires_at: '2026-09-26T00:00:00.000Z',
          }),
      },
    });
    await renderApp(PATH);
    expect(await screen.findByRole('heading', { name: 'Tell us', level: 1 })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  function formMeta(form: Record<string, unknown>, fields: readonly unknown[] = FIELDS) {
    const base = meta('form') as { view: { config: { form: Record<string, unknown> } } };
    return {
      ...base,
      fields,
      view: {
        ...base.view,
        config: { ...base.view.config, form: { ...base.view.config.form, ...form } },
      },
    };
  }
  const TOKEN_RESPONSE = () =>
    json({
      submit_token: 'v1.token',
      not_before: '2026-09-25T00:00:00.000Z',
      expires_at: '2026-09-26T00:00:00.000Z',
    });

  it('opens a sign-in form on the limit screen when the person already reached it (T321)', async () => {
    const status = vi.fn(() =>
      json({ limit: 'daily', reached: true, next_allowed_at: '2026-09-26T17:00:00.000Z' }),
    );
    stubApi({
      routes: {
        [`GET ${API}/meta`]: () =>
          json(formMeta({ require_login: true, submission_limit: 'daily' })),
        [`GET ${API}/submission-status`]: status,
        [`GET ${API}/submit-token`]: TOKEN_RESPONSE,
      },
    });
    await renderApp(PATH);
    expect(await screen.findByTestId('form-limit')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('does not ask the status of a form without a limit', async () => {
    const status = vi.fn(() => json({ limit: 'none', reached: false, next_allowed_at: null }));
    stubApi({
      routes: {
        [`GET ${API}/meta`]: () => json(formMeta({ require_login: true })),
        [`GET ${API}/submission-status`]: status,
        [`GET ${API}/submit-token`]: TOKEN_RESPONSE,
      },
    });
    await renderApp(PATH);
    expect(await screen.findByRole('button', { name: 'Submit' })).toBeVisible();
    expect(status).not.toHaveBeenCalled();
  });

  it('sends people without a session to sign in when a limited form needs it (T321)', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', {
      href: window.location.href,
      origin: window.location.origin,
      assign,
    });
    stubApi({
      routes: {
        [`GET ${API}/meta`]: () =>
          json(formMeta({ require_login: true, submission_limit: 'once' })),
        [`GET ${API}/submission-status`]: () => problem('UNAUTHENTICATED', 401),
      },
    });
    await renderApp(PATH);
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(PATH)}`);
    });
  });

  it('offers the people of GET /members to a user question of an org form (T321)', async () => {
    const owner = {
      id: 'fld_Owner00000000001',
      name: 'Owner',
      type: 'user',
      options: { multiple: false },
      is_primary: false,
      description: null,
    };
    const members = vi.fn(() =>
      json({
        items: [
          { id: 'usr_An00000000000001', display_name: 'An Nguyễn' },
          { id: 'usr_Binh000000000001', display_name: 'Bình Trần' },
        ],
      }),
    );
    stubApi({
      routes: {
        [`GET ${API}/meta`]: () =>
          json(
            formMeta(
              {
                fields: [
                  { field: FIELDS[0]?.id, label: null, help: null, required: true },
                  { field: owner.id, label: null, help: null, required: false },
                ],
              },
              [...FIELDS, owner],
            ),
          ),
        [`GET ${API}/members`]: members,
        [`GET ${API}/submit-token`]: TOKEN_RESPONSE,
      },
    });
    await renderApp(PATH);
    expect(await screen.findByText('An Nguyễn')).toBeInTheDocument();
    expect(screen.getByText('Bình Trần')).toBeInTheDocument();
    expect(members).toHaveBeenCalledTimes(1);
  });

  it('never asks for members when the form has no user question', async () => {
    const members = vi.fn(() => json({ items: [] }));
    stubApi({
      routes: {
        [`GET ${API}/meta`]: () => json(meta('form')),
        [`GET ${API}/members`]: members,
        [`GET ${API}/submit-token`]: TOKEN_RESPONSE,
      },
    });
    await renderApp(PATH);
    expect(await screen.findByRole('button', { name: 'Submit' })).toBeVisible();
    expect(members).not.toHaveBeenCalled();
  });

  it('sends people without a session to the sign-in page for an org link', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', {
      href: window.location.href,
      origin: window.location.origin,
      assign,
    });
    stubApi({ routes: { [`GET ${API}/meta`]: () => problem('UNAUTHENTICATED', 401) } });
    await renderApp(PATH);
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(PATH)}`);
    });
  });
});
