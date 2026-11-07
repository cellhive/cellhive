import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ORG, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import { untrackAllJobs } from '../../../lib/realtime/jobs';
import { clearToasts } from '../../../lib/toast/toast';
import { FieldTools } from '../components/FieldTools';

import type { FieldToolRequest } from '../../../lib/schema/field-tools';
import type { FieldDto } from '@cellhive/contracts';

/**
 * T915: the AI part of the field dialog (FRONTEND §4.10, CONTRACTS §29.5) —
 * the "AI" group of the types, the templates, the preview of 5 rows, the
 * create body, "Generate for N existing rows?", "Remove AI".
 */

const TABLE = 'tbl_Tickets000000001';
const BASE = 'bse_Base000000000001';
const NOW = '2026-11-01T00:00:00.000Z';
const NEW = 'fld_New0000000000001';
const AI = {
  task: 'summarize',
  prompt: 'Summarize in one sentence: {{ [Mô tả] }}',
  instructions: null,
  auto_update: true,
  max_output_tokens: 300,
};

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

const TITLE = field('fld_Title00000000001', { name: 'Tiêu đề', is_primary: true });
const DESCRIPTION = field('fld_Desc000000000001', { name: 'Mô tả', position: 1 });
const SUMMARY = field('fld_Summary000000001', {
  name: 'Summary',
  position: 2,
  options: { style: { type: 'plain' }, default_value: null, ai: AI },
  ai_state: { queued: 0, failed: 0, paused: 0, paused_reason: null },
});
const FIELDS = [TITLE, DESCRIPTION, SUMMARY];

type Route = (init: RequestInit | undefined) => Response;

function body(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

async function renderTools(
  request: FieldToolRequest,
  { recordData = true, routes = {} }: { recordData?: boolean; routes?: Record<string, Route> } = {},
) {
  const queryClient = createQueryClient();
  queryClient.setQueryData(keys.tableMeta(TABLE), { id: TABLE, base_id: BASE });
  queryClient.setQueryData(keys.base(BASE), { organization_id: ORG.id });
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /orgs/${ORG.id}`]: () =>
        json({ ...ORG, ai: { available: true, record_data: recordData } }),
      [`GET /tables/${TABLE}/fields`]: () =>
        json({ items: FIELDS, total: FIELDS.length, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE}`]: () =>
        json({
          id: TABLE,
          base_id: BASE,
          name: 'Tickets',
          description: null,
          primary_field_id: TITLE.id,
          position: 0,
          schema_state: 'ready',
          created_at: NOW,
          updated_at: NOW,
        }),
      [`POST /tables/${TABLE}/records/query`]: () =>
        json({ records: [], total: 6, offset: 0, limit: 1 }),
      ...routes,
    },
  });
  const onClose = vi.fn();
  const i18n = await createTestI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <FieldTools tableId={TABLE} fields={FIELDS} request={request} onClose={onClose} />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  const dialog = await screen.findByRole('dialog');
  // AI availability comes with the organization; templates name a field of the table (the grid
  // has them cached in the app).
  await waitFor(() => {
    expect(queryClient.getQueryData(keys.org(ORG.id))).toBeDefined();
    expect(queryClient.getQueryData(keys.fields(TABLE))).toBeDefined();
  });
  return { fetchMock, onClose, dialog };
}

function calls(fetchMock: ReturnType<typeof stubApi>, method: string, path: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(`/api/v1${path}`),
  );
}

afterEach(() => {
  untrackAllJobs();
  clearToasts();
});

describe('the AI group of the types (T915)', () => {
  it('offers "AI field"; without record values it is disabled with the reason', async () => {
    const { dialog } = await renderTools({ kind: 'create' }, { recordData: false });
    const type = within(dialog).getByLabelText('Field type');
    const option = within(type).getByRole('option', { name: 'AI field (needs record values)' });
    expect(option).toBeDisabled();
    expect(option.closest('optgroup')).toHaveAttribute('label', 'AI');
    expect(within(dialog).getByTestId('ai-type-blocked')).toHaveTextContent(
      'does not allow it. Open Organization settings › AI',
    );
    expect(type).toHaveAccessibleDescription(/does not allow it/u);
  });

  it('summarizes: the template fills the prompt, previews 5 rows, then creates and generates', async () => {
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'create' },
      {
        routes: {
          [`POST /tables/${TABLE}/ai/field-preview`]: () =>
            json({
              items: [
                {
                  record_id: 'rec_A000000000000001',
                  input_preview: 'Summarize in one sentence: Máy in lỗi',
                  output: 'Máy in hỏng.',
                  error: null,
                },
                {
                  record_id: 'rec_A000000000000002',
                  input_preview: 'Summarize in one sentence: Wi-Fi rớt',
                  output: null,
                  error: { code: 'AI_TIMEOUT' },
                },
                {
                  record_id: 'rec_A000000000000003',
                  input_preview: 'Summarize in one sentence: Máy quét',
                  output: null,
                  error: { code: 'AI_PROVIDER_ERROR', reason: 'truncated' },
                },
                {
                  record_id: 'rec_A000000000000004',
                  input_preview: 'Summarize in one sentence: Két tiền',
                  output: null,
                  error: { code: 'AI_PROVIDER_ERROR', reason: 'http_status' },
                },
              ],
              estimate: { rows: 6, tokens: 480 },
            }),
          [`POST /tables/${TABLE}/fields`]: (init) =>
            json(field(NEW, { ...(body(init) as Partial<FieldDto>), position: 3 }), 201),
          [`POST /fields/${NEW}/ai/generate`]: () =>
            json({ job_id: 'job_Gen0000000000001', rows: 6, estimated_tokens: 480 }, 202),
          'GET /jobs/job_Gen0000000000001': () =>
            json({
              id: 'job_Gen0000000000001',
              type: 'ai.generate',
              status: 'running',
              progress: 0.5,
              result: null,
              error: null,
              created_at: NOW,
              started_at: NOW,
              finished_at: null,
            }),
        },
      },
    );
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Summary');
    await userEvent.selectOptions(within(dialog).getByLabelText('Field type'), 'ai');
    expect(within(dialog).getByRole('heading', { name: 'Fill with AI' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Summarize/u })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Text' })).toBeChecked();
    // No route editor here: the prompt in a text box, with the description field.
    expect(within(dialog).getByTestId('ai-prompt')).toHaveValue(
      'Summarize in one sentence: {{ [Mô tả] }}',
    );
    expect(await axeViolations(dialog)).toEqual([]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Preview 5 rows' }));
    const rows = await within(dialog).findAllByTestId('ai-preview-row');
    // The input without the instructions every row repeats; model text as plain text.
    expect(rows[0]).toHaveTextContent('Input: Máy in lỗi');
    expect(rows[0]).toHaveTextContent('Result: Máy in hỏng.');
    expect(rows[1]).toHaveTextContent('The AI took too long');
    // QA S8: what went wrong, not "the provider refused" for every provider error.
    expect(rows[2]).toHaveTextContent('The answer was cut off at its length limit');
    expect(rows[3]).toHaveTextContent('The AI provider answered with an error');
    expect(within(dialog).getByTestId('ai-preview-estimate')).toHaveTextContent(
      'Every row (6): about 480 tokens.',
    );
    expect(body(calls(fetchMock, 'POST', `/tables/${TABLE}/ai/field-preview`)[0]?.[1])).toEqual({
      field_id: null,
      type: 'text',
      choices: [],
      ai: AI,
    });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
    const generate = await screen.findByRole('dialog', {
      name: 'Generate values for 6 existing rows?',
    });
    expect(body(calls(fetchMock, 'POST', `/tables/${TABLE}/fields`)[0]?.[1])).toEqual({
      name: 'Summary',
      type: 'text',
      options: { style: { type: 'plain' }, default_value: null, ai: AI },
    });
    // The preview's average: 80 tokens a row.
    expect(within(generate).getByTestId('ai-generate-empty')).toHaveTextContent(
      '6 rows · about 480 tokens',
    );
    expect(await axeViolations(generate)).toEqual([]);
    await userEvent.click(within(generate).getByRole('button', { name: 'Generate' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(body(calls(fetchMock, 'POST', `/fields/${NEW}/ai/generate`)[0]?.[1])).toEqual({
      scope: 'empty',
    });
  });

  it('classifies into a single select: options are required, sent as a single select', async () => {
    const { fetchMock, dialog } = await renderTools(
      { kind: 'create' },
      {
        routes: {
          [`POST /tables/${TABLE}/fields`]: (init) =>
            json(field(NEW, { ...(body(init) as Partial<FieldDto>), position: 3 }), 201),
        },
      },
    );
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Mức độ');
    await userEvent.selectOptions(within(dialog).getByLabelText('Field type'), 'ai');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Classify/u }));
    expect(within(dialog).getByRole('radio', { name: 'Single select' })).toBeChecked();
    // A single select without a default: the AI picks.
    expect(within(dialog).queryByLabelText('Allow several options')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
    expect(
      within(dialog).getByText('Add at least one option for the AI to pick from.'),
    ).toBeInTheDocument();
    expect(calls(fetchMock, 'POST', `/tables/${TABLE}/fields`)).toHaveLength(0);
  });

  it('a saved AI field keeps its type; "Remove AI" sends `ai: null`', async () => {
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'edit', fieldId: SUMMARY.id },
      {
        routes: {
          [`PATCH /fields/${SUMMARY.id}`]: () => json({ ...SUMMARY, job_id: null }),
        },
      },
    );
    expect(within(dialog).getByTestId('type-locked')).toHaveTextContent('AI · Text');
    expect(within(dialog).getByText('Remove AI to change the type.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByTestId('ai-remove'));
    expect(within(dialog).getByTestId('ai-removed')).toHaveTextContent(
      'AI stops filling this field when you save.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(body(calls(fetchMock, 'PATCH', `/fields/${SUMMARY.id}`)[0]?.[1])).toEqual({
      options: { style: { type: 'plain' }, default_value: null, ai: null },
    });
  });
});
