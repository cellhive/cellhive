import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, stubApi } from '../../../../../../test/app-harness';
import { axeViolations } from '../../../../../../test/axe';
import { createTestI18n } from '../../../../../../test/i18n';
import { createQueryClient } from '../../../../../lib/query/client';
import { keys } from '../../../../../lib/query/keys';
import { clearToasts } from '../../../../../lib/toast/toast';
import { FieldTools } from '../../../components/FieldTools';

import type { FieldToolRequest } from '../../../../../lib/schema/field-tools';
import type { FieldDto } from '@cellhive/contracts';

const TABLE = 'tbl_Tasks00000000001';
const BASE = 'bse_Base000000000001';
const NOW = '2026-10-17T00:00:00.000Z';
const OTHER = { id: 'usr_Other00000000001', email: 'ha@example.test', display_name: 'Trần Thu Hà' };

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
const OWNER = field('fld_Owner00000000001', { name: 'Owner', type: 'user', position: 2 });
const CREATOR = field('fld_Creator000000001', {
  name: 'Created by',
  type: 'created_by',
  position: 3,
});
const DUE = field('fld_Due0000000000001', {
  name: 'Due',
  type: 'datetime',
  position: 1,
  options: { style: { format: 'dd/MM/yyyy' }, default_value: null },
});

function baseWith(admin: boolean) {
  return {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_0123456789ABCDEF',
    owner_id: ME.user.id,
    name: 'Sales',
    icon: null,
    description: null,
    permission_version: 3,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    access: {
      role: null,
      is_admin: admin,
      base_rule: { copy: true, download: true, share_link: true },
      tables: admin
        ? {}
        : {
            [TABLE]: {
              perm: 'edit',
              operations: [],
              view_rule: { allow_edit: false, visible_views: null },
              read_scope: 'all',
              fields: {},
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
      dashboards: {},
    },
  };
}

function problem422(errors: unknown[]): Response {
  return new Response(
    JSON.stringify({
      type: 'https://cellhive.io/errors/VALIDATION_FAILED',
      title: 'Validation failed',
      status: 422,
      code: 'VALIDATION_FAILED',
      errors,
    }),
    { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

interface Options {
  readonly fields?: readonly FieldDto[];
  readonly admin?: boolean;
  readonly language?: 'en' | 'vi';
  readonly routes?: Record<string, (init: RequestInit | undefined) => Response>;
}

async function renderEdit(target: FieldDto, options: Options = {}) {
  const fields = options.fields ?? [TITLE, target, OWNER, CREATOR];
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(baseWith(options.admin ?? true)),
      [`GET /orgs/${ORG.id}`]: () =>
        json({ ...ORG, settings: { ...ORG.settings, timezone: 'Asia/Ho_Chi_Minh' } }),
      [`GET /orgs/${ORG.id}/members`]: () =>
        json({
          items: [
            { user: ME.user, role: 'owner', joined_at: NOW },
            { user: { ...OTHER, avatar_url: null }, role: 'member', joined_at: NOW },
          ],
          total: 2,
          offset: 0,
          limit: 1000,
        }),
      [`GET /bases/${BASE}/tables`]: () => json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE}/fields`]: () =>
        json({ items: fields, total: fields.length, offset: 0, limit: 1000 }),
      ...options.routes,
    },
  });
  const onClose = vi.fn();
  const i18n = await createTestI18n(options.language ?? 'en');
  const queryClient = createQueryClient();
  queryClient.setQueryData(keys.tableMeta(TABLE), { id: TABLE, base_id: BASE });
  const request: FieldToolRequest = { kind: 'edit', fieldId: target.id };
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: <FieldTools tableId={TABLE} fields={fields} request={request} onClose={onClose} />,
      },
    ],
    { initialEntries: [`/b/${BASE}/t/${TABLE}`] },
  );
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  const dialog = await screen.findByRole('dialog');
  const section = within(dialog).getByTestId('reminder-section');
  return { fetchMock, onClose, dialog, section: within(section), sectionElement: section };
}

function patchBody(fetchMock: ReturnType<typeof stubApi>): unknown {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => init?.method === 'PATCH' && url.startsWith(`/api/v1/fields/${DUE.id}`),
  );
  return call === undefined ? undefined : JSON.parse(call[1]?.body as string);
}

beforeEach(() => {
  // Only `Date` is fixed (the preview's example value); timers stay real for user-event.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  clearToasts();
});

describe('date reminder in the field dialog (T554)', () => {
  it('turns a reminder on: 1 day before at 09:00 in the field zone, to Owner; saves it', async () => {
    const { fetchMock, onClose, dialog, section, sectionElement } = await renderEdit(DUE, {
      routes: {
        [`PATCH /fields/${DUE.id}`]: (init) =>
          json({
            ...DUE,
            options: (JSON.parse(init?.body as string) as FieldDto).options,
            job_id: null,
          }),
      },
    });
    expect(section.getByRole('heading', { name: 'Reminder' })).toBeInTheDocument();
    expect(section.queryByLabelText('When to remind')).toBeNull();
    await userEvent.click(section.getByLabelText('Remind people of this date'));
    // The first person field is chosen; "1 day before"; the time of day in the field's zone.
    await waitFor(() => {
      expect(section.getByLabelText('Person field')).toHaveValue(OWNER.id);
    });
    expect(section.getByLabelText('When to remind')).toHaveValue('before');
    expect(section.getByLabelText('How long')).toHaveValue('1');
    expect(section.getByLabelText('Unit')).toHaveValue('days');
    // The limit in another unit only when it is not days (QA S5b L9).
    expect(section.getByText('Up to 30 days.')).toBeInTheDocument();
    await userEvent.selectOptions(section.getByLabelText('Unit'), 'hours');
    expect(section.getByText('Up to 30 days (720 in this unit).')).toBeInTheDocument();
    await userEvent.selectOptions(section.getByLabelText('Unit'), 'days');
    expect(section.getByLabelText('Time of day')).toHaveValue('09:00');
    expect(section.getAllByRole('option', { name: /^\d\d:\d\d$/u })).toHaveLength(48);
    await waitFor(() => {
      expect(
        section.getByText("In the field's time zone: Asia/Ho_Chi_Minh (the organization's)"),
      ).toBeInTheDocument();
    });
    // The next reminder for an example value (a week from now), shown in that zone and in mine.
    const preview = within(section.getByTestId('reminder-preview'));
    expect(
      preview.getByText(
        'A value of Oct 24, 2026 is reminded on Oct 23, 2026, 9:00 AM (Asia/Ho_Chi_Minh).',
      ),
    ).toBeInTheDocument();
    expect(
      preview.getByText('That is Oct 23, 2026, 2:00 AM in your time zone (UTC).'),
    ).toBeInTheDocument();
    expect(
      section.getByText(
        'Only people who can read the record, this field and, when it goes to a person field, that field too receive it. Reminders start when you turn this on: dates already passed are not reminded.',
      ),
    ).toBeInTheDocument();
    expect(await axeViolations(sectionElement)).toEqual([]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(patchBody(fetchMock)).toEqual({
      options: {
        style: { format: 'dd/MM/yyyy' },
        default_value: null,
        reminder: {
          offset_minutes: -1440,
          time_of_day: null,
          recipients: 'field_user',
          user_field_id: OWNER.id,
        },
      },
    });
  });

  it('reopens a saved reminder as it was; a field with a time has no time of day', async () => {
    const meeting = field('fld_Due0000000000001', {
      name: 'Meeting',
      type: 'datetime',
      position: 1,
      options: {
        style: { format: 'yyyy-MM-dd HH:mm' },
        timezone: 'Asia/Tokyo',
        reminder: {
          offset_minutes: -90,
          time_of_day: null,
          recipients: 'users',
          user_ids: [OTHER.id],
        },
      },
    });
    const { section } = await renderEdit(meeting);
    expect(section.getByLabelText('Remind people of this date')).toBeChecked();
    expect(section.getByLabelText('How long')).toHaveValue('90');
    expect(section.getByLabelText('Unit')).toHaveValue('minutes');
    expect(section.queryByLabelText('Time of day')).toBeNull();
    expect(section.getByText('Counted from the time of each value.')).toBeInTheDocument();
    expect(section.getByLabelText(/Specific members/u)).toBeChecked();
    expect(await section.findByText('Trần Thu Hà')).toBeInTheDocument();
    // Value 17:00 Tokyo on Oct 24 → 15:30 that day.
    expect(
      within(section.getByTestId('reminder-preview')).getByText(
        'A value of Oct 24, 2026, 5:00 PM is reminded on Oct 24, 2026, 3:30 PM (Asia/Tokyo).',
      ),
    ).toBeInTheDocument();
  });

  it('checks the form: amount, recipients; members are added and removed by keyboard', async () => {
    const { fetchMock, dialog, section } = await renderEdit(DUE);
    await userEvent.click(section.getByLabelText('Remind people of this date'));
    await userEvent.clear(section.getByLabelText('How long'));
    await userEvent.type(section.getByLabelText('How long'), '45');
    await userEvent.click(section.getByLabelText(/Specific members/u));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(section.getByText('Enter a whole number from 1 to 30.')).toBeInTheDocument();
    expect(section.getByLabelText('How long')).toHaveAttribute('aria-invalid', 'true');
    expect(section.getByText('Add at least one member.')).toBeInTheDocument();
    expect(patchBody(fetchMock)).toBeUndefined();

    await userEvent.selectOptions(section.getByLabelText('Unit'), 'hours');
    expect(section.queryByText(/Enter a whole number/u)).toBeNull();
    // Keyboard: pick a member in the select, Enter adds it.
    const select = section.getByLabelText('Choose a member');
    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(3);
    });
    await userEvent.selectOptions(select, OTHER.id);
    select.focus();
    await userEvent.keyboard('{Enter}');
    expect(section.getByRole('list', { name: '1 member chosen of 50' })).toHaveTextContent(
      'Trần Thu Hà',
    );
    expect(section.getByLabelText('Choose a member')).toHaveValue('');
    await userEvent.selectOptions(section.getByLabelText('Choose a member'), ME.user.id);
    await userEvent.click(section.getByRole('button', { name: 'Add' }));
    expect(section.getAllByTestId('reminder-member')).toHaveLength(2);
    await userEvent.click(section.getByRole('button', { name: 'Remove Trần Thu Hà' }));
    expect(section.getAllByTestId('reminder-member')).toHaveLength(1);
    expect(section.queryByText('Add at least one member.')).toBeNull();
  });

  it('places 422 details at their control, without the generic banner', async () => {
    let answer = problem422([
      { path: 'options.reminder.user_field_id', code: 'UNKNOWN_FIELD', message: 'x' },
    ]);
    const { dialog, section } = await renderEdit(DUE, {
      routes: { [`PATCH /fields/${DUE.id}`]: () => answer },
    });
    await userEvent.click(section.getByLabelText('Remind people of this date'));
    await waitFor(() => {
      expect(section.getByLabelText('Person field')).toHaveValue(OWNER.id);
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await section.findByText('This field no longer exists in the table. Choose another one.'),
    ).toBeInTheDocument();
    expect(section.getByLabelText('Person field')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText('Some settings need your attention.')).toHaveAttribute(
      'role',
      'alert',
    );
    expect(within(dialog).queryByText(/Request ID/u)).toBeNull();

    answer = problem422([
      { path: 'options.reminder.user_field_id', code: 'INVALID_FIELD_TYPE', message: 'x' },
    ]);
    await userEvent.selectOptions(section.getByLabelText('Person field'), CREATOR.id);
    expect(section.queryByText(/no longer exists/u)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await section.findByText(
        'This field is no longer a person field. Choose a User or Created by field.',
      ),
    ).toBeInTheDocument();

    answer = problem422([
      { path: 'options.reminder.user_ids[0]', code: 'USER_NOT_FOUND', message: 'x' },
    ]);
    await userEvent.click(section.getByLabelText(/Specific members/u));
    const select = section.getByLabelText('Choose a member');
    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(3);
    });
    await userEvent.selectOptions(select, OTHER.id);
    await userEvent.click(section.getByRole('button', { name: 'Add' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await section.findByText('Trần Thu Hà is not a member of this organization.'),
    ).toBeInTheDocument();
    expect(section.getByTestId('reminder-member')).toHaveAttribute('data-invalid', 'true');

    answer = problem422([
      { path: 'options.reminder.time_of_day', code: 'INVALID_VALUE', message: 'x' },
    ]);
    await userEvent.selectOptions(section.getByLabelText('Time of day'), '17:30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(section.getByLabelText('Time of day')).toHaveAttribute('aria-invalid', 'true');
    });
  });

  it('warns when the recipient field was deleted or changed type', async () => {
    const stale = {
      ...DUE,
      options: {
        ...DUE.options,
        reminder: {
          offset_minutes: 0,
          time_of_day: '08:00',
          recipients: 'field_user',
          user_field_id: 'fld_Gone000000000001',
        },
      },
    };
    const first = await renderEdit(stale);
    expect(
      await first.section.findByText(
        'The recipient field was deleted: this reminder is not sent. Choose another field.',
      ),
    ).toBeInTheDocument();
    expect(first.section.getByLabelText('Person field')).toHaveValue('fld_Gone000000000001');
    expect(first.section.getByRole('option', { name: '(deleted field)' })).toBeInTheDocument();
    expect(first.section.getByLabelText('When to remind')).toHaveValue('at');
    expect(first.section.getByRole('option', { name: 'On the day' })).toBeInTheDocument();
  });

  it('names a recipient field converted to another type', async () => {
    const converted = field('fld_Owner00000000001', { name: 'Owner', type: 'text', position: 2 });
    const stale = {
      ...DUE,
      options: {
        ...DUE.options,
        reminder: {
          offset_minutes: -60,
          time_of_day: null,
          recipients: 'field_user',
          user_field_id: OWNER.id,
        },
      },
    };
    const { section } = await renderEdit(stale, { fields: [TITLE, stale, converted] });
    expect(
      await section.findByText(
        'The recipient field “Owner” is no longer a person field: this reminder is not sent. Choose another field.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a read-only summary to someone without schema rights', async () => {
    const saved = {
      ...DUE,
      options: {
        ...DUE.options,
        reminder: {
          offset_minutes: -1440,
          time_of_day: '09:00',
          recipients: 'field_user',
          user_field_id: OWNER.id,
        },
      },
    };
    const { section } = await renderEdit(saved, { admin: false });
    expect(await section.findByText('1 day before, at 09:00')).toBeInTheDocument();
    expect(
      section.getByText("Only people who can change this table's fields can set up its reminder."),
    ).toBeInTheDocument();
    expect(section.queryByLabelText('Remind people of this date')).toBeNull();
  });

  it('speaks Vietnamese', async () => {
    const { section } = await renderEdit(DUE, { language: 'vi' });
    expect(section.getByRole('heading', { name: 'Nhắc hạn' })).toBeInTheDocument();
    await userEvent.click(section.getByLabelText('Nhắc mọi người về ngày này'));
    expect(
      await section.findByText('Theo múi giờ của trường: Asia/Ho_Chi_Minh (của tổ chức)'),
    ).toBeInTheDocument();
    expect(
      section.getByText(
        'Chỉ người đọc được bản ghi, trường này và (khi gửi người trong một trường) cả trường đó mới nhận. Nhắc từ lúc bật, không nhắc cho ngày đã qua.',
      ),
    ).toBeInTheDocument();
    expect(section.getByRole('option', { name: 'Trước' })).toBeInTheDocument();
  });
});
