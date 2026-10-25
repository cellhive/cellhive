import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ORG, problem, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import { untrackAllJobs } from '../../../lib/realtime/jobs';
import { clearToasts, useToasts } from '../../../lib/toast/toast';
import { FieldTools } from '../components/FieldTools';

import type { FieldToolRequest } from '../../../lib/schema/field-tools';
import type { FieldDto } from '@cellhive/contracts';
import type { S1FieldType } from '@cellhive/field-types';

const TABLE = 'tbl_Tickets000000001';
const NOW = '2026-09-24T00:00:00.000Z';
const OPEN = 'opt_Open000000000001';
const DONE = 'opt_Done000000000001';

function field(id: `fld_${string}`, overrides: Partial<FieldDto> = {}): FieldDto {
  return {
    id,
    table_id: TABLE,
    name: id,
    type: 'text',
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const TITLE = field('fld_Title00000000001', { name: 'Title', is_primary: true });
const STATUS = field('fld_Status0000000001', {
  name: 'Status',
  type: 'select',
  position: 1,
  options: {
    multiple: false,
    options: [
      { id: OPEN, name: 'Open', color: 1 },
      { id: DONE, name: 'Done', color: 2 },
    ],
  },
});
const TAGS = field('fld_Tags000000000001', {
  name: 'Tags',
  type: 'select',
  position: 2,
  options: { multiple: true, options: [] },
});
const FIELDS = [TITLE, STATUS, TAGS];

function problemWith(code: string, status: number, errors: unknown[] = []): Response {
  return new Response(
    JSON.stringify({
      type: `https://cellhive.io/errors/${code}`,
      title: code,
      status,
      code,
      errors,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Route = (init: RequestInit | undefined) => Response;

function ToastList() {
  const toasts = useToasts();
  return (
    <ul aria-label="toasts">
      {toasts.map((toast) => (
        <li key={toast.id}>{toast.message}</li>
      ))}
    </ul>
  );
}

async function renderTools(request: FieldToolRequest, routes: Record<string, Route> = {}) {
  const fetchMock = stubApi({ signedIn: true, routes });
  const onClose = vi.fn();
  const i18n = await createTestI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={createQueryClient()}>
        <FieldTools tableId={TABLE} fields={FIELDS} request={request} onClose={onClose} />
        <ToastList />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  const dialog = await screen.findByRole('dialog');
  return { fetchMock, onClose, dialog };
}

function bodyOf(fetchMock: ReturnType<typeof stubApi>, method: string, path: string): unknown {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(`/api/v1${path}`),
  );
  return call === undefined ? undefined : JSON.parse(call[1]?.body as string);
}

const created = (body: Record<string, unknown>) =>
  json(field('fld_New0000000000001', { ...(body as Partial<FieldDto>), position: 3 }), 201);

afterEach(() => {
  untrackAllJobs();
  clearToasts();
});

describe('FieldDialog (create)', () => {
  const TYPES: readonly S1FieldType[] = [
    'text',
    'number',
    'select',
    'datetime',
    'checkbox',
    'user',
    'created_at',
    'updated_at',
    'created_by',
    'updated_by',
    'auto_number',
  ];

  it.each(TYPES)('shows the %s options without serious axe violations', async (type) => {
    const { dialog } = await renderTools({ kind: 'create' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Field type'), type);
    expect(within(dialog).getByRole('heading', { name: 'Preview' })).toBeInTheDocument();
    expect(await axeViolations(dialog)).toEqual([]);
  });

  it('creates a field with the options of its type and closes', async () => {
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'create' },
      {
        [`POST /tables/${TABLE}/fields`]: (init) =>
          created(JSON.parse(init?.body as string) as Record<string, unknown>),
      },
    );
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Amount');
    await userEvent.selectOptions(within(dialog).getByLabelText('Field type'), 'number');
    await userEvent.selectOptions(within(dialog).getByLabelText('Format'), 'currency');
    await userEvent.selectOptions(within(dialog).getByLabelText('Currency'), 'VND');
    // The preview formats like the grid does.
    expect(within(dialog).getByText('₫1,235')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText('Required'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodyOf(fetchMock, 'POST', `/tables/${TABLE}/fields`)).toEqual({
      name: 'Amount',
      type: 'number',
      options: { style: { type: 'currency', currency_code: 'VND' }, default_value: null },
      required: true,
    });
  });

  it('starts a currency field with the currency of the organization (S2 QA)', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(keys.tableMeta(TABLE), {
      id: TABLE,
      base_id: 'bse_Base000000000001',
    });
    queryClient.setQueryData(keys.base('bse_Base000000000001'), { organization_id: ORG.id });
    stubApi({
      signedIn: true,
      routes: {
        [`GET /orgs/${ORG.id}`]: () =>
          json({
            ...ORG,
            settings: {
              locale: 'vi',
              timezone: 'Asia/Ho_Chi_Minh',
              currency: 'VND',
              public_sharing: 'allowed',
            },
          }),
      },
    });
    const i18n = await createTestI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <FieldTools
            tableId={TABLE}
            fields={FIELDS}
            request={{ kind: 'create' }}
            onClose={vi.fn()}
          />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(queryClient.getQueryData(keys.org(ORG.id))).toBeDefined();
    });
    await userEvent.selectOptions(within(dialog).getByLabelText('Field type'), 'number');
    await userEvent.selectOptions(within(dialog).getByLabelText('Format'), 'currency');
    expect(within(dialog).getByLabelText('Currency')).toHaveValue('VND');
  });

  it('inserts at a place: creates, then moves with PATCH position', async () => {
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'create', index: 1 },
      {
        [`POST /tables/${TABLE}/fields`]: (init) =>
          created(JSON.parse(init?.body as string) as Record<string, unknown>),
        'PATCH /fields/fld_New0000000000001': () =>
          json({ ...field('fld_New0000000000001', { position: 1 }), job_id: null }),
      },
    );
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Notes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodyOf(fetchMock, 'PATCH', '/fields/fld_New0000000000001')).toEqual({ position: 1 });
  });

  it('validates before sending: an empty name is not sent', async () => {
    const { fetchMock, dialog } = await renderTools({ kind: 'create' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
    expect(within(dialog).getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText('Required.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('shows NAME_CONFLICT on the name input', async () => {
    const { dialog } = await renderTools(
      { kind: 'create' },
      { [`POST /tables/${TABLE}/fields`]: () => problem('NAME_CONFLICT', 409) },
    );
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Status');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
    expect(
      await within(dialog).findByText('Another field of this table already has this name.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('explains FIELD_LIMIT_EXCEEDED with the limit, without retrying', async () => {
    const { fetchMock } = await renderTools(
      { kind: 'create' },
      {
        [`POST /tables/${TABLE}/fields`]: () =>
          problemWith('FIELD_LIMIT_EXCEEDED', 422, [
            { path: '', code: 'FIELD_LIMIT_EXCEEDED', message: 'limit', params: { limit: 500 } },
          ]),
      },
    );
    await userEvent.type(screen.getByLabelText('Name'), 'One more');
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    const limit = await screen.findByRole('dialog', { name: 'Too many fields' });
    expect(limit).toHaveTextContent('A table can have at most 500 fields, and this one is full.');
    expect(await axeViolations(limit)).toEqual([]);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
  });

  it('shows SCHEMA_LOCKED as a banner with a retry', async () => {
    let locked = true;
    const { onClose, dialog } = await renderTools(
      { kind: 'create' },
      {
        [`POST /tables/${TABLE}/fields`]: (init) =>
          locked
            ? problem('SCHEMA_LOCKED', 409)
            : created(JSON.parse(init?.body as string) as Record<string, unknown>),
      },
    );
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Notes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
    expect(
      await within(dialog).findByText(
        'The table structure is being updated. Your changes were not saved yet.',
      ),
    ).toBeInTheDocument();
    locked = false;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe('auto number rules builder', () => {
  it('previews the first numbers live', async () => {
    const { dialog } = await renderTools({ kind: 'create' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Field type'), 'auto_number');
    expect(within(dialog).getByText('NO.001, NO.002, NO.003')).toBeInTheDocument();
    const text = within(dialog).getByLabelText('Text of rule 1');
    await userEvent.clear(text);
    expect(within(dialog).getByText('Fill in every rule to see the numbers.')).toBeInTheDocument();
    await userEvent.type(text, 'TK-');
    await userEvent.selectOptions(within(dialog).getByLabelText('Digits of rule 2'), '4');
    expect(within(dialog).getByText('TK-0001, TK-0002, TK-0003')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move rule 2 up' }));
    expect(within(dialog).getByText('0001TK-, 0002TK-, 0003TK-')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(within(dialog).getByText('0001TK--, 0002TK--, 0003TK--')).toBeInTheDocument();
    expect(await axeViolations(dialog)).toEqual([]);
  });
});

const JOB = 'job_Remove0000000001';

describe('select options editor', () => {
  it('adds, renames, recolors and deletes options; deleted values go in a job', async () => {
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'edit', fieldId: STATUS.id },
      {
        [`PATCH /fields/${STATUS.id}`]: () => json({ ...STATUS, job_id: JOB }),
        [`GET /jobs/${JOB}`]: () =>
          json({
            id: JOB,
            type: 'schema.remove_select_options',
            status: 'running',
            progress: 0.5,
            result: null,
            error: null,
            created_at: '2026-09-24T00:00:00.000Z',
            started_at: '2026-09-24T00:00:00.000Z',
            finished_at: null,
          }),
      },
    );
    const rename = within(dialog).getByLabelText('Name of option 1');
    await userEvent.clear(rename);
    await userEvent.type(rename, 'New');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Color of Done: Leaf' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Pink' }));
    expect(within(dialog).getByRole('button', { name: 'Color of Done: Pink' })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add option' }));
    const added = within(dialog).getByLabelText('Name of option 3');
    expect(added).toHaveFocus();
    await userEvent.type(added, 'Waiting');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Done' }));
    expect(
      within(dialog).getByText(
        '1 option will be deleted. Records that use it lose this value; this runs in the background after you save.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Keep Done' })).toBeInTheDocument();
    expect(await axeViolations(dialog)).toEqual([]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodyOf(fetchMock, 'PATCH', `/fields/${STATUS.id}`)).toEqual({
      options: {
        multiple: false,
        options: [
          { id: OPEN, name: 'New', color: 1 },
          { name: 'Waiting', color: 2 },
        ],
        default_value: null,
      },
    });
    // The job named by the answer is followed: a toast with its progress.
    expect(
      screen.getByText('Removing the deleted option from records in the background.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url.startsWith(`/api/v1/jobs/${JOB}`))).toBe(
        true,
      );
    });
  });

  it('refuses duplicate option names before sending', async () => {
    const { fetchMock, dialog } = await renderTools({ kind: 'edit', fieldId: STATUS.id });
    const second = within(dialog).getByLabelText('Name of option 2');
    await userEvent.clear(second);
    await userEvent.type(second, 'Open');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Another option already has this name.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('offers a type change on a saved field (T414: previewed, see convert/__tests__)', async () => {
    const { dialog } = await renderTools({ kind: 'edit', fieldId: TAGS.id });
    expect(within(dialog).getByLabelText('Field type')).toBeEnabled();
    expect(within(dialog).getByTestId('type-current')).toHaveTextContent('Select');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('rename and delete', () => {
  it('renames, showing a taken name inline', async () => {
    let taken = true;
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'rename', fieldId: STATUS.id },
      {
        [`PATCH /fields/${STATUS.id}`]: () =>
          taken ? problem('NAME_CONFLICT', 409) : json({ ...STATUS, name: 'State', job_id: null }),
      },
    );
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Title');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(
      await within(dialog).findByText('Another field of this table already has this name.'),
    ).toBeInTheDocument();
    taken = false;
    await userEvent.clear(name);
    await userEvent.type(name, 'State');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodyOf(fetchMock, 'PATCH', `/fields/${STATUS.id}`)).toEqual({ name: 'Title' });
    expect(await axeViolations(dialog)).toEqual([]);
  });

  it('deletes after confirmation (to the trash)', async () => {
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'delete', fieldId: STATUS.id },
      { [`DELETE /fields/${STATUS.id}`]: () => new Response(null, { status: 204 }) },
    );
    expect(dialog).toHaveAccessibleName('Delete the field “Status”?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete field' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => init?.method === 'DELETE' && url.endsWith(`/fields/${STATUS.id}`),
      ),
    ).toBe(true);
    expect(screen.getByText('“Status” was moved to the trash.')).toBeInTheDocument();
  });

  it('does not delete the primary field', async () => {
    const { dialog } = await renderTools({ kind: 'delete', fieldId: TITLE.id });
    expect(within(dialog).getByRole('button', { name: 'Delete field' })).toBeDisabled();
  });

  it('translates a refusal of the server (403)', async () => {
    const { dialog } = await renderTools(
      { kind: 'delete', fieldId: STATUS.id },
      { [`DELETE /fields/${STATUS.id}`]: () => problem('PERMISSION_DENIED', 403) },
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete field' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You do not have permission to do this.',
    );
  });
});
