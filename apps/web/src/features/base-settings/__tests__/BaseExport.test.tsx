import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { clearToasts } from '../../../lib/toast/toast';

import type { JobDto } from '@cellhive/contracts';

/** Base settings › Export base: the `.chbase` export (FRONTEND §17.5, CONTRACTS §12.2). */

const BASE = 'bse_Export0000000001';
const JOB = 'job_Export0000000001';
const NOW = '2026-11-08T03:00:00.000Z';

const COUNTS = {
  tables: 3,
  fields: 41,
  records: 7200,
  links: 900,
  attachments: 12,
  views: 6,
  dashboards: 1,
  widgets: 5,
  automations: 2,
  roles: 1,
};

function job(overrides: Partial<JobDto>): JobDto {
  return {
    id: JOB,
    type: 'base.export',
    status: 'running',
    progress: 0.3,
    result: null,
    error: null,
    created_at: NOW,
    started_at: NOW,
    finished_at: null,
    ...overrides,
  };
}

/** `jobs.current`: what `GET /jobs/:id` answers now (a test moves it on). */
function serve(jobs: { current: JobDto }) {
  const base = {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_Export0000000001',
    owner_id: ME.user.id,
    name: 'Support',
    icon: null,
    description: null,
    permission_version: 1,
    settings: { strict_computed_permissions: false },
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
  const exports: unknown[] = [];
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(base),
      [`GET /bases/${BASE}/tables`]: () => json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /bases/${BASE}/tables/trash`]: () => json({ items: [] }),
      [`GET /bases/${BASE}/dashboards`]: () => json({ items: [] }),
      [`POST /bases/${BASE}/export`]: (init) => {
        exports.push({
          body: init?.body,
          key: new Headers(init?.headers).get('Idempotency-Key'),
        });
        return json({ job_id: JOB }, 202);
      },
      [`GET /jobs/${JOB}`]: () => json(jobs.current),
    },
  });
  return { exports };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  window.sessionStorage.clear();
});

describe('base settings › Export base', () => {
  it('says what the package holds, warns in the dialog, follows the job to its download', async () => {
    const jobs = { current: job({ progress: 0.42 }) };
    const { exports } = serve(jobs);
    const user = userEvent.setup();
    await renderApp(`/b/${BASE}/settings/export`);
    const page = await screen.findByTestId('base-export-page');
    const nav = screen.getByTestId('base-settings-nav-export');
    expect(nav).toHaveAttribute('aria-current', 'page');
    expect(page).toHaveTextContent(
      'Every table, field and record, including fields that roles hide from other members',
    );
    expect(page).toHaveTextContent('Members, groups and the roles they have');
    expect(page).toHaveTextContent(`cellhive base export --base ${BASE} --out base.chbase`);
    expect(await axeViolations(document.body)).toEqual([]);

    await user.click(screen.getByTestId('export-open'));
    const dialog = await screen.findByRole('dialog', { name: 'Export Support' });
    expect(within(dialog).getByRole('note')).toHaveTextContent(
      'The package holds every field of this base, including fields that roles hide from other members.',
    );
    expect(dialog).toHaveTextContent('Members, secrets and history stay here');
    await user.click(within(dialog).getByTestId('export-start'));

    // Running: the phases, "Records" in progress.
    const phases = await within(dialog).findByTestId('job-phases');
    expect(within(phases).getByText('Records').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(exports).toHaveLength(1);
    expect(exports).toEqual([{ body: '{}', key: expect.stringMatching(/^web-/u) as unknown }]);

    jobs.current = job({
      status: 'succeeded',
      progress: 1,
      finished_at: NOW,
      result: {
        download_url: `/api/v1/files/exports/${JOB}`,
        expires_at: '2026-11-08T04:00:00.000Z',
        size: 3 * 1024 * 1024,
        counts: COUNTS,
        skipped_personal_views: 1,
      },
    });

    // Done (the next poll): the download with its size and counts.
    const ready = await within(dialog).findByTestId('export-ready', {}, { timeout: 15_000 });
    expect(ready).toHaveTextContent('The package is ready');
    expect(ready).toHaveTextContent('Support.chbase · 3 MB');
    expect(ready).toHaveTextContent('7,200');
    const download = within(ready).getByRole('link', { name: 'Download Support.chbase' });
    expect(download).toHaveAttribute('href', `/api/v1/files/exports/${JOB}`);
    expect(download).toHaveAttribute('download');
    expect(await axeViolations(document.body)).toEqual([]);

    // Closed: the page keeps the download; this tab remembers the job.
    await user.click(within(ready).getByRole('button', { name: 'Close' }));
    expect(await screen.findByTestId('export-status')).toHaveTextContent(
      'Ready to download · 3 MB',
    );
    expect(window.sessionStorage.getItem(`cellhive.baseExport.${BASE}`)).toBe(JOB);
  }, 60_000);

  it('a failed export says why and offers to export again', async () => {
    serve({
      current: job({
        status: 'failed',
        finished_at: NOW,
        error: {
          type: 'about:blank',
          title: 'Validation failed',
          status: 422,
          code: 'VALIDATION_FAILED',
          errors: [
            { path: '', code: 'PACKAGE_TOO_LARGE', message: 'Too large.', params: { limit: 1024 } },
          ],
        },
      }),
    });
    const user = userEvent.setup();
    await renderApp(`/b/${BASE}/settings/export`);
    await user.click(await screen.findByTestId('export-open'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByTestId('export-start'));
    const failed = await within(dialog).findByTestId('export-failed');
    expect(failed).toHaveTextContent('The base is too large for one package: at most 1,024 bytes');
    await user.click(within(failed).getByRole('button', { name: 'Export again' }));
    await waitFor(() => {
      expect(within(dialog).getByTestId('export-confirm')).toBeInTheDocument();
    });
  }, 60_000);

  it('an expired download is forgotten', async () => {
    window.sessionStorage.setItem(`cellhive.baseExport.${BASE}`, JOB);
    serve({
      current: job({
        status: 'succeeded',
        progress: 1,
        finished_at: NOW,
        result: { size: 10, counts: COUNTS, skipped_personal_views: 0, file_deleted: true },
      }),
    });
    await renderApp(`/b/${BASE}/settings/export`);
    await screen.findByTestId('base-export-page');
    await waitFor(() => {
      expect(window.sessionStorage.getItem(`cellhive.baseExport.${BASE}`)).toBeNull();
    });
    expect(screen.queryByTestId('export-status')).toBeNull();
    expect(screen.getByTestId('export-open')).toHaveTextContent('Export base');
  }, 60_000);
});
