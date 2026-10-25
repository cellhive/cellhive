import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import { clearToasts } from '../../../lib/toast/toast';
import { FieldTools } from '../components/FieldTools';

import type { FieldToolRequest } from '../../../lib/schema/field-tools';
import type { FieldDto } from '@cellhive/contracts';

/**
 * T525: button fields in the field dialog (board "S5 · Button field - cấu
 * hình"): label, color, confirmation, preview; the automation card with
 * `min_permission` read-only and "Open in builder", or "Create an
 * automation for this button".
 */

const BASE = 'bse_Orders0000000001';
const TABLE = 'tbl_Orders0000000001';
const NOW = '2026-10-06T00:00:00.000Z';
const AUTOMATION = 'aut_Approve000000001';

const TITLE: FieldDto = {
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
};

function buttonField(
  automation: `aut_${string}` | null,
  minPermission: 'edit' | 'read' | null,
): FieldDto {
  return {
    ...TITLE,
    id: 'fld_Approve000000001',
    name: 'Quick approve',
    type: 'button',
    is_primary: false,
    position: 1,
    options: { label: 'Approve', color: 5, confirm: null },
    button: {
      automation_id: automation,
      automation_enabled: automation !== null,
      min_permission: minPermission,
    },
  };
}

const base = {
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
    is_admin: true,
    base_rule: { copy: true, download: true, share_link: true },
    tables: {},
    dashboards: {},
  },
};

const automation = {
  id: AUTOMATION,
  base_id: BASE,
  name: 'Approve the order',
  description: '',
  enabled: true,
  disabled_reason: null,
  version: 1,
  definition: {
    trigger: {
      type: 'button.clicked',
      table_id: TABLE,
      field_id: 'fld_Approve000000001',
      min_permission: 'read',
      enabled_when: {
        op: 'and',
        items: [{ field: 'fld_Title00000000001', operator: 'eq', value: 'Ready' }],
      },
    },
    condition: null,
    actions: [
      {
        id: 'act_1',
        type: 'update_record',
        config: { table_id: TABLE, record_id: null, fields: {} },
      },
      { id: 'act_2', type: 'delay', config: { minutes: 5 } },
    ],
  },
  run_as: { id: 'usr_Other00000000001', name: 'Trần Thu Hà' },
  run_as_since: NOW,
  created_by: { id: ME.user.id, name: ME.user.display_name },
  created_at: NOW,
  updated_at: NOW,
};

async function renderTools(
  request: FieldToolRequest,
  fields: readonly FieldDto[],
  routes: Record<string, (init: RequestInit | undefined) => Response> = {},
) {
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(base),
      [`GET /orgs/${ORG.id}`]: () => json(ORG),
      [`GET /bases/${BASE}/tables`]: () => json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /automations/${AUTOMATION}`]: () => json(automation),
      ...routes,
    },
  });
  const onClose = vi.fn();
  const i18n = await createTestI18n('en');
  const queryClient = createQueryClient();
  queryClient.setQueryData(keys.tableMeta(TABLE), { id: TABLE, base_id: BASE });
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
  return { fetchMock, onClose, dialog, router };
}

afterEach(() => {
  clearToasts();
});

describe('button fields in the field dialog (T525)', () => {
  it('creates a button with its label, color and confirmation; no axe violations', async () => {
    const posts: unknown[] = [];
    const { dialog, onClose } = await renderTools({ kind: 'create' }, [TITLE], {
      [`POST /tables/${TABLE}/fields`]: (init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        posts.push(body);
        return json({ ...buttonField(null, null), ...body }, 201);
      },
    });
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText('Name'), 'Quick approve');
    await user.selectOptions(within(dialog).getByLabelText('Field type'), 'button');
    const options = within(dialog).getByTestId('button-options');
    // The name is the label until one is typed; the preview shows both states.
    expect(within(options).getByLabelText('Label on the button')).toHaveAttribute(
      'placeholder',
      'Quick approve',
    );
    await user.type(within(options).getByLabelText('Label on the button'), 'Approve');
    await user.click(within(options).getByRole('radio', { name: 'Jade' }));
    await user.click(within(options).getByLabelText('Ask before running'));
    expect(within(options).getByLabelText('Title')).toHaveValue('Approve?');
    expect(within(options).getByLabelText('Text on the confirm button')).toHaveValue('Approve');
    await user.type(within(options).getByLabelText('Message'), 'It cannot be undone.');
    expect(within(dialog).getByText('When it cannot run')).toBeVisible();
    // A new button has no automation yet: saving first, then the builder.
    expect(within(dialog).getByText('No automation attached')).toBeVisible();
    expect(await axeViolations(dialog)).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Create field' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(posts).toEqual([
      {
        name: 'Quick approve',
        type: 'button',
        options: {
          label: 'Approve',
          color: 5,
          confirm: { title: 'Approve?', message: 'It cannot be undone.', confirm_label: 'Approve' },
        },
      },
    ]);
  });

  it('a new button: "Save and create an automation" opens the builder on it', async () => {
    const { dialog, router } = await renderTools({ kind: 'create' }, [TITLE], {
      [`POST /tables/${TABLE}/fields`]: (init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return json({ ...buttonField(null, null), ...body }, 201);
      },
    });
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText('Name'), 'Quick approve');
    await user.selectOptions(within(dialog).getByLabelText('Field type'), 'button');
    await user.click(within(dialog).getByTestId('button-create-automation'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE}/automations/new`);
    });
    const search = new URLSearchParams(router.state.location.search);
    expect(Object.fromEntries(search)).toEqual({
      trigger: 'button.clicked',
      table: TABLE,
      field: 'fld_Approve000000001',
      name: 'Quick approve',
    });
  });

  it('shows the attached automation, min_permission read-only, with the warning of read', async () => {
    const field = buttonField(AUTOMATION, 'read');
    const { dialog } = await renderTools({ kind: 'edit', fieldId: field.id }, [TITLE, field], {
      [`GET /tables/${TABLE}/fields`]: () =>
        json({ items: [TITLE, field], total: 2, offset: 0, limit: 1000 }),
    });
    const card = await within(dialog).findByTestId('button-automation');
    expect(await within(card).findByText('Approve the order')).toBeVisible();
    expect(within(card).getByText('On')).toBeVisible();
    expect(within(card).getByText('Trần Thu Hà')).toBeVisible();
    expect(within(card).getByTestId('button-min-permission')).toHaveTextContent(
      'People who can view the record',
    );
    // The condition and the steps, by name (board "S5 · Button field - cấu hình").
    await waitFor(() => {
      expect(within(card).getByTestId('button-enabled-when')).toHaveTextContent(
        'Title is equal to Ready',
      );
    });
    expect(within(card).getByText('Update record · Wait')).toBeVisible();
    // Read-only here: no control changes who may click.
    expect(within(card).queryByRole('radio')).toBeNull();
    expect(within(card).getByRole('note')).toHaveTextContent(
      'with the permissions of «Trần Thu Hà»',
    );
    expect(within(card).getByRole('link', { name: 'Open in builder' })).toHaveAttribute(
      'href',
      `/b/${BASE}/automations/${AUTOMATION}`,
    );
    // A button never changes type.
    expect(within(dialog).getByTestId('type-locked')).toHaveTextContent('Button');
    expect(await axeViolations(dialog)).toEqual([]);
  });

  it('offers to create the automation of a saved button', async () => {
    const field = buttonField(null, null);
    const { dialog } = await renderTools({ kind: 'edit', fieldId: field.id }, [TITLE, field]);
    const link = await within(dialog).findByRole('link', {
      name: 'Create an automation for this button',
    });
    const href = new URL(link.getAttribute('href') ?? '', 'http://localhost');
    expect(href.pathname).toBe(`/b/${BASE}/automations/new`);
    expect(href.searchParams.get('field')).toBe(field.id);
    expect(href.searchParams.get('name')).toBe('Approve');
  });
});
