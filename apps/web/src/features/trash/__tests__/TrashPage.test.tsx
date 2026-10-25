import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import {
  resetOwnChanges,
  takeOwnPermissionChange,
  takeOwnSchemaChange,
} from '../../../lib/realtime/own-changes';
import { clearToasts } from '../../../lib/toast/toast';

const BASE = 'bse_0123456789ABCDEF';
const TABLE = 'tbl_0123456789ABCDEF';
const PRIMARY = 'fld_Name000000000001';
const DELETED_FIELD = 'fld_Notes00000000001';
const CODE = 'fld_Code000000000001';
const TRASH_PATH = `/b/${BASE}/t/${TABLE}/trash`;
const DAY = 24 * 60 * 60 * 1000;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function tableAccess(kind: 'admin' | 'editor' | 'reader') {
  return {
    perm: kind === 'reader' ? 'read_only' : kind === 'admin' ? 'manage' : 'edit',
    operations: kind === 'reader' ? [] : ['add', 'delete'],
    view_rule: { allow_edit: kind === 'admin', visible_views: null },
    read_scope: 'all',
    fields: { [PRIMARY]: kind === 'reader' ? 'read' : 'edit' },
    option_edit_fields: [],
    file_download_fields: [],
  };
}

function baseDetail(kind: 'admin' | 'editor' | 'reader') {
  return {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_0123456789ABCDEF',
    owner_id: ME.user.id,
    name: 'Sales',
    icon: null,
    description: null,
    permission_version: 3,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    deleted_at: null,
    access: {
      role: null,
      is_admin: kind === 'admin',
      base_rule: { copy: true, download: true, share_link: true },
      tables: { [TABLE]: tableAccess(kind) },
      dashboards: {},
    },
  };
}

const TABLE_DTO = {
  id: TABLE,
  base_id: BASE,
  name: 'Orders',
  description: null,
  primary_field_id: PRIMARY,
  position: 0,
  schema_state: 'ready',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
};

function trashed(index: number, name: string | null, deletedAgo: number, by: string | null) {
  return {
    id: `rec_Trash0000000000${String(index)}`,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    version: 2,
    fields: {
      ...(name === null ? {} : { [PRIMARY]: name }),
      [CODE]: `ORD-000${String(index)}`,
    },
    deleted_at: ago(deletedAgo),
    deleted_by: by === null ? null : { id: 'usr_Deleter000000001', name: by },
  };
}

function field(id: string, name: string, deletedAt?: string) {
  return {
    id,
    table_id: TABLE,
    name,
    type: 'text',
    options: {},
    is_primary: id === PRIMARY,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...(deletedAt === undefined ? {} : { deleted_at: deletedAt }),
  };
}

function problem(status: number, code: string, errors: unknown[] = []) {
  return new Response(
    JSON.stringify({
      type: `https://cellhive.io/errors/${code}`,
      title: code,
      status,
      code,
      request_id: 'req_0123456789ABCDEF',
      errors,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

interface Server {
  kind: 'admin' | 'editor' | 'reader';
  records: ReturnType<typeof trashed>[];
  /** Answers of `POST …/records/restore`, in order; default: success. */
  restoreAnswers?: ((ids: string[]) => Response)[];
  fieldRestore?: () => Response;
  /** Answer of `POST …/records/trash/purge`; default: success. */
  purgeAnswer?: (ids: string[]) => Response;
}

function serve(server: Server) {
  const restoreCalls: string[][] = [];
  const purgeCalls: unknown[] = [];
  let trashCalls = 0;
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(baseDetail(server.kind)),
      [`GET /tables/${TABLE}`]: () => json(TABLE_DTO),
      [`GET /tables/${TABLE}/records/trash`]: () => {
        trashCalls += 1;
        return json({ records: server.records, next_cursor: null });
      },
      [`POST /tables/${TABLE}/records/restore`]: (init) => {
        const { ids } = JSON.parse(init?.body as string) as { ids: string[] };
        restoreCalls.push(ids);
        const answer = server.restoreAnswers?.shift();
        if (answer !== undefined) return answer(ids);
        server.records = server.records.filter((record) => !ids.includes(record.id));
        return json({ records: [] });
      },
      [`POST /tables/${TABLE}/records/trash/purge`]: (init) => {
        const body = JSON.parse(init?.body as string) as { ids: string[]; branch?: boolean };
        purgeCalls.push(body);
        if (server.purgeAnswer !== undefined) return server.purgeAnswer(body.ids);
        server.records = server.records.filter((record) => !body.ids.includes(record.id));
        return json({ ids: body.ids });
      },
      [`GET /tables/${TABLE}/fields`]: () =>
        json({
          items: [
            field(PRIMARY, 'Name'),
            { ...field(CODE, 'Code'), type: 'auto_number' },
            field(DELETED_FIELD, 'Notes', ago(29 * DAY + 60_000)),
          ],
          total: 3,
          offset: 0,
          limit: 1000,
        }),
      [`POST /fields/${DELETED_FIELD}/restore`]: () =>
        server.fieldRestore?.() ?? json(field(DELETED_FIELD, 'Notes')),
    },
  });
  return { fetchMock, restoreCalls, purgeCalls, trashCalls: () => trashCalls };
}

const RECORDS = () => [
  trashed(1, 'Order A', 60_000, 'Bình Trần'),
  trashed(2, 'Order B', 2 * DAY, null),
  trashed(3, null, 29 * DAY, 'Bình Trần'),
];

afterEach(() => {
  clearToasts();
  resetOwnChanges();
});

describe('TrashPage', () => {
  it('lists deleted records with deleter, time and days left; no axe violations', async () => {
    serve({ kind: 'admin', records: RECORDS() });
    await renderApp(TRASH_PATH);
    expect(await screen.findByRole('heading', { level: 1, name: 'Trash of Orders' })).toBeVisible();
    const table = await screen.findByRole('table', { name: 'Deleted records of Orders' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('Order A')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('Bình Trần')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('30 days left')).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText('System')).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText('2 days ago')).toBeVisible();
    // The primary field is empty: a placeholder title, with the record's code (not its id).
    expect(within(rows[2] as HTMLElement).getByText('Untitled record')).toBeVisible();
    expect(within(rows[2] as HTMLElement).getByText('ORD-0003')).toBeVisible();
    expect(screen.queryByText('rec_Trash00000000003')).not.toBeInTheDocument();
    // Tab counts (the names stay the tab labels).
    expect(screen.getByTestId('trash-count-records')).toHaveTextContent('3');
    expect(await screen.findByTestId('trash-count-fields')).toHaveTextContent('1');
    // One day left: warning.
    expect(within(rows[2] as HTMLElement).getByText('1 day left')).toHaveClass('text-warning');
    expect(screen.getByRole('link', { name: 'Back to table Orders' })).toHaveAttribute(
      'href',
      `/b/${BASE}/t/${TABLE}`,
    );
    expect(screen.getByRole('tab', { name: 'Fields' })).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('restores the selected records together and removes them from the list', async () => {
    const server = serve({ kind: 'editor', records: RECORDS() });
    await renderApp(TRASH_PATH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Select Order A' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Order B' }));
    const bar = screen.getByRole('region', { name: '2 records selected' });
    // Dark selection bar (design board), with "Clear selection" at its end.
    expect(bar).toHaveClass('bg-inverse', 'text-on-inverse');
    expect(within(bar).getByRole('button', { name: 'Clear selection' })).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(within(bar).getByRole('button', { name: 'Restore selected records' }));

    expect(await screen.findByText('2 records restored.')).toBeVisible();
    expect(server.restoreCalls).toEqual([['rec_Trash00000000001', 'rec_Trash00000000002']]);
    await waitFor(() => {
      expect(screen.queryByText('Order A')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Order B')).not.toBeInTheDocument();
    expect(screen.getByText('Untitled record')).toBeVisible();
    expect(screen.queryByRole('region', { name: /selected/u })).not.toBeInTheDocument();
    // The editor has no schema rights: no Fields tab.
    expect(screen.queryByRole('tab', { name: 'Fields' })).not.toBeInTheDocument();
  });

  it('keeps a record refused with UNIQUE_VIOLATION, with the reason on its row', async () => {
    const server = serve({
      kind: 'admin',
      records: RECORDS(),
      restoreAnswers: [
        () =>
          problem(422, 'UNIQUE_VIOLATION', [
            { path: 'ids[1]', code: 'UNIQUE_VIOLATION', message: 'taken' },
          ]),
      ],
    });
    await renderApp(TRASH_PATH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Select all loaded records' }));
    expect(screen.getByRole('region', { name: '3 records selected' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Restore selected records' }));

    expect(await screen.findByText('2 records restored.')).toBeVisible();
    expect(
      screen.getByText('1 record could not be restored. The reason is shown on its row.'),
    ).toBeVisible();
    expect(server.restoreCalls).toEqual([
      ['rec_Trash00000000001', 'rec_Trash00000000002', 'rec_Trash00000000003'],
      ['rec_Trash00000000001', 'rec_Trash00000000003'],
    ]);
    await waitFor(() => {
      expect(screen.queryByText('Order A')).not.toBeInTheDocument();
    });
    const button = screen.getByRole('button', { name: 'Restore Order B' });
    expect(button).toHaveAccessibleDescription(
      'Not restored: This value must be unique, and it is already used.',
    );
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('restores one record from its row', async () => {
    const server = serve({ kind: 'admin', records: RECORDS() });
    await renderApp(TRASH_PATH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore Order B' }));
    expect(await screen.findByText('1 record restored.')).toBeVisible();
    expect(server.restoreCalls).toEqual([['rec_Trash00000000002']]);
  });

  it('deletes selected records permanently after a destructive confirmation (T408)', async () => {
    const server = serve({ kind: 'admin', records: RECORDS() });
    await renderApp(TRASH_PATH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Select Order A' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Order B' }));
    await user.click(screen.getByRole('button', { name: 'Delete selected records permanently' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete 2 records permanently?',
    });
    expect(within(dialog).getByText(/This cannot be undone/u)).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
    // Cancel keeps everything.
    // The footer's Cancel (the close button in the corner has the same name).
    await user.click(
      within(dialog).getAllByRole('button', { name: 'Cancel' }).at(-1) as HTMLElement,
    );
    expect(server.purgeCalls).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Delete selected records permanently' }));
    const again = await screen.findByRole('dialog', { name: 'Delete 2 records permanently?' });
    await user.click(within(again).getByRole('button', { name: 'Delete 2 records permanently' }));
    expect(await screen.findByText('2 records deleted permanently.')).toBeVisible();
    expect(server.purgeCalls).toEqual([{ ids: ['rec_Trash00000000001', 'rec_Trash00000000002'] }]);
    await waitFor(() => {
      expect(screen.queryByText('Order A')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('region', { name: /selected/u })).not.toBeInTheDocument();
  });

  it('deletes one record with its branch from its row', async () => {
    const records = RECORDS();
    const withBranch = { ...(records[1] as ReturnType<typeof trashed>), branch_size: 2 };
    const server = serve({ kind: 'admin', records: [records[0], withBranch, records[2]] as never });
    await renderApp(TRASH_PATH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete Order B permanently' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete 1 record permanently?' });
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: 'Also delete the 2 sub-records deleted with them',
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete 3 records permanently' }));
    expect(await screen.findByText('1 record deleted permanently.')).toBeVisible();
    expect(server.purgeCalls).toEqual([{ ids: ['rec_Trash00000000002'], branch: true }]);
  });

  it('shows the error when the server refuses (403) and keeps the rows', async () => {
    serve({
      kind: 'admin',
      records: RECORDS(),
      purgeAnswer: () => problem(403, 'PERMISSION_DENIED'),
    });
    await renderApp(TRASH_PATH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete Order A permanently' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete 1 record permanently?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete 1 record permanently' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Order A')).toBeVisible();
  });

  it('hides "Delete permanently" without the schema right', async () => {
    serve({ kind: 'editor', records: RECORDS() });
    await renderApp(TRASH_PATH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Select Order A' }));
    expect(screen.getByRole('button', { name: 'Restore selected records' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /permanently/u })).not.toBeInTheDocument();
  });

  it('shows no restore controls and does not call the trash API without delete rights', async () => {
    const server = serve({ kind: 'reader', records: RECORDS() });
    await renderApp(TRASH_PATH);
    expect(
      await screen.findByRole('heading', { name: 'No access to deleted records' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /Restore/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Fields' })).not.toBeInTheDocument();
    expect(server.trashCalls()).toBe(0);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('lists deleted fields for schema managers and restores one', async () => {
    serve({ kind: 'admin', records: [] });
    await renderApp(`${TRASH_PATH}?tab=fields`);
    const tab = await screen.findByRole('tab', { name: 'Fields' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    const table = await screen.findByRole('table', { name: 'Deleted fields of Orders' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Notes')).toBeVisible();
    expect(within(table).getByText('1 day left')).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Restore field Notes' }));
    expect(await screen.findByText('Field Notes restored with its data.')).toBeVisible();
  });

  it('announces the schema.changed and permission.changed a field restore causes (own-changes.ts)', async () => {
    // Restoring a field bumps `permission_version` (SchemaService.restoreField),
    // same as creating or deleting one: the realtime channel must skip its own
    // `schema.changed`/`permission.changed`, or it refetches what the mutation's
    // `onSuccess` already refetched (the ~14-requests regression `own-changes.ts` guards against).
    serve({ kind: 'admin', records: [] });
    await renderApp(`${TRASH_PATH}?tab=fields`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore field Notes' }));
    expect(await screen.findByText('Field Notes restored with its data.')).toBeVisible();
    expect(takeOwnSchemaChange(TABLE)).toBe(true);
    expect(takeOwnPermissionChange([TABLE])).toBe(true);
  });

  it('explains when a deleted field can no longer be restored (404)', async () => {
    serve({ kind: 'admin', records: [], fieldRestore: () => problem(404, 'NOT_FOUND') });
    await renderApp(`${TRASH_PATH}?tab=fields`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore field Notes' }));
    expect(
      await screen.findByText(
        'Field Notes can no longer be restored: it was deleted more than 30 days ago.',
      ),
    ).toBeVisible();
    // A refused restore causes no message: the announcement is retracted, not left dangling.
    expect(takeOwnSchemaChange(TABLE)).toBe(false);
    expect(takeOwnPermissionChange([TABLE])).toBe(false);
  });

  it('moves between tabs with the arrow keys', async () => {
    serve({ kind: 'admin', records: [] });
    await renderApp(TRASH_PATH);
    expect(await screen.findByRole('heading', { name: 'The trash is empty' })).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Records' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Fields' })).toHaveFocus();
    expect(await screen.findByRole('table', { name: 'Deleted fields of Orders' })).toBeVisible();
  });

  it('shows the 404 screen for a table of another base', async () => {
    serve({ kind: 'admin', records: [] });
    await renderApp(`/b/bse_Other00000000001/t/${TABLE}/trash`);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
