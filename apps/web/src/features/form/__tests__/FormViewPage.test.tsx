import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultView, json, ORG, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { viewSessions } from '../../../lib/views/session';

const BASE = 'bse_Sales00000000001';
const TABLE = 'tbl_Tickets000000001';
const NOW = '2026-09-24T00:00:00.000Z';
const TITLE = 'fld_Title00000000001';
const PRIORITY = 'fld_Priority00000001';
const NOTES = 'fld_Notes00000000001';

const FORM_VIEW = defaultView(TABLE, {
  id: 'viw_Form000000000001',
  name: 'Intake',
  type: 'form',
  config: {
    ...defaultView(TABLE).config,
    form: {
      title: 'Report a problem',
      description: '',
      cover_attachment_id: null,
      fields: [
        { field: TITLE, required: true, label: null, help: null },
        { field: PRIORITY, required: false, label: null, help: null },
        { field: NOTES, required: false, label: null, help: null },
      ],
      success_message: '',
      redirect_url: null,
      allow_multiple_submissions: true,
      require_login: false,
      submission_limit: 'none',
    },
  },
});

type Kind = 'admin' | 'member' | 'reader';

function base(kind: Kind) {
  const table = {
    perm: kind === 'reader' ? 'read_only' : 'edit',
    operations: kind === 'reader' ? [] : ['add'],
    view_rule: { allow_edit: false, visible_views: null },
    read_scope: 'all',
    fields: { [TITLE]: 'edit', [PRIORITY]: 'edit', [NOTES]: 'edit' },
    option_edit_fields: [],
    file_download_fields: [],
  };
  return {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_Sales00000000001',
    owner_id: 'usr_0123456789ABCDEF',
    name: 'Sales',
    icon: null,
    description: null,
    permission_version: 3,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    access: {
      role: null,
      is_admin: kind === 'admin',
      base_rule: { copy: true, download: true, share_link: true },
      tables: kind === 'admin' ? {} : { [TABLE]: table },
      dashboards: {},
    },
  };
}

function fieldDto(id: string, name: string, type: string, position: number, options = {}) {
  return {
    id,
    table_id: TABLE,
    name,
    type,
    options,
    is_primary: id === TITLE,
    required: id === TITLE,
    unique_values: false,
    description: null,
    position,
    created_at: NOW,
    updated_at: NOW,
  };
}

const fields = {
  items: [
    fieldDto(TITLE, 'Title', 'text', 0),
    fieldDto(PRIORITY, 'Priority', 'select', 1, {
      multiple: false,
      options: [
        { id: 'opt_High000000000001', name: 'High' },
        { id: 'opt_Low0000000000001', name: 'Low' },
      ],
    }),
    fieldDto(NOTES, 'Notes', 'text', 2),
  ],
  total: 3,
  offset: 0,
  limit: 1000,
};

const ASSIGNEE = 'fld_Assignee00000001';
const DUE = 'fld_Due0000000000001';

interface ServeOptions {
  /** `GET /views/:id/submission-status` answer (T320). */
  readonly status?: { limit: string; reached: boolean; next_allowed_at: string | null };
  /** Replaces the form settings of the view. */
  readonly form?: Record<string, unknown>;
}

function serve(kind: Kind, options: ServeOptions = {}) {
  const submissions: unknown[] = [];
  const formView = structuredClone(FORM_VIEW);
  if (options.form !== undefined) {
    Object.assign((formView.config as unknown as { form: object }).form, options.form);
  }
  const views = { [TABLE]: [defaultView(TABLE), formView] };
  const fetchMock = stubApi({
    signedIn: true,
    views,
    routes: {
      [`GET /bases/${BASE}`]: () => json(base(kind)),
      [`GET /bases/${BASE}/tables`]: () =>
        json({
          items: [
            {
              id: TABLE,
              base_id: BASE,
              name: 'Tickets',
              description: null,
              primary_field_id: TITLE,
              position: 0,
              schema_state: 'ready',
              created_at: NOW,
              updated_at: NOW,
            },
          ],
          total: 1,
          offset: 0,
          limit: 1000,
        }),
      [`GET /tables/${TABLE}`]: () =>
        json({
          id: TABLE,
          base_id: BASE,
          name: 'Tickets',
          description: null,
          primary_field_id: TITLE,
          position: 0,
          schema_state: 'ready',
          created_at: NOW,
          updated_at: NOW,
        }),
      [`GET /tables/${TABLE}/fields`]: () =>
        json({
          ...fields,
          items: [
            ...fields.items,
            fieldDto(ASSIGNEE, 'Assignee', 'user', 3, { multiple: false }),
            fieldDto(DUE, 'Due', 'datetime', 4, { style: { format: 'dd/MM/yyyy' } }),
          ],
          total: 5,
        }),
      // Only people who can open the base (never `GET /orgs/:id/members`).
      [`GET /bases/${BASE}/members`]: () =>
        json({
          items: [
            { id: 'usr_Minh000000000001', display_name: 'Nguyễn Minh', email: 'minh@x.test' },
            { id: 'usr_Lan0000000000001', display_name: 'Trần Lan', email: 'lan@x.test' },
            { id: 'usr_Lan0000000000002', display_name: 'Trần Lan', email: 'lan2@x.test' },
          ],
        }),
      [`GET /views/${FORM_VIEW.id}/submission-status`]: () =>
        json(options.status ?? { limit: 'none', reached: false, next_allowed_at: null }),
      [`POST /views/${FORM_VIEW.id}/submit`]: (init) => {
        submissions.push(JSON.parse(init?.body as string));
        return json({ success_message: 'Merci', redirect_url: null });
      },
    },
  });
  return { fetchMock, views, submissions };
}

const path = `/b/${BASE}/t/${TABLE}/v/${FORM_VIEW.id}`;

beforeEach(() => {
  viewSessions.reset();
});

afterEach(() => {
  window.localStorage.clear();
});

const SLOW = 30_000;

describe('form view page (T315)', () => {
  it(
    'an admin builds: moving a question and making it required saves the view config',
    async () => {
      const user = userEvent.setup();
      const { fetchMock, views } = serve('admin');
      await renderApp(path);
      expect(
        await screen.findByRole('button', { name: 'Build', pressed: true }, { timeout: 10_000 }),
      ).toBeVisible();
      const questions = () =>
        screen.getAllByTestId('form-builder-question').map((item) => item.dataset['field']);
      expect(questions()).toEqual([TITLE, PRIORITY, NOTES]);
      // The table-required field stays required and on the form.
      const title = screen.getAllByTestId('form-builder-question')[0];
      if (title === undefined) throw new TypeError('no question');
      expect(within(title).getByRole('checkbox', { name: 'Required' })).toBeDisabled();
      expect(
        within(title).getByRole('button', { name: /Title is required by the table/u }),
      ).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Move Notes up' }));
      expect(questions()).toEqual([TITLE, NOTES, PRIORITY]);
      const priority = screen.getAllByTestId('form-builder-question')[2];
      if (priority === undefined) throw new TypeError('no question');
      await user.click(within(priority).getByRole('checkbox', { name: 'Required' }));

      await waitFor(
        () => {
          const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
          expect(patches).toHaveLength(1);
        },
        { timeout: 3000 },
      );
      const saved = views[TABLE][1]?.config as unknown as {
        form: { fields: { field: string; required: boolean }[] };
      };
      expect(saved.form.fields.map((item) => [item.field, item.required])).toEqual([
        [TITLE, true],
        [NOTES, false],
        [PRIORITY, true],
      ]);
      expect(await axeViolations(document.body)).toEqual([]);
    },
    SLOW,
  );

  it(
    'a member fills in the form and submits it; the builder is not offered',
    async () => {
      const user = userEvent.setup();
      const { submissions } = serve('member');
      await renderApp(path);
      const title = await screen.findByRole('textbox', { name: /Title/u }, { timeout: 10_000 });
      expect(screen.queryByRole('button', { name: 'Build' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Submit' }));
      expect(title).toHaveAttribute('aria-invalid', 'true');
      expect(submissions).toEqual([]);
      await user.type(title, 'Printer jam');
      await user.click(screen.getByRole('radio', { name: 'Low' }));
      await user.click(screen.getByRole('button', { name: 'Submit' }));
      expect(await screen.findByText('Merci')).toBeVisible();
      expect(submissions).toEqual([{ fields: { [TITLE]: 'Printer jam', [PRIORITY]: 'Low' } }]);
    },
    SLOW,
  );

  it(
    'a reader sees the form with a notice that they cannot submit',
    async () => {
      serve('reader');
      await renderApp(path);
      expect(
        await screen.findByText(/your role does not let you add records/u, {}, { timeout: 10_000 }),
      ).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    },
    SLOW,
  );

  it(
    'opens on the limit screen when the member already reached the limit (T320)',
    async () => {
      const { fetchMock } = serve('member', {
        form: { require_login: true, submission_limit: 'daily', allow_multiple_submissions: false },
        status: { limit: 'daily', reached: true, next_allowed_at: '2026-09-26T17:00:00.000Z' },
      });
      await renderApp(path);
      expect(await screen.findByTestId('form-limit', {}, { timeout: 10_000 })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
      expect(fetchMock.mock.calls.some(([url]) => url.includes('/submission-status'))).toBe(true);
    },
    SLOW,
  );

  it(
    'user questions list people of the base by name; dates are typed as dd/mm/yyyy (T320)',
    async () => {
      const user = userEvent.setup();
      const { fetchMock, submissions } = serve('member', {
        form: {
          fields: [
            { field: TITLE, required: true, label: null, help: null },
            { field: ASSIGNEE, required: false, label: null, help: null },
            { field: DUE, required: false, label: null, help: null },
          ],
        },
      });
      await renderApp(path);
      const assignee = await screen.findByRole(
        'combobox',
        { name: 'Assignee' },
        { timeout: 10_000 },
      );
      await waitFor(() => {
        expect(within(assignee).getAllByRole('option')).toHaveLength(4);
      });
      // A name alone, the email only to tell two people with the same name apart.
      expect(
        within(assignee)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Choose…', 'Nguyễn Minh', 'Trần Lan (lan@x.test)', 'Trần Lan (lan2@x.test)']);
      expect(fetchMock.mock.calls.some(([url]) => /\/orgs\/[^/]+\/members/u.test(url))).toBe(false);
      const due = screen.getByRole('textbox', { name: 'Due' });
      expect(due).toHaveAttribute('placeholder', 'dd/mm/yyyy');
      await user.type(screen.getByRole('textbox', { name: /Title/u }), 'Printer');
      await user.selectOptions(assignee, 'usr_Minh000000000001');
      await user.type(due, '25/09/2026');
      await user.click(screen.getByRole('button', { name: 'Submit' }));
      await waitFor(() => {
        expect(submissions).toEqual([
          {
            fields: {
              [TITLE]: 'Printer',
              [ASSIGNEE]: [{ id: 'usr_Minh000000000001' }],
              [DUE]: '2026-09-25',
            },
          },
        ]);
      });
    },
    SLOW,
  );

  it(
    'the builder says an invalid redirect URL while typing and shows the save state (T320)',
    async () => {
      const user = userEvent.setup();
      const { fetchMock } = serve('admin');
      await renderApp(path);
      const redirect = await screen.findByTestId('form-redirect-url', {}, { timeout: 10_000 });
      await user.type(redirect, 'javascript:alert(1)');
      expect(
        await screen.findByText('Enter an address starting with http:// or https://.'),
      ).toBeVisible();
      expect(redirect).toHaveAttribute('aria-invalid', 'true');
      // Never saved.
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toEqual([]);

      await user.type(screen.getByRole('textbox', { name: 'Title' }), '!');
      expect(await screen.findByText('Saving…')).toBeVisible();
      expect(await screen.findByText('All changes saved', {}, { timeout: 3000 })).toBeVisible();
    },
    SLOW,
  );

  it(
    'removing a question moves the focus to the next one (T320)',
    async () => {
      const user = userEvent.setup();
      serve('admin');
      await renderApp(path);
      await user.click(
        await screen.findByRole(
          'button',
          { name: 'Remove Priority from the form' },
          { timeout: 10_000 },
        ),
      );
      const notes = screen
        .getAllByTestId('form-builder-question')
        .find((item) => item.dataset['field'] === NOTES);
      if (notes === undefined) throw new TypeError('no Notes question');
      await waitFor(() => {
        expect(notes.contains(document.activeElement)).toBe(true);
      });
    },
    SLOW,
  );
});
