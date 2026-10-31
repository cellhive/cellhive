import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { browserTimeZone } from '../../../lib/i18n/format';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import AskAiPanel from '../AskAiPanel';
import { clearSessions } from '../model/session';

import type { AskAnswerWidgetProps } from '../../../lib/ai/ask';
import type { FieldDto } from '@cellhive/contracts';

/**
 * T914: the "Ask AI" panel (CONTRACTS §29.4) with a stand-in for the
 * dashboard's widget renderer (its own test: `AnswerWidget.test.tsx`) — the
 * question and the browser's zone are sent; an answer shows its title, the
 * interpretation chips with translated enums, the widget, the narrative as
 * plain text; "Couldn't answer this yet" names no field; errors in their own
 * words with "Try again" when it helps; Enter, Shift+Enter, Escape; "Cancel";
 * the session's questions stay when the panel closes.
 */

const ORG_ID = 'org_0123456789ABCDEF';
const USER_ID = 'usr_0123456789ABCDEF';
const TABLE = { id: 'tbl_Orders0000000001', name: 'Orders' };
const NOW = '2026-10-31T00:00:00.000Z';

const field = (id: string, name: string, type: string, options: unknown = {}) =>
  ({ id, name, type, options }) as unknown as FieldDto;
const FIELDS = [
  field('fld_Title00000000001', 'title', 'text'),
  field('fld_Amount0000000001', 'amount', 'number'),
  field('fld_Date000000000001', 'ngày', 'datetime'),
  field('fld_Status0000000001', 'status', 'select', {
    options: [{ id: 'opt_New0000000000001', name: 'Mới' }],
  }),
  field('fld_Secret0000000001', 'cost', 'number'),
];

const answer = (overrides: Record<string, unknown> = {}) => ({
  status: 'ok',
  interpretation: {
    metric: 'sum',
    field: { id: 'fld_Amount0000000001', name: 'amount' },
    dimension: { id: 'fld_Date000000000001', name: 'ngày' },
    bucket: 'month',
    series: null,
    series_bucket: null,
    filter_logic: 'and',
    filters: [
      {
        field: { id: 'fld_Status0000000001', name: 'status' },
        operator: 'intersects',
        value: ['Mới'],
      },
    ],
    compare: null,
  },
  widget: {
    type: 'line',
    title: 'Revenue by month',
    config: {
      table_id: TABLE.id,
      metrics: [
        { id: 'm1', aggregation: 'sum', field: 'fld_Amount0000000001', label: null, color: null },
      ],
      dimension: { field: 'fld_Date000000000001', date_bucket: 'month', bucket_width: null },
    },
  },
  data: {
    status: 'ok',
    columns: [],
    rows: [[{ value: '2026-10-01', label: null }, 100]],
    computed_at: NOW,
    cache: 'miss',
    ignored_filters: [],
  },
  narrative: 'October brought <b>100</b>.\nThat is all.',
  ...overrides,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const problem = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ type: 'x', title: code, status, code, errors: [] }, status, headers);

function stubAsk(reply: (init: RequestInit) => Promise<Response>) {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
      if (init.method !== 'POST') return Promise.resolve(json({}, 404));
      calls.push({ path, body: JSON.parse(init.body as string) });
      return reply(init);
    }),
  );
  return calls;
}

/** The widget renderer stand-in: says what it was given. */
function FakeAnswer({ widget, data, fields }: AskAnswerWidgetProps) {
  return (
    <p data-testid="fake-answer">
      {widget.type}:{data.rows.length} rows:{fields.length} fields
    </p>
  );
}

async function renderPanel({
  recordData = false,
  language = 'en',
}: { recordData?: boolean; language?: 'en' | 'vi' } = {}) {
  const i18n = await createTestI18n(language);
  const client = createQueryClient();
  client.setQueryData(keys.org(ORG_ID), {
    id: ORG_ID,
    ai: { available: true, record_data: recordData },
  });
  client.setQueryData(keys.me(), { user: { id: USER_ID } });
  const onClose = vi.fn();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <AskAiPanel
          table={TABLE}
          fields={FIELDS}
          orgId={ORG_ID}
          onClose={onClose}
          Answer={FakeAnswer}
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  const panel = await screen.findByRole('dialog', {
    name: language === 'en' ? 'Ask AI' : 'Hỏi AI',
  });
  const input = within(panel).getByRole('textbox');
  await waitFor(() => {
    expect(input).toHaveFocus();
  });
  return { panel, input, onClose, unmount: view.unmount };
}

beforeEach(() => {
  clearSessions();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AskAiPanel (T914)', () => {
  it('starts with three suggestions from the schema and says what the AI reads', async () => {
    stubAsk(() => Promise.resolve(json(answer())));
    const { panel } = await renderPanel();
    expect(within(panel).getByText('About Orders')).toBeVisible();
    expect(
      within(panel)
        .getAllByTestId('ask-suggestion')
        .map((item) => item.textContent),
    ).toEqual([
      'Total amount by month',
      'How many Orders per status?',
      'Which status has the highest total amount?',
    ]);
    expect(within(panel).getByTestId('ask-privacy')).toHaveTextContent(
      'The AI reads the names of the fields you can see, never their values.',
    );
    expect(panel).toHaveAttribute('aria-modal', 'false');
    expect(await axeViolations(panel)).toEqual([]);
  });

  it('asks with Enter (the browser zone too) and shows the answer: chips, widget, plain narrative', async () => {
    const calls = stubAsk(() => Promise.resolve(json(answer())));
    const { panel, input } = await renderPanel({ recordData: true });
    expect(within(panel).getByTestId('ask-privacy')).toHaveTextContent(
      'and the totals of an answer to write a short summary',
    );
    await userEvent.type(input, 'Revenue by month{Enter}');
    const card = await within(panel).findByTestId('ask-answer');
    expect(calls).toEqual([
      {
        path: `/tables/${TABLE.id}/ai/ask`,
        body: { question: 'Revenue by month', timezone: browserTimeZone() },
      },
    ]);
    expect(input).toHaveValue('');
    expect(within(panel).getByTestId('ask-question')).toHaveTextContent('Revenue by month');
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent('Revenue by month');
    expect(
      within(within(card).getByTestId('ask-interpretation'))
        .getAllByRole('listitem')
        .map((chip) => chip.textContent),
    ).toEqual(['Sum of amount', 'By ngày, per month', 'status is any of Mới']);
    expect(within(card).getByTestId('fake-answer')).toHaveTextContent('line:1 rows:5 fields');
    // The model's words: plain text, line breaks kept, no markup.
    const narrative = within(card).getByTestId('ask-narrative');
    expect(narrative).toHaveTextContent('October brought <b>100</b>. That is all.');
    expect(narrative.querySelector('b')).toBeNull();
    expect(screen.getByTestId('ask-announcement')).toHaveTextContent('Answer: Revenue by month');
    expect(await axeViolations(panel)).toEqual([]);
  });

  it('without record data: no narrative, the interpretation all the same', async () => {
    stubAsk(() => Promise.resolve(json(answer({ narrative: null }))));
    const { panel, input } = await renderPanel();
    await userEvent.type(input, 'Revenue by month{Enter}');
    const card = await within(panel).findByTestId('ask-answer');
    expect(within(card).queryByTestId('ask-narrative')).toBeNull();
    expect(within(card).getByTestId('ask-interpretation')).toHaveTextContent('Sum of amount');
  });

  it('Shift+Enter is a new line; a suggestion asks at once', async () => {
    const calls = stubAsk(() => Promise.resolve(json(answer())));
    const { panel, input } = await renderPanel();
    await userEvent.type(input, 'Revenue{Shift>}{Enter}{/Shift}by month');
    expect(input).toHaveValue('Revenue\nby month');
    expect(calls).toEqual([]);
    await userEvent.clear(input);
    await userEvent.click(within(panel).getAllByTestId('ask-suggestion')[1] as HTMLElement);
    await within(panel).findByTestId('ask-answer');
    expect(calls[0]?.body).toMatchObject({ question: 'How many Orders per status?' });
  });

  it('Escape closes, from the box too', async () => {
    stubAsk(() => Promise.resolve(json(answer())));
    const { input, onClose } = await renderPanel();
    await userEvent.type(input, 'draft');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('waits with words and a skeleton; "Cancel" aborts and gives the question back', async () => {
    let aborted = false;
    stubAsk(
      (init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const { panel, input } = await renderPanel();
    await userEvent.type(input, 'Revenue by month{Enter}');
    const waiting = await within(panel).findByTestId('ai-waiting');
    expect(within(waiting).getByRole('status')).toHaveTextContent('Understanding the question…');
    expect(within(panel).getByTestId('ask-send')).toBeDisabled();
    expect(await axeViolations(panel)).toEqual([]);
    await userEvent.click(within(waiting).getByRole('button', { name: 'Cancel' }));
    expect(aborted).toBe(true);
    expect(within(panel).queryByTestId('ai-waiting')).toBeNull();
    expect(input).toHaveValue('Revenue by month');
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
  });

  it('"Couldn\'t answer this yet" is neutral: no field named', async () => {
    stubAsk(() => Promise.resolve(json({ status: 'unanswerable' })));
    const { panel, input } = await renderPanel();
    await userEvent.type(input, 'Total cost by month{Enter}');
    const card = await within(panel).findByTestId('ask-unanswerable');
    expect(card).toHaveTextContent("Couldn't answer this yet");
    for (const { name } of FIELDS) expect(card.textContent).not.toContain(name);
    await userEvent.click(within(card).getByRole('button', { name: 'Edit question' }));
    expect(input).toHaveValue('Total cost by month');
  });

  it.each([
    [
      'quota',
      () => problem('AI_QUOTA_EXCEEDED', 429, { 'Retry-After': '7200' }),
      "Your organization has used up today's AI quota. Try again in 2 hours.",
      false,
    ],
    [
      'timeout',
      () => problem('AI_TIMEOUT', 504),
      'The AI took longer than 90 seconds. Try again, or ask a simpler question.',
      true,
    ],
    [
      'AI not set up',
      () => problem('AI_NOT_CONFIGURED', 422),
      'AI is turned off or not set up for this organization.',
      false,
    ],
  ])('says the %s error in its own words', async (_name, reply, text, retry) => {
    const calls = stubAsk(() => Promise.resolve(reply()));
    const { panel, input } = await renderPanel();
    await userEvent.type(input, 'Revenue by month{Enter}');
    const card = await within(panel).findByTestId('ask-error');
    expect(within(card).getByTestId('ask-error-message')).toHaveTextContent(text);
    expect(screen.getByTestId('ask-announcement')).toHaveTextContent(text);
    const again = within(card).queryByRole('button', { name: 'Try again' });
    expect(again !== null).toBe(retry);
    if (again !== null) {
      vi.unstubAllGlobals();
      const next = stubAsk(() => Promise.resolve(json(answer())));
      await userEvent.click(again);
      await within(panel).findByTestId('ask-answer');
      // The failed try makes way for the new one.
      expect(within(panel).getAllByTestId('ask-entry')).toHaveLength(1);
      expect(next[0]?.body).toMatchObject({ question: 'Revenue by month' });
    } else {
      expect(calls).toHaveLength(1);
    }
    expect(await axeViolations(panel)).toEqual([]);
  });

  it('keeps the questions of the session when the panel closes and opens again', async () => {
    stubAsk(() => Promise.resolve(json(answer())));
    const first = await renderPanel();
    await userEvent.type(first.input, 'Revenue by month{Enter}');
    await within(first.panel).findByTestId('ask-answer');
    await userEvent.type(first.input, 'half typed');
    first.unmount();
    const second = await renderPanel();
    expect(within(second.panel).getAllByTestId('ask-entry')).toHaveLength(1);
    expect(within(second.panel).queryByTestId('ask-empty')).toBeNull();
    expect(second.input).toHaveValue('half typed');
  });

  it('reads in Vietnamese', async () => {
    stubAsk(() => Promise.resolve(json(answer())));
    const { panel, input } = await renderPanel({ language: 'vi' });
    expect(within(panel).getAllByTestId('ask-suggestion')[0]).toHaveTextContent(
      'Tổng amount theo tháng',
    );
    await userEvent.type(input, 'Doanh thu theo tháng{Enter}');
    const card = await within(panel).findByTestId('ask-answer');
    expect(within(card).getByText('Cách hiểu')).toBeVisible();
    expect(within(card).getByTestId('ask-interpretation')).toHaveTextContent(
      'Theo ngày, từng tháng',
    );
  });
});
