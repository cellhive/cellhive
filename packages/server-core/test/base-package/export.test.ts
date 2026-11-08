import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ATTACHMENTS_ENTRY,
  basePackageLimits,
  dataEntry,
  exportBasePackage,
  fileEntry,
  linksEntry,
  openBasePackage,
  packageAttachmentsSchema,
  packageAutomationsSchema,
  packageBaseSchema,
  packageLinkSchema,
  packageRecordSchema,
  packageRolesSchema,
  packageTablesSchema,
  packageViewsSchema,
  SCHEMA_ENTRIES,
  type BaseExportSchema,
  type BaseExportSource,
  type ExportCellFile,
  type ExportDetachedRef,
  type ExportedBasePackage,
} from '../../src/base-package/index.js';
import { AppError } from '../../src/errors/app-error.js';

import { scratch } from './zip-builder.js';

import type { StoredRecordOutput } from '../../src/records/types.js';
import type { Id } from '@cellhive/contracts';

/** `exportBasePackage` over a fake source, read back with the reader (BACKLOG T1017). */

const id = <P extends string>(prefix: P, label: string): `${P}_${string}` =>
  `${prefix}_${label.padEnd(16, '0')}`;

const B = id('bse', 'Sales');
const T_ORD = id('tbl', 'Orders');
const T_CUS = id('tbl', 'Customers');
const F = {
  name: id('fld', 'Name'),
  status: id('fld', 'Status'),
  owner: id('fld', 'Owner'),
  files: id('fld', 'Files'),
  customer: id('fld', 'Customer'),
  total: id('fld', 'Total'),
  parent: id('fld', 'Parent'),
  /** In the trash: the package does not hold it. */
  price: id('fld', 'Price'),
  cusName: id('fld', 'CusName'),
  orders: id('fld', 'Orders'),
};
const O = { new: id('opt', 'New'), done: id('opt', 'Done') };
const V = { grid: id('viw', 'Grid'), form: id('viw', 'Form') };
const D1 = id('dsh', 'Sales');
const W1 = id('wgt', 'Kpi');
const A1 = id('aut', 'Main');
const ROLE = id('rol', 'Sales');
const R = {
  o1: id('rec', 'O1'),
  o2: id('rec', 'O2'),
  c1: id('rec', 'C1'),
  /** In the trash. */
  gone: id('rec', 'Trashed'),
};
const ATT = {
  file: id('att', 'File'),
  /** Not ready (an upload never completed): never in a package. */
  pending: id('att', 'Pending'),
  cover: id('att', 'Cover'),
  asset: id('att', 'Asset'),
};
const USR = { member: id('usr', 'Member'), gone: id('usr', 'Gone') };
const SEC = id('sec', 'Bot');
const MEMBER_EMAIL = 'member@example.com';

const field = (
  fieldId: string,
  name: string,
  type: string,
  options: Record<string, unknown> = {},
  extra: { is_primary?: boolean; link_side?: 'a' | 'b' } = {},
) => ({
  id: fieldId as Id<'fld'>,
  name,
  type,
  options,
  is_primary: extra.is_primary ?? false,
  required: false,
  unique_values: false,
  description: null,
  position: 0,
  link_side: extra.link_side ?? null,
  result_type: null,
});

function schemaOf(): BaseExportSchema {
  return {
    base: {
      id: B,
      name: 'Sales',
      description: 'The sales base',
      icon: null,
      settings: { timezone: 'Asia/Ho_Chi_Minh' },
    },
    tables: [
      {
        id: T_ORD,
        name: 'Orders',
        description: null,
        position: 0,
        primary_field_id: F.name,
        fields: [
          field(F.name, 'Name', 'text', {}, { is_primary: true }),
          field(F.status, 'Status', 'select', {
            multiple: false,
            options: [
              { id: O.new, name: 'New' },
              { id: O.done, name: 'Done' },
            ],
          }),
          field(F.owner, 'Owner', 'user', {
            multiple: true,
            default_value: [{ id: USR.member }],
          }),
          field(F.files, 'Files', 'attachment'),
          field(
            F.customer,
            'Customer',
            'link',
            { link_table: T_CUS, symmetric_field_id: F.orders, allow_multiple: true },
            { link_side: 'a' },
          ),
          field(F.total, 'Total', 'formula', { expression: `[${F.price}] * 2` }),
          field(F.parent, 'Parent', 'parent'),
        ],
      },
      {
        id: T_CUS,
        name: 'Customers',
        description: null,
        position: 1,
        primary_field_id: F.cusName,
        fields: [
          field(F.cusName, 'Name', 'text', {}, { is_primary: true }),
          field(
            F.orders,
            'Orders',
            'link',
            { link_table: T_ORD, symmetric_field_id: F.customer, allow_multiple: true },
            { link_side: 'b' },
          ),
        ],
      },
    ],
    views: [
      {
        id: V.grid,
        table_id: T_ORD,
        type: 'grid',
        name: 'Grid',
        position: 0,
        locked: false,
        config: {
          filter: {
            op: 'and',
            items: [
              { field: F.status, operator: 'is', value: O.new },
              { field: F.owner, operator: 'has_any_of', value: [USR.member, USR.gone] },
              { field: F.price, operator: 'gt', value: 1 },
            ],
          },
          sort: [],
          group: [],
          hidden_fields: [F.price],
          field_order: [F.name, F.status],
        },
      },
      {
        id: V.form,
        table_id: T_ORD,
        type: 'form',
        name: 'Form',
        position: 1,
        locked: false,
        config: { form: { cover_attachment_id: ATT.cover, fields: [{ field: F.name }] } },
      },
    ],
    personalViews: 2,
    dashboards: [
      {
        id: D1,
        name: 'Sales',
        icon: null,
        description: null,
        theme: {},
        global_filters: [],
        position: 0,
        widgets: [
          {
            id: W1,
            type: 'kpi',
            title: 'Orders',
            config: { table_id: T_ORD, metric: { aggregate: 'count' } },
            layout: { x: 0, y: 0, w: 3, h: 2 },
          },
        ],
      },
    ],
    automations: [
      {
        id: A1,
        name: 'Notify',
        description: '',
        definition: {
          trigger: { type: 'record.created', config: { table_id: T_ORD } },
          condition: { field: F.customer, operator: 'has_any_of', value: [R.gone] },
          actions: [
            {
              id: 'act_1',
              type: 'send_telegram',
              config: { secret_id: SEC, chat_id: { literal: '42' }, text: { template: 'Hi' } },
            },
            {
              id: 'act_2',
              type: 'send_email',
              config: {
                identity_id: null,
                to: [{ literal: 'buyer@example.org' }],
                cc: [],
                bcc: [],
                reply_to: null,
                subject: { template: 'Order' },
                body: { format: 'markdown', template: `![logo](asset:${ATT.asset})` },
                include_signature: false,
                footer: 'minimal',
                attachments: [],
                on_missing_attachment: 'fail',
              },
            },
          ],
        },
      },
    ],
    roles: [
      {
        id: ROLE,
        name: 'Sales',
        position: 3,
        config: {
          base_rule: { copy: false, download: false, share_link: false },
          tables: {
            [T_ORD]: {
              perm: 'edit',
              record_rule: {
                operations: ['add'],
                read_scope: 'all',
                edit_filter: {
                  op: 'and',
                  items: [{ field: F.owner, operator: 'has_any_of', value: [USR.member] }],
                },
                read_filter: null,
              },
            },
          },
          dashboards: {},
        },
      },
    ],
  };
}

const stored = (
  recordId: Id<'rec'>,
  auto: number,
  fields: Record<string, unknown>,
  extra: Partial<StoredRecordOutput> = {},
): StoredRecordOutput => ({
  id: recordId,
  created_at: '2026-01-02T03:04:05.000Z',
  updated_at: '2026-01-03T03:04:05.000Z',
  created_by: USR.member,
  updated_by: USR.gone,
  auto,
  fields: fields as StoredRecordOutput['fields'],
  ...extra,
});

const CONTENT = {
  file: Buffer.from('%PDF-1.7 invoice'),
  cover: randomBytes(2048),
  asset: randomBytes(512),
};

class FakeSource implements BaseExportSource {
  readonly detachedAsked: ExportDetachedRef[] = [];

  constructor(
    private readonly base: BaseExportSchema = schemaOf(),
    private readonly rows: Record<string, StoredRecordOutput[][]> = {
      [T_ORD]: [
        [
          stored(
            R.o1,
            1,
            {
              [F.name]: 'First order',
              [F.status]: [O.done],
              [F.owner]: [USR.member, USR.gone],
              [F.files]: [
                { id: ATT.file, name: 'invoice.pdf', size: 16, mime: 'application/pdf' },
                { id: ATT.pending, name: 'x.pdf', size: 1, mime: 'application/pdf' },
              ],
              // A record that left meanwhile: no junction row for it.
              [F.customer]: [R.c1, R.gone],
            },
            { parent_id: null },
          ),
        ],
        [stored(R.o2, 2, { [F.name]: 'Second', [F.customer]: null }, { parent_id: R.o1 })],
      ],
      [T_CUS]: [[stored(R.c1, 1, { [F.cusName]: 'ACME', [F.orders]: [R.o1] })]],
    },
  ) {}

  schema() {
    return Promise.resolve(this.base);
  }

  memberEmails() {
    return Promise.resolve(new Map([[USR.member, MEMBER_EMAIL]]));
  }

  openRecords(tableId: Id<'tbl'>) {
    const batches = this.rows[tableId] ?? [];
    return Promise.resolve({
      rowCount: batches.flat().length,
      async *records() {
        for (const batch of batches) {
          await Promise.resolve();
          yield batch;
        }
      },
    });
  }

  cellFiles(tableId: Id<'tbl'>, ids: readonly Id<'att'>[]): Promise<ExportCellFile[]> {
    return Promise.resolve(
      ids.includes(ATT.file) && tableId === T_ORD
        ? [
            {
              id: ATT.file,
              filename: 'invoice.pdf',
              mime: 'application/pdf',
              object: 'org/file',
              tableId: T_ORD,
              fieldId: F.files,
              recordId: R.o1,
            },
          ]
        : [],
    );
  }

  formCovers(ids: readonly Id<'att'>[]) {
    return Promise.resolve(
      ids.includes(ATT.cover)
        ? [
            {
              id: ATT.cover,
              filename: 'cover.png',
              mime: 'image/png',
              object: 'org/cover',
              tableId: T_ORD,
              viewId: V.form,
            },
          ]
        : [],
    );
  }

  emailAssets(ids: readonly Id<'att'>[]) {
    return Promise.resolve(
      ids.includes(ATT.asset)
        ? [
            {
              id: ATT.asset,
              filename: 'logo.png',
              mime: 'image/png',
              object: 'org/asset',
              width: 64,
              height: 32,
            },
          ]
        : [],
    );
  }

  detachedNames(refs: readonly ExportDetachedRef[]) {
    this.detachedAsked.push(...refs);
    return Promise.resolve(new Map([[SEC, 'Sales bot']]));
  }

  openFile(object: string) {
    const content =
      object === 'org/file'
        ? CONTENT.file
        : object === 'org/cover'
          ? CONTENT.cover
          : object === 'org/asset'
            ? CONTENT.asset
            : null;
    if (content === null) return Promise.reject(new Error(`no object ${object}`));
    return Promise.resolve(Readable.from([content]));
  }
}

let dir: Awaited<ReturnType<typeof scratch>>;
let counter = 0;

beforeAll(async () => {
  dir = await scratch();
});

afterAll(async () => {
  await dir.cleanup();
});

async function exportOf(
  source: BaseExportSource,
  limits = basePackageLimits(),
  progress: number[] = [],
): Promise<{ path: string; exported: ExportedBasePackage }> {
  counter += 1;
  const path = dir.path(`export-${String(counter)}.chbase`);
  const tempDir = dir.path(`temp-${String(counter)}`);
  await mkdir(tempDir);
  const exported = await exportBasePackage(source, {
    path,
    tempDir,
    limits,
    appVersion: '0.1.0',
    exportedAt: new Date('2026-11-08T10:00:00.000Z'),
    exportedByEmail: MEMBER_EMAIL,
    onProgress: (value) => {
      progress.push(value);
    },
  });
  return { path, exported };
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('exportBasePackage', () => {
  it('writes a package the reader accepts, with every entry and the counts', async () => {
    const progress: number[] = [];
    const { path, exported } = await exportOf(new FakeSource(), basePackageLimits(), progress);
    expect(exported.bytes).toBe((await stat(path)).size);
    const reader = await openBasePackage(path);
    try {
      await reader.verifyAll();
      expect(reader.manifest).toMatchObject({
        app_version: '0.1.0',
        exported_by_email: MEMBER_EMAIL,
        base: { id: B, name: 'Sales' },
        skipped: { personal_views: 2 },
        counts: {
          tables: 2,
          fields: 9,
          records: 3,
          links: 1,
          attachments: 3,
          views: 2,
          dashboards: 1,
          widgets: 1,
          automations: 1,
          roles: 1,
        },
      });
      expect(exported.counts).toEqual(reader.manifest.counts);
      expect(exported.skippedPersonalViews).toBe(2);
      expect(
        reader
          .entries()
          .map((entry) => entry.name)
          .sort(),
      ).toEqual(
        [
          'manifest.json',
          ...Object.values(SCHEMA_ENTRIES),
          ATTACHMENTS_ENTRY,
          dataEntry(T_ORD),
          dataEntry(T_CUS),
          linksEntry(F.customer),
          fileEntry(ATT.file),
          fileEntry(ATT.cover),
          fileEntry(ATT.asset),
        ].sort(),
      );
      const sum = reader.entries().reduce((total, entry) => total + entry.uncompressedSize, 0);
      // Every entry but the manifest.
      expect(exported.uncompressedBytes).toBe(
        sum - (reader.entry('manifest.json')?.uncompressedSize ?? 0),
      );
    } finally {
      reader.close();
    }
    // Phases in order, never past the upload of the caller.
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(0)).toBe(0);
    expect(progress.at(-1)).toBeCloseTo(0.97);
  });

  it('records: storage form, users as emails, own files only, junction of live pairs', async () => {
    const { path } = await exportOf(new FakeSource());
    const reader = await openBasePackage(path);
    try {
      const orders = [];
      for await (const { value } of reader.readNdjson(dataEntry(T_ORD), packageRecordSchema)) {
        orders.push(value);
      }
      expect(orders).toEqual([
        {
          id: R.o1,
          created_at: '2026-01-02T03:04:05.000Z',
          updated_at: '2026-01-03T03:04:05.000Z',
          created_by_email: MEMBER_EMAIL,
          // Not a member any more: one placeholder per user.
          updated_by_email: 'unknown-1@cellhive.invalid',
          auto: 1,
          parent_id: null,
          fields: {
            [F.name]: 'First order',
            [F.status]: [O.done],
            [F.owner]: [MEMBER_EMAIL, 'unknown-1@cellhive.invalid'],
            [F.files]: [{ id: ATT.file, name: 'invoice.pdf', size: 16, mime: 'application/pdf' }],
          },
        },
        {
          id: R.o2,
          created_at: '2026-01-02T03:04:05.000Z',
          updated_at: '2026-01-03T03:04:05.000Z',
          created_by_email: MEMBER_EMAIL,
          updated_by_email: 'unknown-1@cellhive.invalid',
          auto: 2,
          parent_id: R.o1,
          fields: { [F.name]: 'Second' },
        },
      ]);
      const links = [];
      for await (const { value } of reader.readNdjson(linksEntry(F.customer), packageLinkSchema)) {
        links.push(value);
      }
      expect(links).toEqual([{ a: R.o1, b: R.c1, position: 0 }]);
      const attachments = await reader.readJson(ATTACHMENTS_ENTRY, packageAttachmentsSchema);
      expect(attachments.files).toEqual(
        expect.arrayContaining([
          {
            id: ATT.file,
            kind: 'cell',
            filename: 'invoice.pdf',
            mime: 'application/pdf',
            size: CONTENT.file.length,
            sha256: sha(CONTENT.file),
            table_id: T_ORD,
            field_id: F.files,
            record_id: R.o1,
          },
          {
            id: ATT.cover,
            kind: 'form_cover',
            filename: 'cover.png',
            mime: 'image/png',
            size: CONTENT.cover.length,
            sha256: sha(CONTENT.cover),
            table_id: T_ORD,
            view_id: V.form,
          },
          {
            id: ATT.asset,
            kind: 'email_asset',
            filename: 'logo.png',
            mime: 'image/png',
            size: CONTENT.asset.length,
            sha256: sha(CONTENT.asset),
            automation_id: A1,
            width: 64,
            height: 32,
          },
        ]),
      );
      const content: Buffer[] = [];
      for await (const chunk of await reader.open(fileEntry(ATT.cover))) {
        content.push(chunk as Buffer);
      }
      expect(Buffer.concat(content).equals(CONTENT.cover)).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('schema: references the package does not hold are dropped or listed, secrets by name', async () => {
    const source = new FakeSource();
    const { path } = await exportOf(source);
    const raw = (await readFile(path)).toString('latin1');
    const reader = await openBasePackage(path);
    try {
      const base = await reader.readJson(SCHEMA_ENTRIES.base, packageBaseSchema);
      // The trashed field in the formula, the trashed record in the condition.
      expect(base.missing_ids).toEqual([F.price, R.gone].sort());
      expect(base.settings).toEqual({ timezone: 'Asia/Ho_Chi_Minh' });
      const tables = await reader.readJson(SCHEMA_ENTRIES.tables, packageTablesSchema);
      const owner = tables.tables[0]?.fields.find((item) => item.id === F.owner);
      expect(owner?.options['default_value']).toEqual([{ id: MEMBER_EMAIL }]);
      const views = await reader.readJson(SCHEMA_ENTRIES.views, packageViewsSchema);
      const grid = views.views.find((view) => view.id === V.grid);
      // A view filter on a field out of the package is left out, as reads ignore it.
      expect(grid?.config['filter']).toEqual({
        op: 'and',
        items: [
          { field: F.status, operator: 'is', value: O.new },
          {
            field: F.owner,
            operator: 'has_any_of',
            value: [MEMBER_EMAIL, 'unknown-1@cellhive.invalid'],
          },
        ],
      });
      expect(grid?.config['hidden_fields']).toEqual([]);
      const automations = await reader.readJson(
        SCHEMA_ENTRIES.automations,
        packageAutomationsSchema,
      );
      expect(automations.automations[0]?.detached).toEqual([
        { path: 'actions[0].config.secret_id', kind: 'secret', name: 'Sales bot' },
      ]);
      expect(source.detachedAsked).toEqual([{ kind: 'secret', id: SEC }]);
      const roles = await reader.readJson(SCHEMA_ENTRIES.roles, packageRolesSchema);
      expect(JSON.stringify(roles)).toContain(MEMBER_EMAIL);
    } finally {
      reader.close();
    }
    // No user id, no secret id anywhere (the deflated entries are checked through the reader).
    expect(raw).not.toContain('usr_');
    const reread = await openBasePackage(path);
    try {
      for (const entry of reread.entries()) {
        if (entry.name.startsWith('files/att_')) continue;
        const chunks: Buffer[] = [];
        for await (const chunk of await reread.open(entry.name)) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString('utf8');
        expect(text, entry.name).not.toMatch(/usr_[0-9A-Za-z]{16}/u);
        expect(text, entry.name).not.toContain(SEC);
      }
    } finally {
      reread.close();
    }
  });

  it('a package over BASE_PACKAGE_MAX_BYTES fails with PACKAGE_TOO_LARGE', async () => {
    const noise = randomBytes(1_200_000).toString('base64');
    const source = new FakeSource(schemaOf(), {
      [T_ORD]: [[stored(R.o1, 1, { [F.name]: noise })]],
      [T_CUS]: [],
    });
    const error = await exportOf(source, basePackageLimits(1024 * 1024)).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION_FAILED');
    expect((error as AppError).errors?.[0]).toMatchObject({
      code: 'PACKAGE_TOO_LARGE',
      params: { limit: 1024 * 1024 },
    });
  });

  it('a base of repeated text compresses past 20× and fails as the reader would', async () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        stored(id('rec', `R${String(index)}`), index + 1, {
          [F.name]: 'Đơn hàng giao trong ngày, khách đã thanh toán đủ'.repeat(4),
          [F.status]: [O.new],
        }),
      );
    const repeated = () =>
      new FakeSource(schemaOf(), { [T_ORD]: [rows(2000), rows(2000)], [T_CUS]: [] });
    const error = await exportOf(repeated()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_PACKAGE');
    expect((error as AppError).errors?.[0]).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      params: { reason: 'uncompressed_bytes' },
    });
    // Without the ratio cap, the same base: far above 20×.
    const { exported } = await exportOf(
      repeated(),
      basePackageLimits(undefined, { maxCompressionRatio: 10_000 }),
    );
    expect(exported.uncompressedBytes / exported.bytes).toBeGreaterThan(20);
  });

  it('a failing source stops the export', async () => {
    const source = new FakeSource();
    source.openFile = () => Promise.reject(new Error('storage down'));
    await expect(exportOf(source)).rejects.toThrow('storage down');
  });
});
