import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { json, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { AiGenerateDialog } from '../../../lib/ai/AiGenerateDialog';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import { untrackAllJobs } from '../../../lib/realtime/jobs';
import { clearToasts } from '../../../lib/toast/toast';
import { AiPausedBanner } from '../ai/AiPausedBanner';

import type { AiPauseReason, FieldDto } from '@cellhive/contracts';
import type { ReactNode } from 'react';

/**
 * T915: the paused banner of AI fields (research S8 §5.6) — the reason,
 * "Resume" of the paused cells (T1002: `scope: paused`, never `empty`), one
 * sentence per thing the provider rejected, the settings link for
 * owners/admins only, the provider's wait — and the "Regenerate"
 * confirmation of the column menu (rows, tokens, overwrite).
 */

const TABLE = 'tbl_Tickets000000001';
const NOW = '2026-11-01T00:00:00.000Z';
const SUMMARY = 'fld_Summary000000001';
const PAUSED = 'rec_A000000000000001';

function summary(
  paused: number,
  reason: AiPauseReason | null,
  extra: Partial<NonNullable<FieldDto['ai_state']>> = {},
): FieldDto {
  return {
    id: SUMMARY,
    table_id: TABLE,
    name: 'Summary',
    type: 'text',
    options: {
      ai: {
        task: 'summarize',
        prompt: 'abcdef',
        instructions: null,
        auto_update: true,
        max_output_tokens: 100,
      },
    },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 3,
    created_at: NOW,
    updated_at: NOW,
    ai_state: {
      queued: 0,
      failed: 2,
      paused,
      paused_reason: reason,
      paused_detail: null,
      retry_at: null,
      ...extra,
    },
  };
}

async function renderWith(children: ReactNode) {
  const queryClient = createQueryClient();
  // A block of the grid: one paused cell, one current.
  queryClient.setQueryData(keys.recordBlock(TABLE, '{}', 1, 0), {
    records: [
      {
        id: PAUSED,
        created_at: NOW,
        updated_at: NOW,
        version: 1,
        fields: {},
        meta: { ai: { [SUMMARY]: { state: 'paused', reason: 'quota' } } },
      },
      {
        id: 'rec_A000000000000002',
        created_at: NOW,
        updated_at: NOW,
        version: 1,
        fields: {},
        meta: { ai: {} },
      },
    ],
    total: 2,
    offset: 0,
    limit: 200,
  });
  const i18n = await createTestI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const generated = () =>
  json({ job_id: 'job_Gen0000000000001', rows: 1, estimated_tokens: 102 }, 202);

afterEach(() => {
  untrackAllJobs();
  clearToasts();
});

describe('AiPausedBanner (T915)', () => {
  it('says why and resumes the paused cells (scope: paused, whatever the grid holds)', async () => {
    const fetchMock = stubApi({
      signedIn: true,
      routes: { [`POST /fields/${SUMMARY}/ai/generate`]: generated },
    });
    await renderWith(
      <AiPausedBanner
        tableId={TABLE}
        fields={[summary(3, 'quota')]}
        canManage
        settingsPath={null}
      />,
    );
    const banner = screen.getByTestId('ai-paused-banner');
    expect(banner).toHaveTextContent('“Summary”: 3 cells wait.');
    expect(banner).toHaveTextContent('AI quota for today is used up');
    expect(await axeViolations(banner)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url.includes('/ai/generate'))).toBe(true);
    });
    const call = fetchMock.mock.calls.find(([url]) => url.includes('/ai/generate'));
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ scope: 'paused' });
  });

  it.each([
    ['unauthorized', 'The AI provider rejected the API key.'],
    ['forbidden', 'The AI provider refused access with this API key.'],
    ['not_found', 'The AI provider does not know this URL or model.'],
    ['ssrf_blocked', 'The address of the AI provider is blocked.'],
    ['secret_host_not_allowed', 'The API key may not be sent to the host of the provider URL.'],
    ['secret_unavailable', 'The API key is missing or can no longer be read.'],
  ] as const)(
    'provider_error %s: its own sentence, "Resume" and the settings',
    async (detail, text) => {
      stubApi({ signedIn: true });
      await renderWith(
        <AiPausedBanner
          tableId={TABLE}
          fields={[summary(5, 'provider_error', { paused_detail: detail })]}
          canManage
          settingsPath="/o/acme/settings/ai"
        />,
      );
      const banner = screen.getByTestId('ai-paused-banner');
      expect(banner).toHaveTextContent('“Summary”: 5 cells wait.');
      expect(banner).toHaveTextContent(text);
      expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
      expect(screen.getByRole('link', { name: 'AI settings' })).toHaveAttribute(
        'href',
        '/o/acme/settings/ai',
      );
      expect(await axeViolations(banner)).toEqual([]);
    },
  );

  it('provider_error for a member: the reason, no settings link, no "Resume" without schema rights', async () => {
    stubApi({ signedIn: true });
    await renderWith(
      <AiPausedBanner
        tableId={TABLE}
        fields={[summary(2, 'provider_error', { paused_detail: 'unauthorized' })]}
        canManage={false}
        settingsPath={null}
      />,
    );
    expect(screen.getByTestId('ai-paused-banner')).toHaveTextContent(
      'The AI provider rejected the API key.',
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('says when generating goes on while the provider asked to wait', async () => {
    stubApi({ signedIn: true });
    await renderWith(
      <AiPausedBanner
        tableId={TABLE}
        fields={[
          summary(0, null, { queued: 4, retry_at: new Date(Date.now() + 60_000).toISOString() }),
        ]}
        canManage
        settingsPath={null}
      />,
    );
    const banner = screen.getByTestId('ai-paused-banner');
    expect(banner).toHaveTextContent('“Summary”: waiting for the AI provider.');
    expect(banner).toHaveTextContent('generating goes on by itself at');
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('links to the settings when AI is off (no "Resume": it would be refused)', async () => {
    stubApi({ signedIn: true });
    await renderWith(
      <AiPausedBanner
        tableId={TABLE}
        fields={[summary(3, 'ai_disabled')]}
        canManage
        settingsPath="/o/acme/settings/ai"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.getByRole('link', { name: 'AI settings' })).toHaveAttribute(
      'href',
      '/o/acme/settings/ai',
    );
  });

  it('shows nothing without paused cells', async () => {
    stubApi({ signedIn: true });
    await renderWith(
      <AiPausedBanner tableId={TABLE} fields={[summary(0, null)]} canManage settingsPath={null} />,
    );
    expect(screen.queryByTestId('ai-paused-banner')).toBeNull();
  });
});

describe('AiGenerateDialog: regenerate (T915)', () => {
  it('counts the failed cells, estimates the tokens, generates them again', async () => {
    const fetchMock = stubApi({
      signedIn: true,
      routes: {
        [`POST /tables/${TABLE}/records/query`]: () =>
          json({ records: [], total: 6, offset: 0, limit: 1 }),
        [`POST /fields/${SUMMARY}/ai/generate`]: generated,
      },
    });
    await renderWith(
      <AiGenerateDialog
        tableId={TABLE}
        field={summary(0, null)}
        mode="failed"
        onClose={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Generate the failed cells of “Summary” again?',
    });
    // Two rows × (ceil(6 / 3) + 100) tokens: the server's rough upper bound.
    expect(screen.getByTestId('ai-generate-summary')).toHaveTextContent(
      '2 rows · about 204 tokens',
    );
    expect(await axeViolations(dialog)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Generate again' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url.includes('/ai/generate'))).toBe(true);
    });
  });

  it('warns that "all" overwrites (old values stay in the history)', async () => {
    stubApi({
      signedIn: true,
      routes: {
        [`POST /tables/${TABLE}/records/query`]: () =>
          json({ records: [], total: 6, offset: 0, limit: 1 }),
      },
    });
    await renderWith(
      <AiGenerateDialog
        tableId={TABLE}
        field={summary(0, null)}
        mode="all"
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('ai-generate-summary')).toHaveTextContent(
        '6 rows · about 612 tokens',
      );
    });
    expect(screen.getByRole('note')).toHaveTextContent(
      'Earlier values stay in each record’s history.',
    );
  });
});
