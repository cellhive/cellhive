import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { BASE_ID, FIELD, fieldList, NOW, TABLE_ID } from '../../../../../test/records';
import { clearToasts } from '../../../../lib/toast/toast';

/**
 * T522: the wide `send_email` editor (sender with "recipients will see",
 * recipients, footer lock, Markdown toolbar, sandboxed preview, test send
 * with its per-minute limit) and the `send_notification` panel.
 */

const AUTOMATION_ID = 'aut_Email00000000001';
const SELF = { id: ME.user.id, name: ME.user.display_name };
const HR = 'eid_Hr00000000000001';
const IT = 'eid_It00000000000001';
const FILES = 'fld_Files00000000001';
const PHOTOS = 'fld_Photos0000000001';
const CONTRACTS = 'fld_Contracts0000001';
const STORAGE = 'https://storage.banhang.vn';
const SIGNED = `${STORAGE}/cellhive/thumbs/k1?X-Amz-Signature=abc`;
const RECORD = 'rec_Order00000000001';

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
          view_rule: { allow_edit: false, visible_views: null },
          read_scope: 'all',
          fields: {},
          option_edit_fields: [],
          file_download_fields: [FILES, PHOTOS, CONTRACTS],
        },
      },
      dashboards: {},
    },
  };
}

const emailStep = {
  id: 'act_1',
  type: 'send_email',
  config: {
    identity_id: null,
    to: [{ literal: 'kh@minhlong.vn' }],
    cc: [],
    bcc: [],
    reply_to: null,
    subject: { template: `Order {{ [${FIELD.title}] }}` },
    body: { format: 'markdown', template: 'Hello', digest: null },
    include_signature: true,
    footer: 'minimal',
    attachments: [],
    on_missing_attachment: 'fail',
  },
};

function automation(actions: unknown[] = [emailStep]) {
  return {
    id: AUTOMATION_ID,
    base_id: BASE_ID,
    name: 'Payment confirmed',
    description: '',
    enabled: false,
    disabled_reason: null,
    version: 2,
    definition: {
      trigger: { type: 'record.created', table_id: TABLE_ID, skip_bulk: false },
      condition: null,
      actions,
    },
    run_as: SELF,
    run_as_since: NOW,
    created_by: SELF,
    created_at: NOW,
    updated_at: NOW,
  };
}

function settings() {
  return {
    smtp: {
      configured: true,
      host: '***.banhang.vn',
      port: 587,
      security: 'starttls',
      from: 'no-reply@banhang.vn',
      from_name: 'Bán Hàng Việt',
      allowed_from_domains: ['banhang.vn'],
    },
    limits: {
      max_per_hour_per_org: 500,
      max_recipients: 50,
      max_per_second_per_process: 5,
      test_sends_per_minute: 5,
      max_html_bytes: 102_400,
      max_attachments: 10,
      max_attachment_bytes: 15_728_640,
      max_inline_images: 5,
    },
    usage: { sent_this_hour: 0, resets_at: NOW },
    automation: {
      instance_footer_policy: 'required',
      footer_policy: 'required',
      footer_none_allowed: false,
      default_signature_md: null,
      system_sender_enabled: true,
      max_attachments: 10,
      max_attachment_bytes: 15_728_640,
      attachment_limits_custom: false,
      system_sender_usage: { automations: 1, enabled_automations: 0 },
    },
  };
}

function previewOf(draft: { identity_id: string | null; body?: { template: string } | undefined }) {
  const onBehalf = draft.identity_id === IT;
  const withImage = draft.body?.template.includes(`(field:${PHOTOS})`) === true;
  return {
    subject: 'Order <script>alert(1)</script>',
    html:
      '<!doctype html><html><head><title>x</title></head><body style="margin:0">' +
      '<p style="margin:0">Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>' +
      (withImage ? '<p><img src="cid:img-1@cellhive" alt="Photos (main)"></p>' : '') +
      '</body></html>',
    text: 'Hello <script>alert(1)</script>\n\n---\nSent automatically.\n',
    headers: {
      from: onBehalf
        ? '"IT Helpdesk (via Cellhive)" <no-reply@banhang.vn>'
        : '"Acme" <no-reply@banhang.vn>',
      reply_to: onBehalf ? 'support@itpartner.vn' : null,
    },
    identity_id: draft.identity_id,
    mode: onBehalf ? 'on_behalf' : 'send_as',
    footer: 'minimal',
    recipients: { count: 1, to: ['k***@minhlong.vn'], cc: [], bcc: [], invalid: 0 },
    attachments: [],
    images: withImage ? [{ cid: 'img-1@cellhive', url: SIGNED }] : [],
    warnings: [
      { code: 'EXTERNAL_RECIPIENTS', params: { count: 1 } },
      ...(onBehalf ? [{ code: 'ON_BEHALF_DMARC' }] : []),
    ],
    render_warnings: [],
  };
}

interface Calls {
  previews: {
    record_id: string | null;
    draft: { identity_id: string | null; body?: { template: string } };
  }[];
  tests: number;
  saves: Record<string, unknown>[];
}

function serve(current: ReturnType<typeof automation>, testAnswers: (() => Response)[] = []) {
  const calls: Calls = { previews: [], tests: 0, saves: [] };
  const attachmentField = (
    id: string,
    name: string,
    accept: string[] | null,
    position: number,
  ) => ({
    id,
    table_id: TABLE_ID,
    name,
    type: 'attachment',
    options: { accept, max_files: 10, blocked_extensions: [] },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position,
    created_at: NOW,
    updated_at: NOW,
  });
  const fields = fieldList([
    attachmentField(FILES, 'Invoice', null, 9),
    attachmentField(PHOTOS, 'Photos [main]', ['image/*'], 10),
    attachmentField(CONTRACTS, 'Contracts', ['application/pdf'], 11),
  ]);
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(base()),
      [`GET /orgs/${ORG.id}`]: () => json(ORG),
      [`GET /orgs/${ORG.id}/email-settings`]: () => json(settings()),
      [`GET /orgs/${ORG.id}/members`]: () =>
        json({
          items: [{ user: ME.user, role: 'owner', joined_at: NOW }],
          total: 1,
          offset: 0,
          limit: 1000,
        }),
      [`GET /orgs/${ORG.id}/groups`]: () => json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /bases/${BASE_ID}/email-identities`]: () =>
        json({
          items: [
            { id: HR, email: 'hr@banhang.vn', display_name: 'Phòng Nhân sự', mode: 'send_as' },
            {
              id: IT,
              email: 'support@itpartner.vn',
              display_name: 'IT Helpdesk',
              mode: 'on_behalf',
            },
          ],
        }),
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
      [`GET /tables/${TABLE_ID}/fields`]: () => json(fields),
      [`POST /tables/${TABLE_ID}/records/query`]: () =>
        json({
          records: [
            {
              id: RECORD,
              created_at: NOW,
              updated_at: NOW,
              version: 1,
              fields: { [FIELD.title]: 'DH-10482' },
            },
          ],
          offset: 0,
          limit: 50,
        }),
      [`GET /bases/${BASE_ID}/automations`]: () =>
        json({ items: [current], total: 1, offset: 0, limit: 1000 }),
      [`GET /automations/${AUTOMATION_ID}`]: () => json(current),
      [`PATCH /automations/${AUTOMATION_ID}`]: (init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        calls.saves.push(body);
        return json({ ...current, ...body, version: current.version + 1 });
      },
      [`POST /automations/${AUTOMATION_ID}/actions/act_1/email-preview`]: (init) => {
        const body = JSON.parse(init?.body as string) as Calls['previews'][number];
        calls.previews.push(body);
        return json(previewOf(body.draft));
      },
      [`POST /automations/${AUTOMATION_ID}/actions/act_1/email-test`]: () => {
        calls.tests += 1;
        const answer = testAnswers[calls.tests - 1];
        if (answer !== undefined) return answer();
        return json({
          status: 'sent',
          to: ME.user.email,
          message_id: '<x@y>',
          smtp: { code: 250, enhanced: '2.0.0' },
        });
      },
    },
  });
  return calls;
}

const PAGE = `/b/${BASE_ID}/automations/${AUTOMATION_ID}`;

afterEach(() => {
  clearToasts();
});

async function openEmailStep() {
  await renderApp(PAGE);
  const flow = await screen.findByTestId('flow');
  await userEvent.click(within(flow).getByRole('button', { name: 'Send email' }));
  return screen.findByTestId('email-editor');
}

describe('send_email editor (T522)', () => {
  it('opens wide: senders with what recipients see, footer lock, sandboxed preview', async () => {
    const calls = serve(automation());
    const editor = await openEmailStep();
    expect(within(editor).getByRole('heading', { name: 'Step 1 · Send email' })).toHaveFocus();
    // Three senders (≤ 5: radios), each with its "recipients see" line.
    const senders = within(editor).getByRole('group', { name: 'Sender' });
    expect(within(senders).getAllByRole('radio')).toHaveLength(3);
    expect(within(senders).getByTestId('sender-system')).toHaveTextContent(
      'Recipients see: Acme <no-reply@banhang.vn>',
    );
    expect(within(senders).getByTestId(`sender-${IT}`)).toHaveTextContent(
      'IT Helpdesk (via Cellhive) <no-reply@banhang.vn>, replies go to support@itpartner.vn',
    );
    // System sender: "None" is locked, with the reason.
    expect(within(editor).getByRole('radio', { name: 'None' })).toBeDisabled();
    expect(editor).toHaveTextContent('Emails from the system sender always have a footer.');

    // The preview: record values stay text in a frame without scripts.
    const frame = await screen.findByTestId('email-preview-frame');
    expect(frame).toHaveAttribute('sandbox', '');
    // The line of the chosen sender now comes from the server, as people read it.
    expect(within(senders).getByTestId('sender-system')).toHaveTextContent(
      'Recipients see: Acme <no-reply@banhang.vn>',
    );
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('Hello &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).not.toContain('style="');
    expect(calls.previews.at(-1)).toMatchObject({ record_id: RECORD });
    expect(screen.getByTestId('preview-checks')).toHaveTextContent(
      '1 recipient outside the organization',
    );

    // Choosing the on-behalf identity: the Headers tab shows the From of the server.
    await userEvent.click(within(senders).getByTestId(`sender-${IT}`));
    await waitFor(() => {
      expect(calls.previews.at(-1)?.draft.identity_id).toBe(IT);
    });
    await userEvent.click(screen.getByRole('tab', { name: 'Headers' }));
    await waitFor(() => {
      expect(screen.getByTestId('preview-headers')).toHaveTextContent(
        'IT Helpdesk (via Cellhive) <no-reply@banhang.vn>',
      );
    });
    expect(screen.getByTestId('preview-headers')).toHaveTextContent('support@itpartner.vn');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('formats the body with the toolbar and saves the step', async () => {
    const calls = serve(automation());
    const editor = await openEmailStep();
    const body = within(editor).getByTestId('email-body');
    fireEvent.focus(body);
    await userEvent.click(within(editor).getByTestId('md-bullet'));
    await userEvent.click(within(editor).getByTestId('md-bold'));
    await userEvent.click(screen.getByTestId('builder-save'));
    await waitFor(() => {
      expect(calls.saves).toHaveLength(1);
    });
    expect(calls.saves[0]).toMatchObject({
      definition: {
        actions: [{ config: { body: { template: 'Hello\n- **text**' } } }],
      },
    });
  });

  it('inserts the images of a field and shows them in the preview (T534)', async () => {
    const calls = serve(automation());
    const editor = await openEmailStep();
    // One tab stop for the toolbar; ←/→/Home/End reach "Insert image" too.
    const image = within(editor).getByTestId('email-image-insert');
    expect(image).toHaveAttribute('tabindex', '-1');
    within(editor).getByTestId('md-bold').focus();
    await userEvent.keyboard('{End}{ArrowLeft}{ArrowLeft}');
    expect(image).toHaveFocus();
    expect(image).toHaveAttribute('tabindex', '0');
    expect(within(editor).getByTestId('md-bold')).toHaveAttribute('tabindex', '-1');

    const body = within(editor).getByTestId('email-body');
    fireEvent.focus(body);
    await userEvent.click(image);
    const menu = await screen.findByRole('menu');
    expect(await axeViolations(menu)).toEqual([]);
    // Attachment fields that may hold images; a PDF-only field is not offered.
    expect(within(menu).getByRole('menuitem', { name: 'Upload an image' })).toBeVisible();
    expect(within(menu).getByRole('menuitem', { name: 'Invoice' })).toBeVisible();
    expect(within(menu).queryByRole('menuitem', { name: 'Contracts' })).toBeNull();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Photos [main]' }));

    // The preview shows the image through the signed URL, and only that origin loads.
    await waitFor(() => {
      expect(calls.previews.at(-1)?.draft.body?.template).toBe(
        `Hello\n![Photos (main)](field:${PHOTOS})`,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('email-preview-frame').getAttribute('srcdoc')).toContain(
        `src="${SIGNED.replace('&', '&amp;')}"`,
      );
    });
    const srcdoc = screen.getByTestId('email-preview-frame').getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(`img-src ${STORAGE};`);
    expect(srcdoc).not.toContain('cid:');
    // axe cannot enter the frame in jsdom: check the editor (toolbar, menu button) on the Text tab.
    await userEvent.click(screen.getByRole('tab', { name: 'Text' }));
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(screen.getByTestId('builder-save'));
    await waitFor(() => {
      expect(calls.saves).toHaveLength(1);
    });
    expect(calls.saves[0]).toMatchObject({
      definition: {
        actions: [{ config: { body: { template: `Hello\n![Photos (main)](field:${PHOTOS})` } } }],
      },
    });
  });

  it('adds typed recipients as tokens and removes the last one with Backspace', async () => {
    serve(automation());
    const editor = await openEmailStep();
    const cc = within(editor).getByLabelText('Add a recipient to Cc');
    await userEvent.type(cc, 'boss@banhang.vn, nope{Enter}');
    expect(within(editor).getByTestId('email-cc')).toHaveTextContent('boss@banhang.vn');
    expect(editor).toHaveTextContent('Not an email address: nope');
    await userEvent.clear(cc);
    await userEvent.type(cc, '{Backspace}');
    expect(within(editor).getByTestId('email-cc')).not.toHaveTextContent('boss@banhang.vn');
  });

  it('counts test sends and stops at the per-minute limit (429)', async () => {
    const calls = serve(automation(), [
      () =>
        json({
          status: 'sent',
          to: ME.user.email,
          message_id: '<1@y>',
          smtp: { code: 250, enhanced: '2.0.0' },
        }),
      () => problem('RATE_LIMITED', 429),
    ]);
    const editor = await openEmailStep();
    expect(editor).toBeVisible();
    await screen.findByTestId('email-preview-frame');
    const send = screen.getByTestId('email-test');
    await userEvent.click(send);
    expect(await screen.findByTestId('test-status')).toHaveTextContent(
      `Test email sent to ${ME.user.email}.`,
    );
    expect(screen.getByTestId('test-left')).toHaveTextContent('4 / 5 left this minute');
    await userEvent.click(send);
    await waitFor(() => {
      expect(screen.getByTestId('test-status')).toHaveTextContent('Sent 5 tests in one minute.');
    });
    expect(send).toBeDisabled();
    expect(calls.tests).toBe(2);
  });

  it('Escape goes back to the flow', async () => {
    serve(automation());
    const editor = await openEmailStep();
    within(editor).getByRole('heading', { name: 'Step 1 · Send email' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByTestId('flow')).toBeVisible();
    expect(screen.queryByTestId('email-editor')).toBeNull();
  });
});

describe('send_notification panel (T522)', () => {
  it('picks recipients, link and skip_actor', async () => {
    const calls = serve(automation([]));
    await renderApp(PAGE);
    await screen.findByTestId('flow');
    await userEvent.click(screen.getByTestId('add-step'));
    const menu = await screen.findByTestId('add-step-menu');
    await userEvent.click(within(menu).getByTestId('add-send_notification'));
    const panel = await screen.findByTestId('config-panel');
    expect(within(panel).getByTestId('notification-note')).toHaveTextContent(
      'People who cannot read the record or a field used in the text do not receive it',
    );
    await userEvent.click(within(panel).getByTestId('notification-add'));
    const picker = await screen.findByTestId('value-picker');
    await userEvent.click(within(picker).getByRole('option', { name: 'Owner' }));
    await userEvent.click(within(panel).getByTestId('notification-add'));
    await userEvent.click(
      within(await screen.findByTestId('value-picker')).getByRole('option', {
        name: new RegExp(ME.user.display_name, 'u'),
      }),
    );
    expect(within(panel).getByTestId('notification-recipients')).toHaveTextContent(
      `Owner${ME.user.display_name}`,
    );
    await userEvent.click(within(panel).getByTestId('notification-skip-actor'));
    await userEvent.selectOptions(within(panel).getByTestId('notification-link'), 'none');
    await userEvent.click(screen.getByTestId('builder-save'));
    // The title is still empty: the check names it, nothing is sent.
    expect(await screen.findByTestId('issue-summary')).toHaveTextContent('Step 1:');
    expect(calls.saves).toHaveLength(0);
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
