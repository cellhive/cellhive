import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { BASE_ID, FIELD, fieldList, NOW, TABLE_ID } from '../../../../../test/records';
import { clearToasts } from '../../../../lib/toast/toast';

/**
 * T915: the AI steps of the builder (FRONTEND §13.2, CONTRACTS §29.6) — in
 * the "add a step" menu only with AI available, disabled with the reason
 * without record values; their panels (prompt of the trigger record's
 * fields, the field set, the quota note) and what is saved.
 */

const AUTOMATION_ID = 'aut_Builder000000001';
const SELF = { id: ME.user.id, name: ME.user.display_name };

const AUTOMATION = {
  id: AUTOMATION_ID,
  base_id: BASE_ID,
  name: 'Triage',
  description: '',
  enabled: false,
  disabled_reason: null,
  version: 3,
  definition: {
    trigger: { type: 'record.created', table_id: TABLE_ID, skip_bulk: false },
    condition: null,
    actions: [],
  },
  run_as: SELF,
  run_as_since: NOW,
  created_by: SELF,
  created_at: NOW,
  updated_at: NOW,
};

function serve(ai: { available: boolean; record_data: boolean }) {
  const saved: unknown[] = [];
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () =>
        json({
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
                view_rule: { allow_edit: false, visible_views: null },
                read_scope: 'all',
                fields: {},
                option_edit_fields: [],
                file_download_fields: [],
              },
            },
            dashboards: {},
          },
        }),
      [`GET /orgs/${ORG.id}`]: () => json({ ...ORG, ai }),
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
      [`GET /tables/${TABLE_ID}/fields`]: () => json(fieldList()),
      [`GET /bases/${BASE_ID}/automations`]: () =>
        json({ items: [AUTOMATION], total: 1, offset: 0, limit: 1000 }),
      [`GET /automations/${AUTOMATION_ID}`]: () => json(AUTOMATION),
      [`PATCH /automations/${AUTOMATION_ID}`]: (init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        saved.push(body);
        return json({ ...AUTOMATION, ...body, version: 4 });
      },
    },
  });
  return saved;
}

const PAGE = `/b/${BASE_ID}/automations/${AUTOMATION_ID}`;

async function openMenu() {
  await renderApp(PAGE);
  await userEvent.click(await screen.findByTestId('add-step'));
  return screen.findByTestId('add-step-menu');
}

afterEach(() => {
  clearToasts();
});

describe('the AI steps (T915)', () => {
  it('are not in the menu without AI', async () => {
    serve({ available: false, record_data: false });
    const menu = await openMenu();
    expect(within(menu).getByTestId('add-update_record')).toBeVisible();
    expect(within(menu).queryByTestId('add-ai_generate_text')).toBeNull();
    expect(within(menu).queryByTestId('add-ai_classify')).toBeNull();
  });

  it('are disabled with the reason without record values (and the settings for admins)', async () => {
    serve({ available: true, record_data: false });
    const menu = await openMenu();
    for (const id of ['add-ai_generate_text', 'add-ai_classify']) {
      const item = within(menu).getByTestId(id);
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveTextContent('AI may not read record values');
      expect(item.querySelector('svg.lucide-sparkles')).not.toBeNull();
    }
    expect(within(menu).getByTestId('add-ai-settings')).toHaveAttribute(
      'href',
      `/o/${ORG.slug}/settings/ai`,
    );
  });

  it('classify: the input of the trigger record, the select it sets, saved as such', async () => {
    const saved = serve({ available: true, record_data: true });
    const menu = await openMenu();
    await userEvent.click(within(menu).getByTestId('add-ai_classify'));
    const panel = await screen.findByTestId('ai-classify-panel');
    await userEvent.click(
      within(panel).getByRole('button', { name: 'Insert a value into What to classify' }),
    );
    const values = await screen.findByRole('listbox', { name: 'Values for What to classify' });
    // The trigger record's fields only: no trigger data, no earlier step.
    expect(within(values).queryByRole('option', { name: /Trigger time/u })).toBeNull();
    await userEvent.click(within(values).getByRole('option', { name: 'Notes' }));
    expect(within(panel).getByTestId('ai-step-input')).toHaveTextContent('Notes');
    // Single select fields of the trigger table only.
    const target = within(panel).getByTestId('ai-step-target');
    expect(
      within(target)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose…', 'Status']);
    await userEvent.selectOptions(target, FIELD.status);
    expect(panel).toHaveTextContent('The AI answers one of: New, Done.');
    expect(within(panel).getByTestId('ai-step-quota')).toHaveTextContent(
      'this step fails and is not retried',
    );
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(screen.getByTestId('builder-save'));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      definition: {
        actions: [
          {
            id: 'act_1',
            type: 'ai_classify',
            config: {
              input: `{{ [${FIELD.notes}] }}`,
              instructions: null,
              target_field_id: FIELD.status,
            },
          },
        ],
      },
    });
  });

  it('generate text: no field to write by default, the card says so', async () => {
    serve({ available: true, record_data: true });
    const menu = await openMenu();
    await userEvent.click(within(menu).getByTestId('add-ai_generate_text'));
    const panel = await screen.findByTestId('ai-generate-text-panel');
    const target = within(panel).getByTestId('ai-step-target');
    expect(target).toHaveValue('');
    expect(
      within(target)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['No field: later steps use the text', 'Title', 'Notes']);
    expect(screen.getByTestId('step-act_1')).toHaveTextContent(
      'Output only: later steps place the text',
    );
    // An empty prompt is named by the save check.
    await userEvent.click(screen.getByTestId('builder-save'));
    expect(await within(panel).findByText('Choose a value.')).toBeInTheDocument();
  });
});
