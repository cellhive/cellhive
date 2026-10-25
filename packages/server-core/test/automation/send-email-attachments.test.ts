import { Readable } from 'node:stream';

import {
  automationDefinitionSchema,
  EMAIL_MAX_MESSAGE_BYTES,
  sendEmailConfigSchema,
  type AutomationDefinitionInput,
  type EffectiveAccess,
  type Id,
  type TableAccess,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  attachmentParts,
  base64Size,
  blockedEmailExtension,
  messageByteLimit,
  planEmailAttachments,
  validateAutomationDefinition,
  type AttachmentFileRow,
  type AutomationFieldMeta,
  type PlanAttachmentsInput,
} from '../../src/automation/index.js';
import { effectiveAttachmentLimits } from '../../src/mail/settings/org-email-settings.js';

import type { StorageDriver } from '../../src/storage/storage-driver.js';

const MIB = 1024 * 1024;
const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const F = {
  title: 'fld_OrdersTitle00001',
  owner: 'fld_OrdersOwner00001',
  files: 'fld_OrdersFiles00001',
  secret: 'fld_OrdersSecret0001',
  hidden: 'fld_OrdersHidden0001',
} as const satisfies Record<string, Id<'fld'>>;

const FIELDS: AutomationFieldMeta[] = [
  { id: F.title, table_id: ORDERS, name: 'title', type: 'text', options: {} },
  { id: F.owner, table_id: ORDERS, name: 'owner', type: 'user', options: {} },
  { id: F.files, table_id: ORDERS, name: 'files', type: 'attachment', options: {} },
  { id: F.secret, table_id: ORDERS, name: 'secret', type: 'attachment', options: {} },
  { id: F.hidden, table_id: ORDERS, name: 'hidden', type: 'attachment', options: {} },
];

function tableAccess(): TableAccess {
  return {
    perm: 'manage',
    operations: ['add', 'delete'],
    view_rule: { allow_edit: true, visible_views: null },
    read_scope: 'all',
    // `hidden` is not readable; `secret` is readable but not downloadable.
    fields: { [F.title]: 'edit', [F.owner]: 'edit', [F.files]: 'edit', [F.secret]: 'read' },
    option_edit_fields: [],
    file_download_fields: [F.files],
  };
}

const ACCESS: EffectiveAccess = {
  role: null,
  is_admin: false,
  base_rule: { copy: true, download: true, share_link: true },
  tables: { [ORDERS]: tableAccess() },
  dashboards: {},
};

function errorsOf(
  attachments: unknown[],
  trigger: AutomationDefinitionInput['trigger'] = { type: 'record.created', table_id: ORDERS },
) {
  const result = validateAutomationDefinition(
    automationDefinitionSchema.parse({
      trigger,
      actions: [
        {
          id: 'act_mail',
          type: 'send_email',
          config: {
            to: [{ literal: 'a@b.vn' }],
            subject: { template: 'Hi' },
            body: { format: 'markdown', template: 'Hi' },
            attachments,
          },
        },
      ],
    }),
    { tables: [{ id: ORDERS, name: 'Orders' }], fields: FIELDS, access: ACCESS },
  );
  return result.ok ? [] : result.errors.map(({ path, code }) => ({ path, code }));
}

const AT = 'definition.actions[0].config.attachments';

describe('send_email attachments: contract (BACKLOG T532)', () => {
  const base = {
    to: [{ literal: 'a@b.vn' }],
    subject: { template: 'Hi' },
    body: { format: 'markdown', template: 'Hi' },
  };

  it('defaults to no attachments and fail on missing files', () => {
    const parsed = sendEmailConfigSchema.parse(base);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.on_missing_attachment).toBe('fail');
  });

  it.each([
    ['six fields', { attachments: Array.from({ length: 6 }, () => ({ field: F.files })) }],
    ['an unknown mode', { on_missing_attachment: 'ignore' }],
    ['a non-field source', { attachments: [{ url: 'https://x.test/a.pdf' }] }],
  ])('refuses %s', (_name, extra) => {
    expect(sendEmailConfigSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });
});

describe('send_email attachments: save-time checks (BACKLOG T532)', () => {
  it.each([
    ['a downloadable attachment field', [{ field: F.files }], []],
    [
      'a text field',
      [{ field: F.title }],
      [{ path: `${AT}[0].field`, code: 'ATTACHMENT_FIELD_INVALID' }],
    ],
    [
      'a field whose files cannot be downloaded',
      [{ field: F.secret }],
      [{ path: `${AT}[0].field`, code: 'ATTACHMENT_FIELD_NOT_DOWNLOADABLE' }],
    ],
    [
      'an unreadable field (no existence leak)',
      [{ field: F.hidden }],
      [{ path: `${AT}[0].field`, code: 'UNKNOWN_FIELD' }],
    ],
    [
      'a field of nowhere',
      [{ field: 'fld_Missing000000001' }],
      [{ path: `${AT}[0].field`, code: 'UNKNOWN_FIELD' }],
    ],
    [
      'the same field twice',
      [{ field: F.files }, { field: F.files }],
      [{ path: `${AT}[1].field`, code: 'ATTACHMENT_FIELD_INVALID' }],
    ],
  ])('%s', (_name, attachments, expected) => {
    expect(errorsOf(attachments)).toEqual(expected);
  });

  it('refuses attachments on a trigger without record', () => {
    expect(
      errorsOf([{ field: F.files }], {
        type: 'schedule',
        cron: '0 8 * * *',
        timezone: null,
      } as never),
    ).toEqual([{ path: `${AT}[0].field`, code: 'ATTACHMENT_FIELD_INVALID' }]);
  });
});

describe('blockedEmailExtension (BACKLOG T532)', () => {
  it.each([
    ['quyet-dinh.pdf', 'application/pdf', null],
    ['Báo cáo.DOCX', 'application/vnd.openxmlformats', null],
    ['setup.exe', 'application/octet-stream', 'exe'],
    ['script.JS', 'text/javascript', 'js'],
    ['page.html', 'text/plain', 'html'],
    ['page.htm', 'text/plain', 'htm'],
    ['page.xhtml', 'text/plain', 'xhtml'],
    ['logo.svg', 'image/svg+xml', 'svg'],
    ['logo.svg. ', 'image/png', 'svg'],
    ['renamed.txt', 'text/html; charset=utf-8', 'html'],
    ['renamed.png', 'image/svg+xml', 'svg'],
    ['disk.iso', 'application/octet-stream', 'iso'],
    ['noext', 'application/octet-stream', null],
  ])('%s (%s) → %s', (name, mime, expected) => {
    expect(blockedEmailExtension(name, mime)).toBe(expected);
  });
});

describe('planEmailAttachments (BACKLOG T532)', () => {
  const REC = 'rec_Record0000000001';
  function row(id: string, overrides: Partial<AttachmentFileRow> = {}): AttachmentFileRow {
    return {
      id,
      field_id: F.files,
      record_id: REC,
      object_key: `org_x/${id}`,
      filename: `${id}.pdf`,
      mime: 'application/pdf',
      size: MIB,
      status: 'ready',
      detached_at: null,
      record_purged_at: null,
      ...overrides,
    };
  }
  function plan(
    rows: AttachmentFileRow[],
    overrides: Partial<PlanAttachmentsInput> = {},
  ): ReturnType<typeof planEmailAttachments> {
    return planEmailAttachments({
      recordId: REC,
      sources: [{ fieldId: F.files, allowed: true, fileIds: rows.map((item) => item.id) }],
      rows: new Map(rows.map((item) => [item.id, item])),
      onMissing: 'fail',
      limits: { maxAttachments: 10, maxAttachmentBytes: 15 * MIB },
      ...overrides,
    });
  }

  it('attaches ready files with their total size', () => {
    const result = plan([row('att_a'), row('att_b', { size: 2 * MIB })]);
    expect(result).toMatchObject({ ok: true, bytes: 3 * MIB, skipped: 0 });
    if (result.ok) expect(result.files.map((file) => file.id)).toEqual(['att_a', 'att_b']);
  });

  it('fails on a field run_as may not download, even with skip', () => {
    expect(
      plan([row('att_a')], {
        onMissing: 'skip',
        sources: [{ fieldId: F.files, allowed: false, fileIds: ['att_a'] }],
      }),
    ).toEqual({ ok: false, code: 'attachment_access_denied', params: { field_id: F.files } });
  });

  it.each([
    ['pending_scan', row('att_a', { status: 'pending_scan' })],
    ['pending_upload', row('att_a', { status: 'pending_upload' })],
    ['detached', row('att_a', { detached_at: new Date() })],
    ['purged record', row('att_a', { record_purged_at: new Date() })],
    ['another record', row('att_a', { record_id: 'rec_Other00000000001' })],
    ['another field', row('att_a', { field_id: F.secret })],
  ])('%s → attachment_not_ready, or skipped and counted', (_name, bad) => {
    const failed = plan([bad, row('att_b')]);
    expect(failed).toMatchObject({ ok: false, code: 'attachment_not_ready' });
    const skipped = plan([bad, row('att_b')], { onMissing: 'skip' });
    expect(skipped).toMatchObject({ ok: true, skipped: 1, bytes: MIB });
  });

  it('a missing row is not ready', () => {
    expect(
      plan([], { sources: [{ fieldId: F.files, allowed: true, fileIds: ['att_gone'] }] }),
    ).toMatchObject({ ok: false, code: 'attachment_not_ready' });
  });

  it('blocks Gmail and HTML/SVG types', () => {
    expect(plan([row('att_a', { filename: 'logo.svg', mime: 'image/svg+xml' })])).toEqual({
      ok: false,
      code: 'attachment_type_blocked',
      params: { field_id: F.files, extension: 'svg' },
    });
  });

  it('11 files over a limit of 10 → too_many_attachments, nothing dropped', () => {
    const rows = Array.from({ length: 11 }, (_, index) => row(`att_${String(index)}`));
    expect(plan(rows)).toEqual({
      ok: false,
      code: 'too_many_attachments',
      params: { count: 11, limit: 10 },
    });
  });

  it('16 MiB over 15 MiB → attachments_too_large; inline images count too', () => {
    expect(plan([row('att_a', { size: 16 * MIB })])).toEqual({
      ok: false,
      code: 'attachments_too_large',
      params: { bytes: 16 * MIB, limit: 15 * MIB },
    });
    expect(plan([row('att_a', { size: 14 * MIB })], { inlineBytes: 2 * MIB })).toMatchObject({
      ok: false,
      code: 'attachments_too_large',
    });
  });

  it('checks the whole encoded message last', () => {
    const result = plan([row('att_a', { size: 14 * MIB })], {
      limits: { maxAttachments: 10, maxAttachmentBytes: 30 * MIB },
      bodyBytes: 1000,
      messageLimit: 15 * MIB,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'attachments_too_large',
      params: { scope: 'message' },
    });
  });

  it('never puts a file name in the params', () => {
    const result = plan([row('att_a', { filename: 'Lương tháng 9.exe' })]);
    expect(JSON.stringify(result)).not.toContain('Lương');
  });
});

describe('attachment limits (BACKLOG T532)', () => {
  const instance = { maxAttachments: 10, maxAttachmentBytes: 15 * MIB, maxHtmlBytes: 102_400 };

  it.each([
    [{ maxAttachments: null, maxAttachmentBytes: null }, 10, 15 * MIB],
    [{ maxAttachments: 3, maxAttachmentBytes: 5 * MIB }, 3, 5 * MIB],
    // The operator lowered the caps after the organization chose more.
    [{ maxAttachments: 20, maxAttachmentBytes: 30 * MIB }, 10, 15 * MIB],
  ])('organization %j → %d files, %d bytes', (org, files, bytes) => {
    expect(effectiveAttachmentLimits(instance, org)).toEqual({
      maxAttachments: files,
      maxAttachmentBytes: bytes,
    });
  });

  it('the message limit is 25 MiB, or what a raised instance cap needs', () => {
    expect(messageByteLimit(instance)).toBe(EMAIL_MAX_MESSAGE_BYTES);
    const raised = messageByteLimit({ ...instance, maxAttachmentBytes: 30 * MIB });
    expect(raised).toBeGreaterThan(base64Size(30 * MIB));
  });

  it('base64 grows by 4/3 plus line breaks', () => {
    expect(base64Size(3)).toBe(4 + 2);
    expect(base64Size(57)).toBe(76 + 2);
    expect(base64Size(0)).toBe(0);
  });
});

describe('attachmentParts (BACKLOG T532)', () => {
  function storage(objects: Record<string, Buffer | null>): {
    driver: StorageDriver;
    opened: string[];
  } {
    const opened: string[] = [];
    const driver = {
      getStream: (key: string) => {
        opened.push(key);
        const body = objects[key];
        return Promise.resolve(body === null || body === undefined ? null : Readable.from([body]));
      },
    } as unknown as StorageDriver;
    return { driver, opened };
  }
  const file = (id: string, size: number, filename = `${id}.pdf`) => ({
    id,
    fieldId: F.files,
    filename,
    mime: 'application/pdf',
    size,
    objectKey: `org_x/${id}`,
  });

  async function read(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  it('opens storage only when read, and passes the bytes through', async () => {
    const { driver, opened } = storage({ 'org_x/att_a': Buffer.from('%PDF-1.7 hello') });
    const [part] = attachmentParts(driver, [file('att_a', 14, 'Quyết\u0000 định.pdf')]);
    expect(opened).toEqual([]);
    expect(part?.filename).toBe('Quyết định.pdf');
    expect(part?.contentType).toBe('application/pdf');
    if (part === undefined) return;
    expect((await read(part.content)).toString()).toBe('%PDF-1.7 hello');
    expect(opened).toEqual(['org_x/att_a']);
  });

  it('fails without the key or the name when the object is missing or larger', async () => {
    const { driver } = storage({ 'org_x/att_a': null, 'org_x/att_b': Buffer.alloc(20) });
    const [missing, larger] = attachmentParts(driver, [
      file('att_a', 10, 'Bí mật.pdf'),
      file('att_b', 10),
    ]);
    if (missing === undefined || larger === undefined) return;
    const error = await read(missing.content).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/att_a|Bí mật/);
    await expect(read(larger.content)).rejects.toThrow('larger than recorded');
  });
});
