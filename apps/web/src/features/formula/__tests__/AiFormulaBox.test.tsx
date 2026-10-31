import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import { FormulaEditorDialog } from '../components/FormulaEditorDialog';

import { CUSTOMERS, id, SCHEMA } from './fixture';

/**
 * T913: "Describe the formula" above the formula editor (CONTRACTS §29.2) —
 * only with AI on and schema rights; the request carries the editor's text and
 * the formula field being edited; the suggestion (chips, result type,
 * explanation as plain text, tries) replaces the editor's text on "Use" and the
 * preview runs; its own sentences for the AI errors; "Cancel" aborts the wait.
 */

const BASE = 'bse_Customers0000001';
const ORG_ID = 'org_0123456789ABCDEF';
const COMMISSION = id('fld', 'Commission');

const answer = {
  formula: '[Doanh thu] * 2',
  result_type: { kind: 'number', list: false },
  explanation: 'Doubles the revenue. <b>not markup</b>',
  attempts: 2,
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

function stubFetch(reply: (init: RequestInit) => Promise<Response>) {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
      // Reads of the shell (`/me`…) are not this box's business.
      if (init.method !== 'POST') return Promise.resolve(json({}, 404));
      calls.push({ path, body: JSON.parse(init.body as string) });
      return reply(init);
    }),
  );
  return calls;
}

async function renderEditor({
  ai = true,
  perm = 'manage',
  fieldId,
  expression = '',
}: {
  ai?: boolean;
  perm?: 'manage' | 'edit';
  fieldId?: string;
  expression?: string;
} = {}) {
  const i18n = await createTestI18n('en');
  const client = createQueryClient();
  client.setQueryData(keys.formulaPreviewRows(CUSTOMERS), {
    records: [
      {
        id: id('rec', 'a'),
        version: 1,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
        fields: { [id('fld', 'CustName')]: 'An', [id('fld', 'CustRevenue')]: 1_500_000 },
      },
    ],
    total: null,
  });
  client.setQueryData(keys.tableMeta(CUSTOMERS), { id: CUSTOMERS, base_id: BASE });
  client.setQueryData(keys.base(BASE), {
    id: BASE,
    organization_id: ORG_ID,
    access: { is_admin: false, tables: { [CUSTOMERS]: { perm } } },
  });
  client.setQueryData(keys.org(ORG_ID), {
    id: ORG_ID,
    ai: { available: ai, record_data: false },
  });
  client.setQueryData(keys.fields(CUSTOMERS), {
    items: [{ id: COMMISSION, name: 'Commission', type: 'formula' }],
  });
  // The editor sits inside the field dialog's form: Enter in the box must not submit it.
  const fieldForm = vi.fn((event: { preventDefault: () => void }) => {
    event.preventDefault();
  });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <form onSubmit={fieldForm}>
          <FormulaEditorDialog
            tableId={CUSTOMERS}
            fieldId={fieldId as `fld_${string}` | undefined}
            fieldName="Commission"
            tableName="Khách hàng"
            schema={SCHEMA}
            timeZone="Asia/Ho_Chi_Minh"
            currency="VND"
            initial={{ expression, style: null, styleTouched: false }}
            onCancel={vi.fn()}
            onConfirm={() => Promise.resolve({ ok: true })}
          />
        </form>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { editor: await screen.findByTestId('formula-editor'), fieldForm };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AiFormulaBox (T913)', () => {
  it('writes a formula from a description; "Use" puts it in the editor and the preview runs', async () => {
    const calls = stubFetch(() => Promise.resolve(json(answer)));
    const { editor, fieldForm } = await renderEditor();
    const view = within(editor);
    const box = await view.findByTestId('formula-ai');
    expect(within(box).getByRole('button', { name: 'Write formula' })).toBeDisabled();
    await userEvent.type(
      within(box).getByRole('textbox', { name: 'Describe the formula' }),
      'twice the revenue{Enter}',
    );
    const card = await view.findByTestId('formula-ai-suggestion');
    expect(fieldForm).not.toHaveBeenCalled();
    expect(calls).toEqual([
      {
        path: `/tables/${CUSTOMERS}/ai/formula`,
        body: { description: 'twice the revenue', current: null, field_id: null },
      },
    ]);
    // Chips like the editor; the model's text stays plain text.
    expect(within(card).getByTestId('formula-ai-formula')).toHaveTextContent('Doanh thu * 2');
    expect(within(card).getByTestId('formula-ai-explanation')).toHaveTextContent(
      'Doubles the revenue. <b>not markup</b>',
    );
    expect(card.querySelector('b')).toBeNull();
    expect(within(card).getByText('Number')).toBeVisible();
    expect(within(card).getByTestId('formula-ai-attempts')).toHaveTextContent('Written in 2 tries');
    expect(screen.getByText('Suggested formula: [Doanh thu] * 2')).toHaveClass('sr-only');
    expect(await axeViolations(editor)).toEqual([]);

    await userEvent.click(within(card).getByRole('button', { name: 'Use' }));
    expect(view.queryByTestId('formula-ai-suggestion')).toBeNull();
    await waitFor(() => {
      expect(view.getByTestId('formula-preview-value')).toHaveTextContent('3,000,000');
    });
  });

  it('sends the text of the editor and the formula field being edited', async () => {
    const calls = stubFetch(() => Promise.resolve(json(answer)));
    const { editor } = await renderEditor({ fieldId: COMMISSION, expression: '[Số đơn] + 1' });
    await userEvent.type(
      await within(editor).findByTestId('formula-ai-description'),
      'add the revenue{Enter}',
    );
    await within(editor).findByTestId('formula-ai-suggestion');
    expect(calls[0]?.body).toEqual({
      description: 'add the revenue',
      current: '[Số đơn] + 1',
      field_id: COMMISSION,
    });
  });

  it.each([
    [
      'AI_INVALID_OUTPUT',
      422,
      'The AI could not write a valid formula in 3 tries. Describe it differently or name the fields to use.',
    ],
    [
      'AI_TIMEOUT',
      504,
      'The AI took longer than 90 seconds. Try again, or describe a smaller formula.',
    ],
    [
      'AI_QUOTA_EXCEEDED',
      429,
      "Your organization has used up today's AI quota. Try again in 3 hours.",
    ],
  ])('says %s in its own words, under the description', async (code, status, text) => {
    stubFetch(() =>
      Promise.resolve(
        json(
          { type: 'x', title: code, status, code, errors: [] },
          status,
          status === 429 ? { 'Retry-After': '10800' } : {},
        ),
      ),
    );
    const { editor } = await renderEditor();
    const input = await within(editor).findByTestId('formula-ai-description');
    await userEvent.type(input, 'something{Enter}');
    const error = await within(editor).findByTestId('formula-ai-error');
    expect(error).toHaveTextContent(text);
    expect(input).toHaveAttribute('aria-describedby', error.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('waits with words and "Cancel", which aborts the request', async () => {
    let aborted = false;
    stubFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const { editor } = await renderEditor();
    const input = await within(editor).findByTestId('formula-ai-description');
    await userEvent.type(input, 'something{Enter}');
    const waiting = await within(editor).findByTestId('ai-waiting');
    expect(within(waiting).getByRole('status')).toHaveTextContent('Writing the formula…');
    expect(within(waiting).getByRole('status')).toHaveTextContent(
      'AI can take up to 90 seconds to answer.',
    );
    await userEvent.click(within(waiting).getByRole('button', { name: 'Cancel' }));
    expect(aborted).toBe(true);
    expect(within(editor).queryByTestId('ai-waiting')).toBeNull();
    expect(within(editor).queryByTestId('formula-ai-error')).toBeNull();
    expect(input).toHaveFocus();
  });

  it.each([
    ['AI off', { ai: false }],
    ['no schema rights on the table', { perm: 'edit' as const }],
  ])('renders nothing with %s', async (_name, options) => {
    stubFetch(() => Promise.resolve(json(answer)));
    const { editor } = await renderEditor(options);
    expect(within(editor).getByTestId('formula-input')).toBeInTheDocument();
    expect(within(editor).queryByTestId('formula-ai')).toBeNull();
    expect(editor.querySelector('svg.lucide-sparkles')).toBeNull();
  });
});
