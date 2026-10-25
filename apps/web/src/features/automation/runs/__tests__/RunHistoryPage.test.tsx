import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { BASE_ID, FIELD, fieldList, NOW, TABLE_ID } from '../../../../../test/records';
import { clearToasts } from '../../../../lib/toast/toast';

const AUT = 'aut_Auto000000000001';
const SELF = { id: ME.user.id, name: ME.user.display_name };
const OTHER_USER = 'usr_Other00000000001';

function base(kind: 'admin' | 'editor') {
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
      is_admin: kind === 'admin',
      base_rule: { copy: true, download: true, share_link: true },
      tables: {
        [TABLE_ID]: {
          perm: kind === 'admin' ? 'manage' : 'edit',
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
  };
}

const DEFINITION = {
  trigger: { type: 'record.created', table_id: TABLE_ID, skip_bulk: false },
  condition: null,
  actions: [
    {
      id: 'act_find',
      type: 'find_records',
      config: {
        table_id: TABLE_ID,
        filter: null,
        sort: [],
        fields: [FIELD.title, FIELD.amount],
        limit: 10,
      },
    },
    {
      id: 'act_fix',
      type: 'update_record',
      config: { table_id: TABLE_ID, record_id: null, fields: { [FIELD.notes]: { literal: 'x' } } },
    },
    {
      id: 'act_tell',
      type: 'send_notification',
      config: {
        recipients: [{ user_ids: [ME.user.id] }],
        title: { template: 'Hi' },
        body: { template: '' },
        link_record: 'trigger',
        skip_actor: false,
      },
    },
  ],
};

const AUTOMATION = {
  id: AUT,
  base_id: BASE_ID,
  name: 'Orders follow-up',
  description: '',
  enabled: true,
  disabled_reason: null,
  version: 4,
  definition: DEFINITION,
  run_as: SELF,
  run_as_since: NOW,
  created_by: SELF,
  created_at: NOW,
  updated_at: NOW,
};

function trigger(recordId: string | null, batch: { id: string; size: number } | null = null) {
  return {
    event_type: 'record.created',
    event_id: 'evt_Event00000000001',
    table_id: recordId === null ? null : TABLE_ID,
    record_id: recordId,
    bulk: batch !== null,
    batch,
  };
}

function run(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    automation_id: AUT,
    automation_version: 3,
    status: 'succeeded',
    error: null as Record<string, unknown> | null,
    trigger: trigger('rec_Visible000000001'),
    trigger_unit: 'evt_Event00000000001',
    depth: 0,
    rerun_of: null,
    rerun_by: null,
    active_ms: 1400,
    started_at: NOW,
    finished_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const FAILED = run('run_Failed0000000001', {
  status: 'failed',
  error: { code: 'invalid_value', step: 'act_fix', params: { field: 'record_id' } },
});
const QUEUED = run('run_Queued0000000001', {
  status: 'queued',
  trigger: trigger('rec_Hidden0000000001'),
});
const OVERFLOW = run('run_Overflow00000001', {
  status: 'skipped',
  trigger: trigger(null, { id: 'job_Import0000000001', size: 5000 }),
  error: {
    code: 'batch_fanout_exceeded',
    params: { batch_id: 'job_Import0000000001', limit: 1000, skipped: 4000 },
  },
});
const RERUN = run('run_Rerun00000000001', {
  status: 'queued',
  automation_version: 4,
  rerun_of: FAILED.id,
  rerun_by: SELF,
  started_at: null,
  finished_at: null,
  active_ms: 0,
});

function detailOf(item: ReturnType<typeof run>) {
  return {
    ...item,
    automation: { id: AUT, name: AUTOMATION.name, version: 4 },
    definition: DEFINITION,
    steps:
      item.id === FAILED.id
        ? [
            {
              id: 'stp_Find000000000001',
              action_id: 'act_find',
              action_type: 'find_records',
              status: 'succeeded',
              attempt: 1,
              started_at: NOW,
              finished_at: NOW,
              reused: false,
              redacted: true,
              error: null,
              output: {
                count: 2,
                truncated: false,
                records: [
                  {
                    id: 'rec_Visible000000001',
                    fields: { [FIELD.title]: 'Order 1', [FIELD.amount]: null },
                    redacted: false,
                    redacted_fields: [FIELD.amount],
                  },
                  {
                    id: 'rec_Hidden0000000001',
                    fields: { [FIELD.title]: null, [FIELD.amount]: null },
                    redacted: true,
                    redacted_fields: [FIELD.title, FIELD.amount],
                  },
                ],
              },
            },
            {
              id: 'stp_Fix0000000000001',
              action_id: 'act_fix',
              action_type: 'update_record',
              status: 'failed',
              attempt: 1,
              started_at: NOW,
              finished_at: NOW,
              reused: false,
              redacted: false,
              output: null,
              error: { code: 'invalid_value', params: { field: 'record_id' }, attempt: 1 },
            },
          ]
        : [],
    reruns: [],
  };
}

/** T556 (QA S5 L1): a `send_email` step refused by the server, with `error.params` of T541. */
const EMAIL_FAILED = run('run_Email00000000001', {
  status: 'failed',
  error: { code: 'smtp_rejected', step: 'act_mail' },
});
const EMAIL_DEFINITION = {
  ...DEFINITION,
  actions: [
    {
      id: 'act_mail',
      type: 'send_email',
      config: {
        identity_id: null,
        to: [{ literal: 'c@example.com' }],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: { template: 'Hi' },
        body: { format: 'markdown', template: 'Hello' },
        include_signature: true,
        footer: 'minimal',
        attachments: [],
      },
    },
  ],
};

function emailDetail() {
  return {
    ...EMAIL_FAILED,
    automation: { id: AUT, name: AUTOMATION.name, version: 4 },
    definition: EMAIL_DEFINITION,
    steps: [
      {
        id: 'stp_Mail000000000001',
        action_id: 'act_mail',
        action_type: 'send_email',
        status: 'failed',
        attempt: 1,
        started_at: NOW,
        finished_at: NOW,
        reused: false,
        redacted: false,
        output: null,
        error: {
          code: 'smtp_rejected',
          attempt: 1,
          params: {
            reason: 'rejected',
            smtp: { code: 550, enhanced: '5.1.1' },
            rejected: [
              {
                masked: 'c***@example.com',
                code: 'smtp_rejected',
                smtp: { code: 550, enhanced: '5.1.1' },
              },
              {
                masked: 'd***@example.org',
                code: 'smtp_rejected',
                smtp: { code: 552, enhanced: '5.2.2' },
              },
            ],
            rejected_count: 53,
            accepted_count: 1,
          },
        },
      },
    ],
    reruns: [],
  };
}

/** T614: HTTP steps and the delivery summary of the outbox (CONTRACTS §21, §25.5). */
const httpAction = (id: string, url: string) => ({
  id,
  type: 'http_request',
  config: {
    method: 'POST',
    url: { literal: url },
    query: [],
    headers: [],
    auth: null,
    body: null,
    signing_secret_id: null,
    fail_on_http_error: true,
  },
});
const HTTP_DEFINITION = {
  ...DEFINITION,
  actions: [
    httpAction('act_ok', 'https://hooks.example.com/orders?token=SECRET-QUERY'),
    httpAction('act_chain', 'https://hooks.example.com/next'),
    httpAction('act_ssrf', 'http://n8n.internal:5678/webhook'),
  ],
};
const RETRY_AT = '2026-10-18T10:05:00.000Z';
const HTTP_WAITING = run('run_HttpWait00000001', { status: 'waiting', finished_at: null });
const HTTP_FAILED = run('run_HttpFail00000001', {
  status: 'failed',
  error: { code: 'ssrf_blocked', step: 'act_ssrf', params: { reason: 'private_address' } },
});
const httpStep = (actionId: string, overrides: Record<string, unknown>) => ({
  id: `stp_${actionId.slice(4).padEnd(16, '0')}`,
  action_id: actionId,
  action_type: 'http_request',
  status: 'succeeded',
  attempt: 1,
  started_at: NOW,
  finished_at: NOW,
  reused: false,
  redacted: false,
  output: null,
  error: null,
  ...overrides,
});
const delivered = (body: unknown, redacted = false) => ({
  status: 'succeeded',
  redacted,
  output: {
    delivery_id: 'hdl_Delivery00000001',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
    body_truncated: false,
  },
  delivery: {
    id: 'hdl_Delivery00000001',
    target_host: 'hooks.example.com',
    attempts: 1,
    status: 'succeeded',
    last_status: 200,
    last_error: null,
    next_attempt_at: null,
  },
});

function httpDetail(item: typeof HTTP_WAITING) {
  return {
    ...item,
    automation: { id: AUT, name: AUTOMATION.name, version: 4 },
    definition: HTTP_DEFINITION,
    steps:
      item.id === HTTP_WAITING.id
        ? [
            httpStep('act_ok', {
              status: 'waiting',
              finished_at: null,
              delivery: {
                id: 'hdl_Delivery00000001',
                target_host: 'hooks.example.com',
                attempts: 2,
                status: 'pending',
                last_status: 503,
                last_error: { code: 'http_status', params: { status: 503 } },
                next_attempt_at: RETRY_AT,
              },
            }),
          ]
        : [
            httpStep('act_ok', delivered({ id: 42, ok: true })),
            // A value from the previous HTTP step: the body is always hidden (T606).
            httpStep('act_chain', delivered(null, true)),
            httpStep('act_ssrf', {
              status: 'failed',
              error: { code: 'ssrf_blocked', params: { reason: 'private_address' }, attempt: 1 },
              delivery: {
                id: 'hdl_Delivery00000003',
                target_host: 'n8n.internal',
                attempts: 1,
                status: 'failed',
                last_status: null,
                last_error: { code: 'ssrf_blocked', params: { reason: 'private_address' } },
                next_attempt_at: null,
              },
            }),
          ],
    reruns: [],
  };
}

interface Call {
  method: string;
  path: string;
  query: string;
}

function serve(kind: 'admin' | 'editor', options: { cancelConflict?: boolean } = {}) {
  const calls: Call[] = [];
  let runs = [QUEUED, FAILED, OVERFLOW];
  const routes: Record<string, (init: RequestInit | undefined) => Response> = {
    [`GET /bases/${BASE_ID}`]: () => json(base(kind)),
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
    // Titles of trigger records: the hidden one is absent (CONTRACTS §1.4 `ids`).
    [`POST /tables/${TABLE_ID}/records/query`]: () =>
      json({
        records: [
          {
            id: 'rec_Visible000000001',
            created_at: NOW,
            updated_at: NOW,
            version: 1,
            fields: { [FIELD.title]: 'Order 1' },
          },
        ],
        offset: 0,
        limit: 2,
      }),
    [`GET /orgs/${ORG.id}/members`]: () =>
      json({
        items: [
          {
            user: {
              id: ME.user.id,
              display_name: ME.user.display_name,
              email: ME.user.email,
              avatar_url: null,
            },
            role: 'owner',
            joined_at: NOW,
          },
          {
            user: {
              id: OTHER_USER,
              display_name: 'Trần Thu Hà',
              email: 'ha@example.test',
              avatar_url: null,
            },
            role: 'member',
            joined_at: NOW,
          },
        ],
        total: 2,
        offset: 0,
        limit: 1000,
      }),
    [`GET /automations/${AUT}`]: () =>
      kind === 'editor' ? problem('NOT_FOUND', 404) : json(AUTOMATION),
    [`GET /bases/${BASE_ID}/automations`]: () =>
      kind === 'editor'
        ? problem('PERMISSION_DENIED', 403)
        : json({
            items: [
              {
                ...AUTOMATION,
                last_run: null,
                errors_24h: 1,
                run_counts_24h: {
                  queued: 0,
                  running: 0,
                  waiting: 0,
                  succeeded: 0,
                  failed: 1,
                  skipped: 0,
                  cancelled: 0,
                },
                run_counts_7d: {
                  queued: 0,
                  running: 0,
                  waiting: 0,
                  succeeded: 0,
                  failed: 1,
                  skipped: 0,
                  cancelled: 0,
                },
              },
            ],
            total: 1,
            offset: 0,
            limit: 1000,
          }),
  };
  const list = () => () => json({ items: runs, next_cursor: null });
  routes[`GET /automations/${AUT}/runs`] = list();
  routes[`GET /bases/${BASE_ID}/automation-runs`] = list();
  for (const item of [QUEUED, FAILED, OVERFLOW, RERUN]) {
    routes[`GET /automation-runs/${item.id}`] = () => json(detailOf(item));
  }
  routes[`GET /automation-runs/${EMAIL_FAILED.id}`] = () => json(emailDetail());
  for (const item of [HTTP_WAITING, HTTP_FAILED]) {
    routes[`GET /automation-runs/${item.id}`] = () => json(httpDetail(item));
  }
  routes[`POST /automation-runs/${FAILED.id}/rerun`] = () => {
    runs = [RERUN, ...runs];
    return json(RERUN, 201);
  };
  routes[`POST /automation-runs/${QUEUED.id}/cancel`] = () => {
    if (options.cancelConflict === true) return problem('RUN_STATE_CONFLICT', 409);
    const cancelled = {
      ...QUEUED,
      status: 'cancelled',
      error: { code: 'cancelled_by_user', params: { user_id: ME.user.id } },
    };
    runs = runs.map((item) => (item.id === QUEUED.id ? cancelled : item));
    return json(cancelled);
  };
  const fetchMock = stubApi({ signedIn: true, routes });
  const wrapped = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname.replace('/api/v1', ''),
      query: url.search,
    });
    return wrapped?.(input, init) ?? Promise.resolve(problem('NOT_FOUND', 404));
  });
  return { calls };
}

const PAGE = `/b/${BASE_ID}/automations/${AUT}/runs`;

afterEach(() => {
  clearToasts();
});

describe('RunHistoryPage (T523)', () => {
  it('lists the runs of an automation with record titles, errors and the batch overflow', async () => {
    const { calls } = serve('admin');
    await renderApp(PAGE);
    const list = await screen.findByTestId('run-list');
    const failed = within(list).getByTestId(`run-row-${FAILED.id}`);
    expect(await within(failed).findByText('Order 1')).toBeVisible();
    expect(failed).toHaveTextContent('Failed');
    expect(failed).toHaveTextContent(
      'The record to update could not be found from the value given.',
    );
    // A trigger record the viewer cannot read: no title, no link.
    expect(await within(list).findByText('A record you cannot see')).toBeVisible();
    const overflow = within(list).getByTestId(`run-row-${OVERFLOW.id}`);
    expect(overflow).toHaveTextContent('Batch of 5,000 records');
    expect(overflow).toHaveTextContent(
      'Over the limit of 1,000 runs per batch: 4,000 records were skipped.',
    );
    expect(screen.getByTestId('automation-tab-runs')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('runs-title')).toHaveTextContent('Orders follow-up');
    expect(screen.getByTestId('run-count')).toHaveTextContent('3 runs');
    const first = calls.find((call) => call.path === `/automations/${AUT}/runs`);
    expect(first?.query).toContain('from=');
    expect(first?.query).not.toContain('status=');
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.selectOptions(screen.getByTestId('run-filter-status'), 'failed');
    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.path === `/automations/${AUT}/runs` && call.query.includes('status=failed'),
        ),
      ).toBe(true);
    });
  });

  it('opens a failed run: step error, hidden values, version, then re-runs it', async () => {
    const { calls } = serve('admin');
    const { router } = await renderApp(PAGE);
    await userEvent.click(await screen.findByTestId(`run-open-${FAILED.id}`));
    expect(router.state.location.search).toBe(`?run=${FAILED.id}`);
    const detail = await screen.findByTestId('run-detail');
    expect(within(detail).getByTestId('run-version')).toHaveTextContent(
      'Version 3 at run time · now version 4',
    );
    const fix = within(detail).getByTestId('run-step-act_fix');
    expect(fix).toHaveAttribute('data-step-status', 'failed');
    expect(within(fix).getByTestId('step-error-act_fix')).toHaveTextContent(
      'The record to update could not be found from the value given.',
    );
    const find = within(detail).getByTestId('step-output-act_find');
    expect(find).toHaveTextContent('Order 1');
    expect(within(find).getAllByText('Hidden (no permission)')).toHaveLength(2);
    expect(within(detail).getByTestId('run-step-act_tell')).toHaveTextContent('Did not run');
    expect(await screen.findByTestId('run-record-link')).toHaveTextContent('Order 1');
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(within(detail).getByTestId('run-rerun'));
    const dialog = await screen.findByTestId('rerun-dialog');
    expect(dialog).toHaveTextContent('The definition changed since this run (version 3 → 4).');
    await userEvent.click(within(dialog).getByTestId('rerun-confirm'));
    await waitFor(() => {
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', path: `/automation-runs/${FAILED.id}/rerun` }),
      );
    });
    expect(await screen.findByText('Re-run started.')).toBeVisible();
    await waitFor(() => {
      expect(router.state.location.search).toBe(`?run=${RERUN.id}`);
    });
    await waitFor(() => {
      expect(screen.getByTestId('run-detail')).toHaveAttribute('data-run-status', 'queued');
    });
    expect(
      screen.getByText('This run has not finished: its status refreshes on its own.'),
    ).toBeVisible();
  });

  it('lists the refused recipients of a failed email step, masked, with SMTP codes (T556)', async () => {
    serve('admin');
    await renderApp(`${PAGE}?run=${EMAIL_FAILED.id}`);
    const detail = await screen.findByTestId('run-detail');
    const error = await within(detail).findByTestId('step-error-act_mail');
    expect(error).toHaveTextContent('The email server refused the message.');
    const refused = within(error).getByTestId('step-rejected');
    expect(refused).toHaveTextContent('53 refused recipients:');
    const rows = within(refused).getAllByTestId('rejected-recipient');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('c***@example.com · mailbox does not exist');
    expect(rows[0]).toHaveTextContent('550 5.1.1');
    expect(rows[1]).toHaveTextContent('d***@example.org · mailbox full');
    expect(rows[1]).toHaveTextContent('552 5.2.2');
    expect(refused).toHaveTextContent('and 51 more not listed');
    expect(refused).toHaveTextContent(
      '1 recipient was accepted before the failure — the email reached none of them.',
    );
    // Masked by the server, never rebuilt: no full address anywhere.
    expect(detail).not.toHaveTextContent('c@example.com');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('an HTTP step waiting for its next attempt: host, attempts, retry time, last error (T614)', async () => {
    serve('admin');
    await renderApp(`${PAGE}?run=${HTTP_WAITING.id}`);
    const detail = await screen.findByTestId('run-detail');
    const http = await within(detail).findByTestId('http-step-act_ok');
    expect(within(http).getByTestId('http-host')).toHaveTextContent('hooks.example.com');
    expect(within(http).getByTestId('http-attempts')).toHaveTextContent('2 of 6');
    const phase = within(http).getByTestId('http-phase');
    expect(phase).toHaveAttribute('data-phase', 'paused');
    expect(phase).toHaveTextContent(
      'Paused: the server asked to wait (Retry-After). Next attempt at',
    );
    expect(within(http).getByTestId('http-last-status')).toHaveTextContent('HTTP 503');
    expect(within(http).getByTestId('http-last-error')).toHaveTextContent(
      'The server answered with HTTP status 503.',
    );
    // Never the full URL (its query may hold a token), headers or request body.
    expect(detail).not.toHaveTextContent('SECRET-QUERY');
    expect(detail).not.toHaveTextContent('https://hooks.example.com');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('HTTP steps that ended: the response, a hidden body, a blocked address explained (T614)', async () => {
    serve('admin');
    await renderApp(`${PAGE}?run=${HTTP_FAILED.id}`);
    const detail = await screen.findByTestId('run-detail');
    const ok = await within(detail).findByTestId('http-step-act_ok');
    expect(within(ok).getByTestId('http-phase')).toHaveTextContent('Delivered');
    expect(within(ok).getByTestId('http-response')).toHaveTextContent('application/json');
    expect(within(ok).getByTestId('http-body')).toHaveTextContent('"id": 42');
    const chain = within(detail).getByTestId('http-step-act_chain');
    expect(within(chain).getByTestId('http-body-hidden')).toHaveTextContent(
      'Hidden (no permission)',
    );
    expect(within(chain).queryByTestId('http-body')).toBeNull();
    const ssrf = within(detail).getByTestId('http-step-act_ssrf');
    expect(within(detail).getByTestId('step-error-act_ssrf')).toHaveTextContent(
      "The URL leads to a private network address that the organization's HTTP allowlist does not open.",
    );
    expect(within(ssrf).getByTestId('http-phase')).toHaveTextContent('Not delivered');
    expect(within(ssrf).getByTestId('http-ssrf-hint')).toHaveTextContent(
      'can open this host (and its port)',
    );
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('cancels a queued run after confirming, and reports a conflict', async () => {
    const { calls } = serve('admin', { cancelConflict: true });
    await renderApp(PAGE);
    await userEvent.click(await screen.findByTestId(`run-cancel-${QUEUED.id}`));
    const dialog = await screen.findByTestId('cancel-run-dialog');
    expect(dialog).toHaveTextContent('The run has not started');
    expect(calls.some((call) => call.path.endsWith('/cancel'))).toBe(false);
    await userEvent.click(within(dialog).getByTestId('cancel-run-confirm'));
    expect(
      await screen.findByText('This run has just changed status. The latest status is shown.'),
    ).toBeVisible();
  });

  it('cancels a queued run', async () => {
    const { calls } = serve('admin');
    await renderApp(PAGE);
    await userEvent.click(await screen.findByTestId(`run-cancel-${QUEUED.id}`));
    await userEvent.click(await screen.findByTestId('cancel-run-confirm'));
    expect(await screen.findByText('Run cancelled.')).toBeVisible();
    expect(calls).toContainEqual(
      expect.objectContaining({ method: 'POST', path: `/automation-runs/${QUEUED.id}/cancel` }),
    );
    await waitFor(() => {
      expect(screen.getByTestId(`run-row-${QUEUED.id}`)).toHaveTextContent(
        'Cancelled by An Nguyen.',
      );
    });
  });

  it('shows the runs of the whole base, filtered by automation', async () => {
    const { calls } = serve('admin');
    await renderApp(`/b/${BASE_ID}/automations/runs`);
    const list = await screen.findByTestId('run-list');
    expect(within(list).getByTestId(`run-row-${FAILED.id}`)).toHaveTextContent('Orders follow-up');
    expect(screen.queryByTestId('automation-tabs')).toBeNull();
    await userEvent.selectOptions(screen.getByTestId('run-filter-automation'), AUT);
    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.path === `/bases/${BASE_ID}/automation-runs` &&
            call.query.includes(`automation_id=${AUT}`),
        ),
      ).toBe(true);
    });
  });

  it('?event= shows the runs of one webhook request, and the filter can be cleared (T616)', async () => {
    const { calls } = serve('admin');
    const eventId = 'evt_AbCdEfGh01234567';
    await renderApp(`/b/${BASE_ID}/automations/runs?event=${eventId}&range=all`);
    expect(await screen.findByTestId('run-filter-event')).toHaveTextContent(
      'Runs started by one webhook request.',
    );
    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.path === `/bases/${BASE_ID}/automation-runs` &&
            call.query.includes(`event_id=${eventId}`),
        ),
      ).toBe(true);
    });
    expect(await axeViolations(document.body)).toEqual([]);
    const before = calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Show every run' }));
    await waitFor(() => {
      expect(screen.queryByTestId('run-filter-event')).toBeNull();
    });
    await waitFor(() => {
      expect(
        calls
          .slice(before)
          .some(
            (call) =>
              call.path === `/bases/${BASE_ID}/automation-runs` && !call.query.includes('event_id'),
          ),
      ).toBe(true);
    });
  });

  it('ignores an ?event= that is not an event id', async () => {
    const { calls } = serve('admin');
    await renderApp(`/b/${BASE_ID}/automations/runs?event=run_x'%3B`);
    await screen.findByTestId('run-list');
    expect(screen.queryByTestId('run-filter-event')).toBeNull();
    expect(calls.some((call) => call.query.includes('event_id'))).toBe(false);
  });

  it('tells someone who manages no automation why there is nothing', async () => {
    const { calls } = serve('editor');
    await renderApp(PAGE);
    expect(await screen.findByTestId('runs-forbidden')).toBeVisible();
    expect(calls.some((call) => call.path.includes('/runs'))).toBe(false);
  });
});
