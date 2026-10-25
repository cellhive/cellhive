import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { BASE_ID, FIELD, fieldList, NOW, TABLE_ID } from '../../../../../test/records';
import { clearToasts } from '../../../../lib/toast/toast';

/**
 * T525: the `button.clicked` trigger in the builder (board "S5 · Automation
 * builder - trigger và điều kiện"): the button, who may click with the
 * warning of `read` (naming who it runs as), `enabled_when`, and the fields
 * of the condition some roles cannot read (Câu hỏi mở S5 #5).
 */

const AUTOMATION_ID = 'aut_Button0000000001';
const BUTTON = 'fld_Approve000000001';
const OTHER_BUTTON = 'fld_Other00000000001';
const SELF = { id: ME.user.id, name: ME.user.display_name };
const OTHER = { id: 'usr_Other00000000001', name: 'Trần Thu Hà' };

function button(id: string, name: string, automationId: string | null) {
  return {
    id,
    table_id: TABLE_ID,
    name,
    type: 'button',
    options: { label: name, color: 5, confirm: null },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 7,
    created_at: NOW,
    updated_at: NOW,
    button: {
      automation_id: automationId,
      automation_enabled: automationId !== null,
      min_permission: automationId === null ? null : 'edit',
    },
  };
}

function base() {
  return {
    id: BASE_ID,
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
      tables: {
        [TABLE_ID]: {
          perm: 'manage',
          operations: ['add', 'delete'],
          view_rule: { allow_edit: true, visible_views: null },
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

function automation(trigger: Record<string, unknown>) {
  return {
    id: AUTOMATION_ID,
    base_id: BASE_ID,
    name: 'Quick approve',
    description: '',
    enabled: true,
    disabled_reason: null,
    version: 2,
    definition: {
      trigger: {
        type: 'button.clicked',
        table_id: TABLE_ID,
        field_id: BUTTON,
        min_permission: 'edit',
        enabled_when: null,
        ...trigger,
      },
      condition: null,
      actions: [
        {
          id: 'act_1',
          type: 'update_record',
          config: {
            table_id: TABLE_ID,
            record_id: null,
            fields: { [FIELD.notes]: { literal: 'Ok' } },
          },
        },
      ],
    },
    run_as: OTHER,
    run_as_since: NOW,
    created_by: SELF,
    created_at: NOW,
    updated_at: NOW,
  };
}

const ROLES = {
  items: [
    {
      id: 'rol_Sales00000000001',
      base_id: BASE_ID,
      name: 'Sales',
      kind: 'custom',
      config: {
        tables: {
          [TABLE_ID]: {
            perm: 'read_only',
            field_rule: { mode: 'all_read', fields: { [FIELD.amount]: 'no_perm' } },
          },
        },
      },
      position: 3,
      assignments: [],
      created_at: NOW,
      updated_at: NOW,
    },
  ],
  total: 1,
  offset: 0,
  limit: 1000,
};

function serve(current: ReturnType<typeof automation>) {
  const patches: Record<string, unknown>[] = [];
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(base()),
      [`GET /orgs/${ORG.id}`]: () => json(ORG),
      [`GET /bases/${BASE_ID}/tables`]: () =>
        json({
          items: [
            {
              id: TABLE_ID,
              base_id: BASE_ID,
              name: 'Orders',
              description: null,
              primary_field_id: FIELD.title,
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
      [`GET /tables/${TABLE_ID}/fields`]: () =>
        json(
          fieldList([
            button(BUTTON, 'Approve', AUTOMATION_ID),
            button(OTHER_BUTTON, 'Escalate', 'aut_Elsewhere0000001'),
          ]),
        ),
      [`GET /bases/${BASE_ID}/roles`]: () => json(ROLES),
      [`GET /bases/${BASE_ID}/automations`]: () =>
        json({ items: [current], total: 1, offset: 0, limit: 1000 }),
      [`GET /automations/${AUTOMATION_ID}`]: () => json(current),
      [`PATCH /automations/${AUTOMATION_ID}`]: (init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        patches.push(body);
        return json({ ...current, ...body, version: current.version + 1, run_as: SELF });
      },
    },
  });
  return patches;
}

afterEach(() => {
  clearToasts();
});

describe('button.clicked in the builder (T525)', () => {
  it('picks the button, warns about readers, saves min_permission; no axe violations', async () => {
    const patches = serve(automation({}));
    await renderApp(`/b/${BASE_ID}/automations/${AUTOMATION_ID}`);
    const panel = await screen.findByTestId('button-trigger');
    const select = await within(panel).findByTestId('trigger-button-field');
    await waitFor(() => {
      expect(select).toHaveValue(BUTTON);
    });
    // Another automation runs from "Escalate": one automation per button (BUTTON_IN_USE).
    expect(
      within(select).getByRole('option', { name: 'Escalate (another automation runs from it)' }),
    ).toBeDisabled();
    const who = within(panel).getByRole('group', { name: 'Who can click' });
    expect(
      within(who).getByRole('radio', { name: /People who can edit the record/u }),
    ).toBeChecked();
    expect(screen.queryByTestId('button-read-warning')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(
      within(who).getByRole('radio', { name: /People who can view the record/u }),
    );
    // Saving moves run_as to the editor (ADR-25 §2): the warning names them.
    expect(screen.getByTestId('button-read-warning')).toHaveTextContent(
      `with the permissions of «${ME.user.display_name}»`,
    );
    await userEvent.click(screen.getByTestId('builder-save'));
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toMatchObject({
      definition: { trigger: { type: 'button.clicked', field_id: BUTTON, min_permission: 'read' } },
    });
  });

  it('names fields of enabled_when that some roles cannot read', async () => {
    serve(
      automation({
        min_permission: 'read',
        enabled_when: {
          op: 'and',
          items: [{ field: FIELD.amount, operator: 'gt', value: 0 }],
        },
      }),
    );
    await renderApp(`/b/${BASE_ID}/automations/${AUTOMATION_ID}`);
    // Unchanged: it still runs as the saved run_as.
    expect(await screen.findByTestId('button-read-warning')).toHaveTextContent(
      'with the permissions of «Trần Thu Hà»',
    );
    expect(await screen.findByTestId('button-hidden-fields')).toHaveTextContent(
      'cannot read Amount (roles: Sales)',
    );
  });

  it('starts a new automation on the button the field dialog named', async () => {
    serve(automation({}));
    const query = new URLSearchParams({
      trigger: 'button.clicked',
      table: TABLE_ID,
      field: OTHER_BUTTON,
      name: 'Escalate',
    });
    await renderApp(`/b/${BASE_ID}/automations/new?${query.toString()}`);
    const panel = await screen.findByTestId('button-trigger');
    expect(await within(panel).findByTestId('trigger-button-field')).toHaveValue(OTHER_BUTTON);
    expect(
      within(panel).getByRole('radio', { name: /People who can edit the record/u }),
    ).toBeChecked();
  });
});
