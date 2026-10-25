import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { clearToasts } from '../../../lib/toast/toast';

import type { AuditLogEntryDto, AuditLogList } from '@cellhive/contracts';

/** T716: the audit log viewer of an organization and of a base. */

const BASE = 'bse_0123456789ABCDEF';
const TABLE = 'tbl_0123456789ABCDEF';
const SALES = 'usr_Sales00000000001';
const GONE = 'usr_Gone000000000001';
const STAMP = '2026-10-24T03:00:00.000Z';

function entry(id: string, patch: Partial<AuditLogEntryDto> = {}): AuditLogEntryDto {
  return {
    id: `aud_${id.padEnd(16, '0')}`,
    created_at: '2026-10-24T02:00:00.000Z',
    actor: { type: 'user', id: SALES, name: 'Phạm Lan' },
    via: null,
    action: 'record.updated',
    entity_type: 'record',
    entity_id: 'rec_0123456789ABCDEF',
    base_id: BASE,
    table_id: TABLE,
    batch_id: 'req_Batch0000000001',
    request_id: 'req_Batch0000000001',
    before: { fld_amount: 100, fld_note: 'old' },
    after: { fld_amount: 150, fld_note: '<img src=x onerror=alert(1)>' },
    ip: '203.0.113.7',
    user_agent: 'Mozilla/5.0 Test',
    ...patch,
  };
}

const REFS: NonNullable<AuditLogList['refs']> = {
  users: {
    [SALES]: { display_name: 'Phạm Ngọc Lan' },
    [GONE]: { display_name: null },
  },
  fields: {
    fld_amount: { name: 'amount', table_id: TABLE, deleted: false },
    fld_note: { name: 'Ghi chú', table_id: TABLE, deleted: false },
  },
  tables: { [TABLE]: { name: 'Orders', deleted: false } },
  api_tokens: { tok_0123456789ABCDEF: { name: 'CRM sync' } },
};

const FIRST = [
  entry('A1'),
  entry('A2', {
    via: { api_token_id: 'tok_0123456789ABCDEF', api_token_name: 'CRM sync' },
    before: { fld_amount: 150 },
    after: { fld_amount: 175 },
  }),
  entry('A3', {
    actor: { type: 'user', id: GONE, name: null },
    action: 'table.created',
    entity_type: 'table',
    entity_id: 'tbl_Gone000000000001',
    table_id: null,
    before: null,
    after: { name: 'Old' },
  }),
  entry('A4', {
    via: { api_token_id: null, api_token_name: null },
    action: 'field.deleted',
    entity_type: 'field',
    entity_id: 'fld_Gone000000000001',
  }),
];
const SECOND = [entry('B1', { action: 'auth.login', entity_type: 'user', entity_id: SALES })];

function baseDetail(admin: boolean) {
  return {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_0123456789ABCDEF',
    owner_id: ME.user.id,
    name: 'Chăm sóc khách hàng',
    icon: null,
    description: null,
    permission_version: 1,
    settings: { strict_computed_permissions: false },
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
    access: {
      role: null,
      is_admin: admin,
      base_rule: { copy: true, download: true, share_link: true },
      tables: {},
      dashboards: {},
    },
  };
}

function serve(
  options: {
    items?: AuditLogEntryDto[];
    retention?: number;
    admin?: boolean;
    orgRole?: 'owner' | 'member';
  } = {},
) {
  const page = (items: AuditLogEntryDto[], next: string | null): AuditLogList => ({
    items,
    next_cursor: next,
    retention_days: options.retention ?? 180,
    refs: REFS,
  });
  const list = () =>
    json(page(options.items ?? FIRST, options.items === undefined ? 'cur_2' : null));
  let jobPolls = 0;
  const role = options.orgRole ?? 'owner';
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role }] }),
      [`GET /orgs/${ORG.id}/audit-logs`]: list,
      [`GET /bases/${BASE}/audit-logs`]: list,
      [`GET /bases/${BASE}`]: () => json(baseDetail(options.admin ?? true)),
      [`GET /bases/${BASE}/tables`]: () => json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /orgs/${ORG.id}/members`]: () =>
        json({
          items: [
            {
              user: {
                id: SALES,
                email: 'sales1@example.test',
                display_name: 'Phạm Ngọc Lan',
                avatar_url: null,
              },
              role: 'member',
              joined_at: STAMP,
            },
            { user: { ...ME.user }, role: 'owner', joined_at: STAMP },
          ],
          total: 2,
          offset: 0,
          limit: 1000,
        }),
      [`GET /orgs/${ORG.id}/workspaces`]: () =>
        json({
          items: [
            {
              id: 'wsp_0123456789ABCDEF',
              organization_id: ORG.id,
              name: 'W',
              slug: 'w',
              role: null,
              created_at: STAMP,
              updated_at: STAMP,
            },
          ],
          total: 1,
          offset: 0,
          limit: 1000,
        }),
      'GET /workspaces/wsp_0123456789ABCDEF/bases': () =>
        json({ items: [baseDetail(true)], total: 1, offset: 0, limit: 1000 }),
      [`POST /orgs/${ORG.id}/audit-logs/export`]: () =>
        json({ job_id: 'job_0123456789ABCDEF' }, 202),
      [`POST /bases/${BASE}/audit-logs/export`]: () =>
        json({ job_id: 'job_0123456789ABCDEF' }, 202),
      'GET /jobs/job_0123456789ABCDEF': () => {
        jobPolls += 1;
        return json({
          id: 'job_0123456789ABCDEF',
          type: 'audit.export',
          status: jobPolls > 1 ? 'succeeded' : 'running',
          progress: jobPolls > 1 ? 1 : 0.4,
          result:
            jobPolls > 1
              ? {
                  download_url: '/api/v1/files/exports/job_0123456789ABCDEF',
                  expires_at: '2026-10-25T03:00:00.000Z',
                  size: 1200,
                  rows: 1234,
                  truncated: false,
                }
              : null,
          error: null,
          created_at: STAMP,
          started_at: STAMP,
          finished_at: jobPolls > 1 ? STAMP : null,
        });
      },
    },
  });
  // The second page of the org list answers the cursor.
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname.endsWith('/audit-logs') && url.searchParams.get('cursor') === 'cur_2') {
      return Promise.resolve(json(page(SECOND, null)));
    }
    return original?.(input, init) ?? Promise.resolve(problem('NOT_FOUND', 404));
  });
  /** Query strings of the list requests, in order. */
  const listQueries = () =>
    fetchMock.mock.calls
      .map(([input]) => new URL(input, 'http://localhost'))
      .filter((url) => url.pathname.endsWith('/audit-logs'))
      .map((url) => url.searchParams);
  const exportBodies = () =>
    fetchMock.mock.calls
      .filter(([input, init]) => input.endsWith('/audit-logs/export') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(init?.body as string) as unknown);
  return { fetchMock, listQueries, exportBodies };
}

function setNarrow(narrow: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: narrow && query.includes('max-width: 767.98px'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const ORG_PATH = `/o/${ORG.slug}/settings/audit`;

describe('organization audit log (T716)', () => {
  it('lists entries with names from refs, sources and the retention note', async () => {
    const { listQueries } = serve();
    await renderApp(ORG_PATH);
    const table = await screen.findByTestId('audit-table');
    const rows = within(table).getAllByTestId('audit-row');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('Phạm Ngọc Lan');
    expect(rows[0]).toHaveTextContent('Records · updated');
    expect(rows[0]).toHaveTextContent('in Orders');
    expect(rows[0]).toHaveTextContent('Chăm sóc khách hàng');
    expect(rows[1]).toHaveTextContent('via API token CRM sync');
    // A deleted user and a table removed for good: id + "deleted".
    expect(rows[2]).toHaveTextContent(`${GONE} (deleted)`);
    expect(rows[2]).toHaveTextContent('tbl_Gone000000000001 (deleted)');
    // A masked token: no name.
    expect(rows[3]).toHaveTextContent('via an API token');
    expect(screen.getByTestId('audit-retention')).toHaveTextContent(
      'Entries are kept for 180 days, then deleted.',
    );
    const first = listQueries()[0];
    expect(first?.get('include')).toBe('refs');
    // Default range: the last 7 days.
    expect(first?.get('from')).not.toBeNull();
    expect(screen.getByTestId('audit-filter-range')).toHaveTextContent('Last 7 days');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('"Load more" follows the cursor (no page numbers)', async () => {
    const { listQueries } = serve();
    await renderApp(ORG_PATH);
    await userEvent.click(await screen.findByTestId('audit-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row')).toHaveLength(5);
    });
    expect(listQueries().at(-1)?.get('cursor')).toBe('cur_2');
    expect(screen.queryByTestId('audit-load-more')).toBeNull();
    expect(screen.getByText(/5 entries shown · No more entries\./u)).toBeVisible();
  });

  it('filters by person and action group (repeatable query values)', async () => {
    const { listQueries } = serve();
    const { router } = await renderApp(ORG_PATH);
    await screen.findByTestId('audit-table');
    await userEvent.click(screen.getByTestId('audit-filter-people'));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Phạm Ngọc Lan/u }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('audit-filter-action'));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Records' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      const last = listQueries().at(-1);
      expect(last?.getAll('actor_id')).toEqual([SALES]);
      expect(last?.getAll('action_prefix')).toEqual(['record.']);
    });
    expect(router.state.location.search).toContain(`actor=${SALES}`);
    expect(screen.getByTestId('audit-filter-people')).toHaveTextContent('Phạm Ngọc Lan');
    expect(screen.getByTestId('audit-filter-action')).toHaveTextContent('Records');
  });

  it('opens the details with the keyboard: diff by field name, values as text; Esc returns focus', async () => {
    serve();
    await renderApp(ORG_PATH);
    const table = await screen.findByTestId('audit-table');
    const openers = within(table).getAllByRole('button', { name: /^Details: /u });
    openers[0]?.focus();
    // Arrow keys move between entries.
    await userEvent.keyboard('{ArrowDown}');
    expect(openers[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(openers[0]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const drawer = await screen.findByTestId('audit-drawer');
    const rows = within(drawer).getAllByTestId('audit-diff-row');
    expect(rows[0]).toHaveTextContent('amount');
    expect(within(rows[0] as HTMLElement).getByTestId('audit-diff-before')).toHaveTextContent(
      '100',
    );
    expect(within(rows[0] as HTMLElement).getByTestId('audit-diff-after')).toHaveTextContent('150');
    // A stored value that looks like HTML is text, never markup.
    expect(rows[1]).toHaveTextContent('Ghi chú');
    expect(rows[1]).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(drawer.querySelector('img')).toBeNull();
    expect(within(drawer).getByTestId('audit-detail-ip')).toHaveTextContent('203.0.113.7');
    expect(within(drawer).getByTestId('audit-detail-ua')).toHaveTextContent('Mozilla/5.0 Test');
    expect(within(drawer).getByTestId('audit-detail-batch')).toHaveTextContent(
      'req_Batch0000000001',
    );
    expect(await axeViolations(document.body)).toEqual([]);
    // jsdom has no native dialog close on Escape: the close button stands in for it.
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }),
    );
    await waitFor(() => {
      expect(openers[0]).toHaveFocus();
    });
  });

  it('"Show the same batch" filters by batch_id and shows a removable chip', async () => {
    const { listQueries } = serve();
    await renderApp(ORG_PATH);
    const table = await screen.findByTestId('audit-table');
    const [first] = within(table).getAllByRole('button', { name: /^Details: /u });
    if (first === undefined) throw new Error('no entry');
    await userEvent.click(first);
    await userEvent.click(await screen.findByTestId('audit-same-batch'));
    await waitFor(() => {
      expect(listQueries().at(-1)?.get('batch_id')).toBe('req_Batch0000000001');
    });
    const chip = screen.getByTestId('audit-filter-removable');
    expect(chip).toHaveTextContent('Same batch: req_Batch0000000001');
    await userEvent.click(within(chip).getByRole('button', { name: /Remove the filter/u }));
    await waitFor(() => {
      expect(listQueries().at(-1)?.get('batch_id')).toBeNull();
    });
  });

  it('explains filters and retention when nothing matches', async () => {
    serve({ items: [], retention: 90 });
    await renderApp(`${ORG_PATH}?range=24h`);
    const empty = await screen.findByTestId('audit-empty');
    expect(empty).toHaveTextContent('No entries match these filters');
    expect(empty).toHaveTextContent('Try a longer time range or remove some filters.');
    expect(empty).toHaveTextContent('Entries older than 90 days are no longer kept.');
    expect(within(empty).getByRole('button', { name: 'Clear filters' })).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('exports a CSV: 202 job → progress → download link', async () => {
    const { exportBodies } = serve();
    await renderApp(`${ORG_PATH}?group=record.`);
    await screen.findByTestId('audit-table');
    await userEvent.click(screen.getByTestId('audit-export'));
    const link = await screen.findByTestId('audit-export-download', undefined, { timeout: 15_000 });
    expect(link).toHaveAttribute('href', '/api/v1/files/exports/job_0123456789ABCDEF');
    expect(screen.getByTestId('audit-export-status')).toHaveTextContent(
      'The CSV is ready: 1,234 entries.',
    );
    const body = exportBodies()[0] as { format: string; filters: Record<string, unknown> };
    expect(body.format).toBe('csv');
    expect(body.filters['action_prefix']).toEqual(['record.']);
    expect(body.filters).not.toHaveProperty('cursor');
    expect(body.filters).not.toHaveProperty('include');
  }, 30_000);

  it('a member who is not an owner/admin gets the 404 screen', async () => {
    serve({ orgRole: 'member' });
    await renderApp(ORG_PATH);
    expect(await screen.findByText(/not found/iu)).toBeVisible();
    expect(screen.queryByTestId('audit-table')).toBeNull();
  });
});

describe('base audit log (T716)', () => {
  it('shows only the base route, without the base column or filter; nav entry current', async () => {
    const { listQueries } = serve();
    await renderApp(`/b/${BASE}/settings/audit`);
    const table = await screen.findByTestId('audit-table');
    expect(within(table).queryByRole('columnheader', { name: 'Base' })).toBeNull();
    expect(screen.queryByTestId('audit-filter-base')).toBeNull();
    expect(listQueries().every((query) => !query.has('base_id'))).toBe(true);
    const nav = screen.getByRole('navigation', { name: 'Base settings' });
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('a base member who is not an admin gets the 404 screen', async () => {
    serve({ admin: false });
    await renderApp(`/b/${BASE}/settings/audit`);
    expect(await screen.findByText(/not found/iu)).toBeVisible();
    expect(screen.queryByTestId('audit-table')).toBeNull();
  });

  it('shows cards below 768 px', async () => {
    setNarrow(true);
    serve();
    await renderApp(`/b/${BASE}/settings/audit`);
    const cards = await screen.findByTestId('audit-cards');
    expect(within(cards).getAllByTestId('audit-row')).toHaveLength(4);
    expect(screen.queryByTestId('audit-table')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
