import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import { json, problem, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import {
  baseDetail,
  FIELD,
  fieldList,
  noteFields,
  record,
  recordId,
  TABLE_ID,
  type AccessKind,
} from '../../../../test/records';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import { clearToasts } from '../../../lib/toast/toast';
import { Toaster } from '../../../lib/toast/Toaster';
import { HistoryTimeline } from '../components/HistoryTimeline';

import type { BaseDetail, FieldDto, RecordHistoryEntry } from '@cellhive/contracts';

const RECORD = recordId(1);
const HISTORY_PATH = `GET /tables/${TABLE_ID}/records/${RECORD}/history`;
const REVERT_PATH = `POST /tables/${TABLE_ID}/records/${RECORD}/revert`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

let nextId = 1;
function entry(
  changes: RecordHistoryEntry['changes'],
  extra: Partial<RecordHistoryEntry> = {},
): RecordHistoryEntry {
  nextId += 1;
  return {
    id: `aud_${String(nextId).padStart(16, '0')}`,
    action: 'record.updated',
    created_at: minutesAgo(5),
    actor: { type: 'user', id: 'usr_Binh000000000001', name: 'Bình Trần' },
    via: null,
    batch: null,
    changes,
    ...extra,
  };
}

interface Server {
  entries: RecordHistoryEntry[];
  revert?: (body: { audit_id: string; version: number }) => Response;
}

function serve(server: Server) {
  const calls: { history: string[]; revert: unknown[] } = { history: [], revert: [] };
  stubApi({
    signedIn: true,
    routes: {
      [HISTORY_PATH]: () => {
        calls.history.push('GET');
        return json({ items: server.entries, next_cursor: null });
      },
      [REVERT_PATH]: (init) => {
        const body = JSON.parse(init?.body as string) as { audit_id: string; version: number };
        calls.revert.push(body);
        return server.revert?.(body) ?? json(record(1, {}, body.version + 1));
      },
      [`GET /tables/${TABLE_ID}/records/${RECORD}`]: () => json(record(1, {}, 9)),
    },
  });
  return calls;
}

async function renderTimeline(kind: AccessKind, fields = fieldList().items, fieldId?: string) {
  const i18n = await createTestI18n('en');
  const queryClient = createQueryClient();
  // The panel holds the record at version 7.
  queryClient.setQueryData(keys.record(TABLE_ID, RECORD), record(1, {}, 7));
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <HistoryTimeline
          base={baseDetail(kind) as unknown as BaseDetail}
          tableId={TABLE_ID}
          recordId={RECORD}
          fields={fields as unknown as FieldDto[]}
          fieldId={fieldId}
        />
        <Toaster />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { queryClient };
}

afterEach(() => {
  clearToasts();
});

describe('HistoryTimeline (T206)', () => {
  it('shows who changed what, when and from where; no axe violations', async () => {
    serve({
      entries: [
        entry({ [FIELD.status]: { from: 'New', to: 'Done' } }),
        entry(
          { [FIELD.amount]: { from: 1000, to: 2500 } },
          {
            actor: { type: 'automation', id: 'aut_Assign0000000001', name: 'Assign owner' },
            via: { automation_id: 'aut_Assign0000000001', run_id: 'run_0000000000000001' },
            created_at: minutesAgo(90),
          },
        ),
        entry(
          { [FIELD.notes]: { from: null, to: 'From the API' } },
          {
            actor: { type: 'api_token', id: 'tok_Sync000000000001', name: 'Nightly sync' },
            via: { api_token_id: 'tok_Sync000000000001' },
          },
        ),
        entry(
          { [FIELD.title]: { from: null, to: 'Order 1' } },
          {
            action: 'record.created',
            actor: { type: 'user', id: 'usr_Gone000000000001', name: null },
          },
        ),
      ],
    });
    await renderTimeline('admin');
    const timeline = await screen.findByRole('list', { name: 'Changes' });
    const items = within(timeline)
      .getAllByRole('listitem')
      .filter((item) => item.parentElement === timeline);
    expect(items).toHaveLength(4);

    const [first, second, third, fourth] = items as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(first).toHaveTextContent('Bình Trần changed Status');
    expect(first).toHaveTextContent('5 minutes ago');
    expect(within(first).getByText('5 minutes ago')).toHaveAttribute('title');
    expect(first).toHaveTextContent('In the app');
    // Before (struck through) → after.
    expect(within(first).getByText('New').closest('.line-through')).not.toBeNull();
    expect(within(first).getByText('Done')).toBeVisible();

    expect(second).toHaveTextContent('Assign owner changed Amount');
    expect(second).toHaveTextContent('Via an automation');
    expect(third).toHaveTextContent('Nightly sync changed Notes');
    expect(third).toHaveTextContent('Via an API token');
    // A deleted user is named by kind; a creation lists values without "before".
    expect(fourth).toHaveTextContent('Deleted user created this record');
    expect(within(fourth).getByText('Order 1')).toBeVisible();

    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('names a share link actor after its view (T316), else by kind', async () => {
    serve({
      entries: [
        entry(
          { [FIELD.notes]: { from: null, to: 'From a form' } },
          {
            action: 'record.created',
            actor: { type: 'share_link', id: 'shl_Form000000000001', name: 'Order form' },
            via: { share_link_id: 'shl_Form000000000001' },
          },
        ),
        entry(
          { [FIELD.notes]: { from: null, to: 'Hidden view' } },
          {
            action: 'record.created',
            actor: { type: 'share_link', id: 'shl_Gone000000000001', name: null },
            via: { share_link_id: 'shl_Gone000000000001' },
          },
        ),
      ],
    });
    await renderTimeline('admin');
    const timeline = await screen.findByRole('list', { name: 'Changes' });
    const [named, unnamed] = within(timeline)
      .getAllByRole('listitem')
      .filter((item) => item.parentElement === timeline) as [HTMLElement, HTMLElement];
    expect(named).toHaveTextContent('Share link of “Order form” created this record');
    expect(named).toHaveTextContent('Via a share link or form');
    expect(unnamed).toHaveTextContent('Share link created this record');
  });

  it('groups a paste of 12 cells into one item, collapsed, with its batch', async () => {
    const notes = noteFields(12);
    const changes = Object.fromEntries(
      notes.map((note, index) => [note.id, { from: null, to: `Value ${String(index + 1)}` }]),
    );
    serve({ entries: [entry(changes, { batch: { id: 'req_Paste0000000001', size: 3 } })] });
    await renderTimeline('admin', [...fieldList().items, ...notes]);
    const timeline = await screen.findByRole('list', { name: 'Changes' });
    expect(timeline).toHaveTextContent('Bình Trần changed 12 fields');
    expect(timeline).toHaveTextContent('Part of a change to 3 records');
    const changed = within(timeline).getByRole('list', { name: 'Changed fields' });
    expect(within(changed).getAllByRole('listitem')).toHaveLength(3);
    const more = within(timeline).getByRole('button', { name: 'Show all 12 changes' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.setup().click(more);
    expect(within(changed).getAllByRole('listitem')).toHaveLength(12);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('strikes through deleted options and users and leaves deleted fields out', async () => {
    serve({
      entries: [
        entry({
          [FIELD.status]: {
            from: { id: 'opt_Gone000000000001', name: null, deleted: true },
            to: 'Done',
          },
          [FIELD.owner]: {
            from: [{ id: 'usr_Left000000000001', name: null, deleted: true }],
            to: null,
          },
          // A field deleted since: not in the field list, not shown.
          fld_Deleted000000001: { from: 'a', to: 'b' },
        }),
      ],
    });
    await renderTimeline('admin');
    const timeline = await screen.findByRole('list', { name: 'Changes' });
    expect(timeline).toHaveTextContent('Bình Trần changed 2 fields');
    expect(within(timeline).getByText('Deleted option').tagName).toBe('S');
    expect(within(timeline).getByText('Deleted user').tagName).toBe('S');
    expect(within(timeline).getAllByRole('listitem', { hidden: false })).not.toHaveLength(0);
    expect(timeline).not.toHaveTextContent('Deleted0');
  });

  it.each([
    { kind: 'admin', field: FIELD.amount, shown: true },
    // `Status` is read-only for the editor.
    { kind: 'editor', field: FIELD.status, shown: false },
    { kind: 'editor', field: FIELD.amount, shown: true },
    { kind: 'reader', field: FIELD.amount, shown: false },
  ] as const)('restore button for $kind on $field: $shown', async ({ kind, field, shown }) => {
    serve({ entries: [entry({ [field]: { from: 1, to: 2 } })] });
    await renderTimeline(kind);
    await screen.findByRole('list', { name: 'Changes' });
    const button = screen.queryByRole('button', { name: 'Restore previous value' });
    if (shown) expect(button).toBeVisible();
    else expect(button).toBeNull();
  });

  it('restores after confirming, with the version held; the new entry appears', async () => {
    const server: Server = { entries: [entry({ [FIELD.amount]: { from: 1000, to: 2500 } })] };
    const target = server.entries[0] as RecordHistoryEntry;
    server.revert = (body) => {
      server.entries = [
        entry({ [FIELD.amount]: { from: 2500, to: 1000 } }, { via: { reverted_from: target.id } }),
        ...server.entries,
      ];
      return json(record(1, { [FIELD.amount]: 1000 }, body.version + 1));
    };
    const calls = serve(server);
    const { queryClient } = await renderTimeline('admin');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore previous value' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore the previous value?' });
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));

    expect(await screen.findByText('Previous value restored.')).toBeVisible();
    expect(calls.revert).toEqual([{ audit_id: target.id, version: 7 }]);
    const timeline = await screen.findByRole('list', { name: 'Changes' });
    await waitFor(() => {
      expect(timeline).toHaveTextContent('Bình Trần restored an earlier value');
    });
    expect(timeline).toHaveTextContent('Restored from an earlier change');
    expect(queryClient.getQueryData(keys.record(TABLE_ID, RECORD))).toMatchObject({ version: 8 });
  });

  it('409: the record changed since — conflict toast, latest record loaded, restore anyway', async () => {
    const server: Server = { entries: [entry({ [FIELD.amount]: { from: 1000, to: 2500 } })] };
    let answers = 0;
    server.revert = (body) => {
      answers += 1;
      if (answers === 1) {
        return new Response(
          JSON.stringify({
            type: 'https://cellhive.io/errors/VERSION_CONFLICT',
            title: 'VERSION_CONFLICT',
            status: 409,
            code: 'VERSION_CONFLICT',
            request_id: 'req_0123456789ABCDEF',
            errors: [
              {
                path: 'records[0].version',
                code: 'VERSION_CONFLICT',
                message: 'conflict',
                params: {
                  current_version: 9,
                  updated_by: { id: 'usr_Cuong00000000001', name: 'Cường Lê' },
                },
              },
            ],
          }),
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }
      return json(record(1, {}, body.version + 1));
    };
    const calls = serve(server);
    const { queryClient } = await renderTimeline('admin');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore previous value' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Restore the previous value?' })).getByRole(
        'button',
        { name: 'Restore' },
      ),
    );
    expect(await screen.findByText('Record changed since')).toBeVisible();
    expect(
      screen.getByText(
        'Cường Lê changed this record after its history was loaded. The latest values are shown now.',
      ),
    ).toBeVisible();
    expect(queryClient.getQueryData(keys.record(TABLE_ID, RECORD))).toMatchObject({ version: 9 });
    await user.click(screen.getByRole('button', { name: 'Restore anyway' }));
    await waitFor(() => {
      expect(calls.revert).toHaveLength(2);
    });
    expect(calls.revert[1]).toMatchObject({ version: 9 });
  });

  it('404: the change cannot be restored any more', async () => {
    serve({
      entries: [entry({ [FIELD.amount]: { from: 1000, to: 2500 } })],
      revert: () => problem('NOT_FOUND', 404),
    });
    await renderTimeline('admin');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore previous value' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Restore the previous value?' })).getByRole(
        'button',
        { name: 'Restore' },
      ),
    );
    expect(
      await screen.findByText(
        'This change can no longer be restored: the record or the change is not available anymore.',
      ),
    ).toBeVisible();
  });

  it('403: a refused revert explains by code', async () => {
    serve({
      entries: [entry({ [FIELD.amount]: { from: 1000, to: 2500 } })],
      revert: () => problem('FIELD_READ_ONLY', 403),
    });
    await renderTimeline('admin');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore previous value' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Restore the previous value?' })).getByRole(
        'button',
        { name: 'Restore' },
      ),
    );
    const toasts = await screen.findByRole('region', { name: /notifications/iu });
    await waitFor(() => {
      expect(within(toasts).getAllByRole('listitem')).toHaveLength(1);
    });
  });

  it('cell history asks for one field and leaves the field name out', async () => {
    const calls = serve({ entries: [entry({ [FIELD.amount]: { from: 1000, to: 2500 } })] });
    await renderTimeline('admin', fieldList().items, FIELD.amount);
    const timeline = await screen.findByRole('list', { name: 'Changes' });
    expect(within(timeline).queryByText('Amount', { selector: 'span.truncate' })).toBeNull();
    expect(calls.history).toHaveLength(1);
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string][] } };
    const url = fetchMock.mock.calls
      .map(([input]) => input)
      .find((input) => input.includes('/history'));
    expect(url).toContain(`field=${FIELD.amount}`);
  });

  it('T465: link and parent changes as chips; a revert says how many links were skipped', async () => {
    const LINK = 'fld_Customer00000001';
    const PARENT = 'fld_Parent0000000001';
    const extra = [
      {
        ...fieldList().items[5],
        id: LINK,
        name: 'Customer',
        type: 'link',
        options: { link_table: 'tbl_Customers0000001', allow_multiple: true },
        position: 6,
      },
      { ...fieldList().items[5], id: PARENT, name: 'Parent', type: 'parent', position: 7 },
    ] as unknown as Parameters<typeof fieldList>[0];
    const an = { id: 'rec_An00000000000001', title: 'An Phát' };
    const locked = { id: 'rec_Locked0000000001', title: null };
    const gone = { id: 'rec_Gone000000000001', title: null, deleted: true };
    const server: Server = {
      entries: [
        entry({ [LINK]: { from: [an, gone], to: [locked] } }),
        entry({ [PARENT]: { from: { id: recordId(2), title: 'Order 2' }, to: null } }),
      ],
      revert: (body) => json({ ...record(1, {}, body.version + 1), skipped: 1 }),
    };
    const calls = serve(server);
    const { queryClient } = await renderTimeline('admin', fieldList(extra).items);
    const links = await screen.findByTestId('history-links');
    expect(links).toHaveTextContent('linkedNo access');
    expect(links).toHaveTextContent('unlinkedAn Phát');
    expect(links).toHaveTextContent('unlinkedDeleted record');
    const timeline = screen.getByRole('list', { name: 'Changes' });
    expect(timeline).toHaveTextContent('changed Parent');
    expect(timeline).toHaveTextContent('Order 2');
    expect(await axeViolations(document.body)).toEqual([]);

    const user = userEvent.setup();
    const [linkRevert] = await screen.findAllByRole('button', { name: 'Restore previous value' });
    await user.click(linkRevert as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Restore the previous value?' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(
      await screen.findByText(
        'Previous value restored. 1 linked record was deleted and was not linked again.',
      ),
    ).toBeVisible();
    expect(calls.revert).toEqual([{ audit_id: server.entries[0]?.id, version: 7 }]);
    // `skipped` is not part of the cached record.
    expect(queryClient.getQueryData(keys.record(TABLE_ID, RECORD))).not.toHaveProperty('skipped');
  });

  it('says so when nothing changed yet', async () => {
    serve({ entries: [] });
    await renderTimeline('admin');
    expect(await screen.findByText('No changes yet.')).toBeVisible();
  });
});
