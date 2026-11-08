import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BasePackageWriter,
  checkImportedFile,
  importBasePackage,
  isInvalidPackage,
  openBasePackage,
  planBaseImport,
  type BaseImportTarget,
  type ImportPlan,
} from '../../src/index.js';

import { ZIP_TEST_TIMEOUT_MS } from './zip-builder.js';

import type { Id } from '@cellhive/contracts';

const id = (prefix: string, label: string): string => `${prefix}_${label.padEnd(16, '0')}`;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const MEMBER = { id: 'usr_Member0000000000' as Id<'usr'>, email: 'an@example.com' };
const T = { orders: id('tbl', 'Orders'), customers: id('tbl', 'Customers') };
const F = {
  title: id('fld', 'Title'),
  amount: id('fld', 'Amount'),
  status: id('fld', 'Status'),
  owner: id('fld', 'Owner'),
  files: id('fld', 'Files'),
  summary: id('fld', 'Summary'),
  total: id('fld', 'Total'),
  customer: id('fld', 'Customer'),
  parent: id('fld', 'Parent'),
  name: id('fld', 'Name'),
  orders: id('fld', 'Orders'),
};
const O = { open: id('opt', 'Open'), done: id('opt', 'Done') };
const R = {
  one: id('rec', 'One'),
  two: id('rec', 'Two'),
  three: id('rec', 'Three'),
  cus: id('rec', 'Cus'),
  gone: id('rec', 'Gone'),
};
const ATT = { png: id('att', 'Png'), exe: id('att', 'Exe') };
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40),
]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(40, 0x90)]);

function field(
  fieldId: string,
  name: string,
  type: string,
  options: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: fieldId,
    name,
    type,
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    link_side: null,
    result_type: null,
    ...extra,
  };
}

const linkOptions = (table: string, symmetric: string | null, extra = {}) => ({
  link_table: table,
  bidirectional: symmetric !== null,
  bidirectional_link_field_name: symmetric === null ? null : 'x',
  allow_multiple: true,
  record_filter: null,
  symmetric_field_id: symmetric,
  ...extra,
});

function record(recordId: string, auto: number, fields: Record<string, unknown>, extra = {}) {
  return {
    id: recordId,
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-03T03:04:05.000Z',
    created_by_email: MEMBER.email,
    updated_by_email: 'gone@example.com',
    auto,
    fields,
    ...extra,
  };
}

interface Spec {
  base?: Record<string, unknown>;
  tables: Record<string, unknown>[];
  records: Record<string, unknown[]>;
  links: Record<string, unknown[]>;
  files: { meta: Record<string, unknown>; data: Buffer }[];
  views: unknown[];
  automations: unknown[];
}

/** A package with every shape pass 1 handles: two tables, a link pair, sub-records, files. */
function validSpec(): Spec {
  return {
    tables: [
      {
        id: T.orders,
        name: 'Orders',
        description: null,
        position: 4,
        primary_field_id: F.title,
        fields: [
          field(F.title, 'Title', 'text', {}, { is_primary: true }),
          field(F.amount, 'Amount', 'number', {}, { position: 5 }),
          field(
            F.status,
            'Status',
            'select',
            {
              options: [
                { id: O.open, name: 'Open', color: 0 },
                { id: O.done, name: 'Done', color: 1 },
              ],
            },
            { position: 2 },
          ),
          field(F.owner, 'Owner', 'user', { multiple: true }, { position: 3 }),
          field(F.files, 'Files', 'attachment', { blocked_extensions: [] }, { position: 4 }),
          field(
            F.summary,
            'Summary',
            'text',
            { ai: { prompt: `Sum {{ [${F.title}] }}` } },
            {
              position: 6,
            },
          ),
          field(F.total, 'Total', 'formula', { expression: `[${F.amount}] * 2` }, { position: 7 }),
          field(F.customer, 'Customer', 'link', linkOptions(T.customers, F.orders), {
            position: 1,
            link_side: 'a',
          }),
          field(F.parent, 'Parent', 'parent', {}, { position: 8 }),
        ],
      },
      {
        id: T.customers,
        name: 'Customers',
        description: null,
        position: 1,
        primary_field_id: F.name,
        fields: [
          field(F.name, 'Name', 'text', {}, { is_primary: true }),
          field(F.orders, 'Orders', 'link', linkOptions(T.orders, F.customer), {
            position: 1,
            link_side: 'b',
          }),
        ],
      },
    ],
    records: {
      [T.orders]: [
        record(R.one, 1, {
          [F.title]: 'one',
          [F.amount]: 3,
          [F.status]: [O.open],
          [F.owner]: [MEMBER.email, 'gone@example.com'],
          [F.files]: [
            { id: ATT.png, name: 'a.png', size: PNG.length, mime: 'image/png' },
            { id: ATT.exe, name: 'setup.exe', size: EXE.length, mime: 'application/x-msdownload' },
          ],
          [F.summary]: 'an AI value',
        }),
        record(R.two, 2, { [F.title]: 'two' }, { parent_id: R.one }),
        record(R.three, 5, { [F.title]: 'three' }, { parent_id: R.gone }),
      ],
      [T.customers]: [record(R.cus, 1, { [F.name]: 'An' })],
    },
    links: { [F.customer]: [{ a: R.one, b: R.cus, position: 0 }] },
    files: [
      {
        meta: {
          id: ATT.png,
          kind: 'cell',
          filename: 'a.png',
          mime: 'image/png',
          size: PNG.length,
          sha256: sha256(PNG),
          table_id: T.orders,
          field_id: F.files,
          record_id: R.one,
        },
        data: PNG,
      },
      {
        meta: {
          id: ATT.exe,
          kind: 'cell',
          filename: 'setup.exe',
          mime: 'application/x-msdownload',
          size: EXE.length,
          sha256: sha256(EXE),
          table_id: T.orders,
          field_id: F.files,
          record_id: R.one,
        },
        data: EXE,
      },
    ],
    views: [],
    automations: [],
  };
}

let dir: string;
let serial = 0;

async function writePackage(spec: Spec, options: { skipData?: string } = {}): Promise<string> {
  serial += 1;
  const path = join(dir, `p${String(serial)}.chbase`);
  const writer = await BasePackageWriter.create(path);
  await writer.addJson('schema/base.json', {
    name: 'Sales',
    description: null,
    icon: null,
    settings: { strict_computed_permissions: true, unknown_key: 1 },
    missing_ids: [],
    ...spec.base,
  });
  await writer.addJson('schema/tables.json', { tables: spec.tables });
  await writer.addJson('schema/views.json', { views: spec.views });
  await writer.addJson('schema/dashboards.json', { dashboards: [] });
  await writer.addJson('schema/automations.json', { automations: spec.automations });
  await writer.addJson('schema/roles.json', { roles: [] });
  await writer.addJson('files/attachments.json', { files: spec.files.map((file) => file.meta) });
  for (const [tableId, rows] of Object.entries(spec.records)) {
    if (tableId !== options.skipData) await writer.addNdjson(`data/${tableId}.ndjson`, rows);
  }
  for (const [fieldId, rows] of Object.entries(spec.links)) {
    await writer.addNdjson(`links/${fieldId}.ndjson`, rows);
  }
  for (const file of spec.files) {
    await writer.addFile(`files/${file.meta['id'] as string}`, Readable.from([file.data]), {
      compress: false,
      size: file.data.length,
    });
  }
  await writer.finish({
    app_version: '0.0.0',
    exported_at: '2026-11-08T00:00:00.000Z',
    exported_by_email: null,
    base: { id: 'bse_Source0000000000', name: 'Sales' },
    counts: {
      tables: 0,
      fields: 0,
      records: 0,
      links: 0,
      attachments: 0,
      views: 0,
      dashboards: 0,
      widgets: 0,
      automations: 0,
      roles: 0,
    },
    skipped: { personal_views: 2 },
  });
  return path;
}

async function planOf(path: string): Promise<ImportPlan> {
  const reader = await openBasePackage(path);
  try {
    return await planBaseImport(reader, {
      members: [MEMBER],
      maxFieldsPerTable: 12,
      maxFileBytes: 1024,
    });
  } finally {
    reader.close();
  }
}

async function problemsOf(spec: Spec, options?: { skipData?: string }) {
  try {
    await planOf(await writePackage(spec, options));
  } catch (error) {
    if (!isInvalidPackage(error)) throw error;
    return error.errors ?? [];
  }
  throw new Error('the package was accepted');
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chbase-import-plan-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('planBaseImport (T1018, pass 1)', () => {
  let plan: ImportPlan;

  beforeAll(async () => {
    plan = await planOf(await writePackage(validSpec()));
  }, ZIP_TEST_TIMEOUT_MS);

  it('gives every table and field a new id, in the order of the package', () => {
    expect(plan.tables.map((table) => [table.name, table.position])).toEqual([
      ['Orders', 1],
      ['Customers', 0],
    ]);
    const orders = plan.tables[0];
    expect(orders?.id).not.toBe(T.orders);
    expect(orders?.fields.map((field) => field.name)).toEqual([
      'Title',
      'Customer',
      'Status',
      'Owner',
      'Files',
      'Amount',
      'Summary',
      'Total',
      'Parent',
    ]);
    expect(orders?.primary.source.id).toBe(F.title);
    expect(orders?.parent?.source.id).toBe(F.parent);
    expect(orders?.records).toBe(3);
    expect(plan.records.size).toBe(4);
    expect(plan.records.resolve(R.one)).toMatch(/^rec_[0-9A-Za-z]{16}$/u);
    expect(plan.records.resolve(R.one)).not.toBe(R.one);
  });

  it('keeps only known base settings', () => {
    expect(plan.base.settings).toEqual({ strict_computed_permissions: true });
  });

  it('creates plain fields with their table, link pairs apart, formulas and AI options later', () => {
    const kinds = Object.fromEntries(
      plan.tables.flatMap((table) => table.fields.map((field) => [field.name, field.kind])),
    );
    expect(kinds).toMatchObject({
      Title: 'table',
      Parent: 'table',
      Customer: 'link',
      Orders: 'link',
      Total: 'deferred',
      Summary: 'table',
    });
    expect(plan.deferred.computedFields.map((item) => item.field.name)).toEqual(['Total']);
    const summary = plan.deferred.aiFields[0]?.field;
    expect(summary?.options).not.toHaveProperty('ai');
    expect(summary?.ai?.['prompt']).toBe(`Sum {{ [${plan.tables[0]?.primary.id ?? ''}] }}`);
    expect(plan.links).toHaveLength(1);
    const [link] = plan.links;
    expect(link?.entry).toBe(`links/${F.customer}.ndjson`);
    expect(link?.input.field.options).toMatchObject({
      link_table: plan.tables[1]?.id,
      bidirectional: true,
      symmetric_field_id: link?.reverse?.id,
    });
    expect(link?.input.reverse?.options).toMatchObject({
      link_table: plan.tables[0]?.id,
      symmetric_field_id: link?.field.id,
    });
  });

  it('decides each file like an upload, the default block list always on', () => {
    expect(plan.files.map((file) => [file.source.filename, file.decision])).toEqual([
      ['a.png', { ok: true, filename: 'a.png', mime: 'image/png' }],
      ['setup.exe', { ok: false, reason: 'blocked_file_type', filename: 'setup.exe' }],
    ]);
    expect(plan.files[0]?.cell).toEqual({
      tableId: plan.tables[0]?.id,
      fieldId: plan.tables[0]?.fields.find((field) => field.name === 'Files')?.id,
      recordId: plan.records.resolve(R.one),
    });
  });

  it('matches emails to members only and counts parents the package does not hold', () => {
    expect(plan.users.unmatchedEmails(10)).toEqual({ emails: ['gone@example.com'], total: 1 });
    expect(plan.droppedParents).toBe(1);
  });

  const cases: readonly [string, (spec: Spec) => void, string, string][] = [
    [
      'two tables with one name',
      (spec) => {
        (spec.tables[1] as Record<string, unknown>)['name'] = 'Orders';
      },
      'INVALID_DEFINITION',
      'schema/tables.json#/tables/1/name',
    ],
    [
      'two fields of a table with one name',
      (spec) => {
        const fields = spec.tables[0]?.['fields'] as Record<string, unknown>[];
        (fields[1] as Record<string, unknown>)['name'] = 'Title';
      },
      'INVALID_DEFINITION',
      'schema/tables.json#/tables/0/fields/1/name',
    ],
    [
      'a type this version does not know',
      (spec) => {
        (spec.tables[1]?.['fields'] as unknown[]).push(field(id('fld', 'Odd'), 'Odd', 'hologram'));
      },
      'INVALID_DEFINITION',
      'schema/tables.json#/tables/1/fields/2/type',
    ],
    [
      'options a field type refuses',
      (spec) => {
        const fields = spec.tables[0]?.['fields'] as Record<string, unknown>[];
        (fields[1] as Record<string, unknown>)['options'] = { style: { type: 'nope' } };
      },
      'INVALID_DEFINITION',
      'schema/tables.json#/tables/0/fields/1/options',
    ],
    [
      'unique values on a checkbox',
      (spec) => {
        (spec.tables[1]?.['fields'] as unknown[]).push(
          field(id('fld', 'Check'), 'Check', 'checkbox', {}, { unique_values: true }),
        );
      },
      'INVALID_DEFINITION',
      'schema/tables.json#/tables/1/fields/2/unique_values',
    ],
    [
      'a primary field of a type that has no value',
      (spec) => {
        const table = spec.tables[1] as Record<string, unknown>;
        table['primary_field_id'] = F.orders;
        const fields = table['fields'] as Record<string, unknown>[];
        (fields[0] as Record<string, unknown>)['is_primary'] = false;
        (fields[1] as Record<string, unknown>)['is_primary'] = true;
      },
      'INVALID_DEFINITION',
      'schema/tables.json#/tables/1/primary_field_id',
    ],
    [
      'more fields than the instance allows',
      (spec) => {
        const fields = spec.tables[1]?.['fields'] as unknown[];
        for (let index = 0; index < 11; index += 1) {
          fields.push(
            field(
              id('fld', `More${String(index).padStart(2, '0')}`),
              `More ${String(index)}`,
              'text',
            ),
          );
        }
      },
      'INVALID_DEFINITION',
      'schema/tables.json#/tables/1/fields',
    ],
    [
      'link sides that do not point at each other',
      (spec) => {
        const fields = spec.tables[1]?.['fields'] as Record<string, unknown>[];
        (fields[1] as Record<string, unknown>)['options'] = linkOptions(T.orders, F.name);
      },
      'INVALID_DEFINITION',
      'schema/tables.json#/tables/0/fields/7/options',
    ],
    [
      'the junction of a link missing',
      (spec) => {
        spec.links = {};
      },
      'MISSING_ENTRY',
      `links/${F.customer}.ndjson`,
    ],
    [
      'records not in creation order',
      (spec) => {
        const rows = spec.records[T.orders] as Record<string, unknown>[];
        (rows[1] as Record<string, unknown>)['auto'] = 1;
      },
      'INVALID_ENTRY',
      `data/${T.orders}.ndjson:2#/auto`,
    ],
    [
      'two records with one id',
      (spec) => {
        (spec.records[T.customers] as unknown[]).push(record(R.cus, 2, {}));
      },
      'DUPLICATE_ID',
      `data/${T.customers}.ndjson:2#/id`,
    ],
    [
      'a parent of another table',
      (spec) => {
        const rows = spec.records[T.orders] as Record<string, unknown>[];
        (rows[1] as Record<string, unknown>)['parent_id'] = R.cus;
      },
      'INVALID_ENTRY',
      `data/${T.orders}.ndjson`,
    ],
    [
      'a parent in a table without sub-records',
      (spec) => {
        const rows = spec.records[T.customers] as Record<string, unknown>[];
        (rows[0] as Record<string, unknown>)['parent_id'] = R.cus;
      },
      'INVALID_ENTRY',
      `data/${T.customers}.ndjson:1#/parent_id`,
    ],
    [
      'a user id in a user cell',
      (spec) => {
        const rows = spec.records[T.orders] as Record<string, Record<string, unknown>>[];
        (rows[1]?.['fields'] as Record<string, unknown>)[F.owner] = ['usr_Someone000000000'];
      },
      'INVALID_ENTRY',
      `data/${T.orders}.ndjson:2#/fields/${F.owner}/0`,
    ],
    [
      'a value that does not fit its field',
      (spec) => {
        const rows = spec.records[T.orders] as Record<string, Record<string, unknown>>[];
        (rows[1]?.['fields'] as Record<string, unknown>)[F.amount] = 'many';
      },
      'INVALID_ENTRY',
      `data/${T.orders}.ndjson:2#/fields/${F.amount}`,
    ],
    [
      'a cell naming a file of another cell',
      (spec) => {
        const rows = spec.records[T.orders] as Record<string, Record<string, unknown>>[];
        (rows[1]?.['fields'] as Record<string, unknown>)[F.files] = [
          { id: ATT.png, name: 'a.png', size: 1, mime: 'image/png' },
        ];
      },
      'INVALID_ENTRY',
      `data/${T.orders}.ndjson:2#/fields/${F.files}`,
    ],
    [
      'a file whose SHA-256 is not the manifest’s',
      (spec) => {
        (spec.files[0] as { meta: Record<string, unknown> }).meta['sha256'] = '0'.repeat(64);
      },
      'CHECKSUM_MISMATCH',
      'files/attachments.json#/files/0/sha256',
    ],
    [
      'a file whose size is not its content’s',
      (spec) => {
        (spec.files[0] as { meta: Record<string, unknown> }).meta['size'] = 3;
      },
      'INVALID_ENTRY',
      'files/attachments.json#/files/0/size',
    ],
    [
      'a file without a media type',
      (spec) => {
        (spec.files[0] as { meta: Record<string, unknown> }).meta['mime'] = 'png';
      },
      'INVALID_ENTRY',
      'files/attachments.json#/files/0/mime',
    ],
    [
      'a junction row naming a record of the wrong table',
      (spec) => {
        spec.links = { [F.customer]: [{ a: R.cus, b: R.cus, position: 0 }] };
      },
      'INVALID_ENTRY',
      `links/${F.customer}.ndjson:1#/a`,
    ],
    [
      'two records in a single-record link',
      (spec) => {
        const fields = spec.tables[0]?.['fields'] as Record<string, unknown>[];
        (fields[7] as Record<string, unknown>)['options'] = linkOptions(T.customers, F.orders, {
          allow_multiple: false,
        });
        (spec.records[T.customers] as unknown[]).push(record(id('rec', 'Cus2'), 2, {}));
        spec.links = {
          [F.customer]: [
            { a: R.one, b: R.cus, position: 0 },
            { a: R.one, b: id('rec', 'Cus2'), position: 1 },
          ],
        };
      },
      'INVALID_ENTRY',
      `links/${F.customer}.ndjson:2#/a`,
    ],
    [
      'an automation that is not one',
      (spec) => {
        spec.automations = [
          {
            id: id('aut', 'Bad'),
            name: 'Bad',
            description: '',
            definition: { trigger: { type: 'nope' }, actions: [] },
            detached: [],
          },
        ];
      },
      'INVALID_DEFINITION',
      'schema/automations.json#/automations/0/definition',
    ],
    [
      'a view filter that is not a filter',
      (spec) => {
        spec.views = [
          {
            id: id('viw', 'Grid'),
            table_id: T.orders,
            type: 'grid',
            name: 'Grid',
            position: 0,
            locked: false,
            config: { filter: { op: 'bogus' } },
          },
        ];
      },
      'INVALID_DEFINITION',
      'schema/views.json#/views/0/config/filter',
    ],
    [
      'a time zone that is an offset',
      (spec) => {
        spec.base = { settings: { timezone: '+07:00' } };
      },
      'INVALID_DEFINITION',
      'schema/base.json#/settings/timezone',
    ],
    [
      'a formula naming a field the package does not define',
      (spec) => {
        const fields = spec.tables[0]?.['fields'] as Record<string, unknown>[];
        (fields[6] as Record<string, unknown>)['options'] = {
          expression: `[${id('fld', 'Nowhere')}] + 1`,
        };
      },
      'DANGLING_REFERENCE',
      'schema/tables.json#/tables/0/fields/6/options/expression',
    ],
  ];

  for (const [name, change, code, path] of cases) {
    it(
      `refuses ${name}: ${code}`,
      async () => {
        const spec = validSpec();
        change(spec);
        const problems = await problemsOf(spec);
        expect(problems.map((item) => [item.code, item.path])).toContainEqual([code, path]);
      },
      ZIP_TEST_TIMEOUT_MS,
    );
  }

  it(
    'refuses a package without the records of a table: MISSING_ENTRY',
    async () => {
      const problems = await problemsOf(validSpec(), { skipData: T.customers });
      expect(problems.map((item) => [item.code, item.path])).toContainEqual([
        'MISSING_ENTRY',
        `data/${T.customers}.ndjson`,
      ]);
    },
    ZIP_TEST_TIMEOUT_MS,
  );
});

describe('checkImportedFile (T1018)', () => {
  const base = {
    filename: 'report.pdf',
    mime: 'application/pdf',
    size: 10,
    head: Buffer.from('%PDF-1.7\n'),
    fieldOptions: {},
    maxFileBytes: 100,
  };
  const cases: readonly [string, Partial<typeof base>, unknown][] = [
    ['an accepted file', {}, { ok: true, filename: 'report.pdf', mime: 'application/pdf' }],
    ['a file over the cap', { size: 101 }, { ok: false, reason: 'file_too_large' }],
    [
      'an .exe in a field that blocks nothing',
      {
        filename: 'setup.exe',
        mime: 'application/octet-stream',
        fieldOptions: { blocked_extensions: [] },
      },
      { ok: false, reason: 'blocked_file_type' },
    ],
    [
      'a type the field blocks',
      {
        filename: 'notes.txt',
        mime: 'text/plain',
        head: Buffer.from('hi'),
        fieldOptions: { blocked_extensions: ['txt'] },
      },
      { ok: false, reason: 'blocked_file_type' },
    ],
    [
      'a native binary under another name',
      {
        filename: 'photo.jpg',
        mime: 'image/jpeg',
        head: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]),
      },
      { ok: false, reason: 'blocked_file_type' },
    ],
    [
      'a type the field does not accept',
      { fieldOptions: { accept: ['image/*'] } },
      { ok: false, reason: 'blocked_file_type' },
    ],
    [
      'content that is not its type',
      { mime: 'image/png', filename: 'x.png', head: Buffer.from('%PDF-1.7\n') },
      { ok: false, reason: 'content_mismatch' },
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(checkImportedFile({ ...base, ...input })).toMatchObject(expected as object);
    });
  }
});

const unused = () => Promise.reject(new Error('not a write of this test'));
/** The writes of T1019, never called without its steps. */
const UNUSED_DEFERRED_WRITES = {
  schemaRows: unused,
  createComputedField: unused,
  backfillComputed: unused,
  setFieldAi: unused,
  setLinkFilter: unused,
  createViews: unused,
  storeFormCover: unused,
  createDashboard: unused,
  createRole: unused,
  createAutomation: unused,
  storeEmailAsset: unused,
} satisfies Partial<BaseImportTarget>;

describe('importBasePackage (T1018): the order of the writes and the seam of later steps', () => {
  it(
    'checks, creates the base, tables, links, files, records, junctions, parents, runs extensions, finishes',
    async () => {
      const calls: string[] = [];
      let baseId = '' as Id<'bse'>;
      const target: BaseImportTarget = {
        members: () => Promise.resolve([MEMBER]),
        createBase: () => {
          calls.push('base');
          baseId = 'bse_Imported00000000';
          return Promise.resolve(baseId);
        },
        createTable: (_base, input) => {
          calls.push(`table ${input.name}: ${input.fields.map((field) => field.name).join(', ')}`);
          return Promise.resolve();
        },
        createLink: (_base, input) => {
          calls.push(`link ${input.field.name}/${input.reverse?.name ?? ''}`);
          return Promise.resolve();
        },
        storeFile: (_base, file, content) => {
          calls.push(`file ${file.filename}`);
          content.resume();
          return Promise.resolve();
        },
        load: (_base, batch) => {
          const rows = batch.kind === 'records' ? batch.records.length : batch.rows.length;
          calls.push(`${batch.kind} ${String(rows)}`);
          return Promise.resolve(rows);
        },
        checkpoint: () => Promise.resolve(),
        progress: () => Promise.resolve(),
        finish: (_base, result) => {
          calls.push(`finish ${String(result.report.records)}`);
          return Promise.resolve();
        },
        purge: () => Promise.resolve(),
        // The steps of T1019 are not in `extensions` here.
        ...UNUSED_DEFERRED_WRITES,
      };
      const reader = await openBasePackage(await writePackage(validSpec()));
      try {
        const result = await importBasePackage(reader, target, {
          maxFieldsPerTable: 12,
          maxFileBytes: 1024,
          batchSize: 2,
          extensions: [
            {
              afterSchema: (context) => {
                calls.push(`afterSchema ${String(context.plan.deferred.computedFields.length)}`);
                return Promise.resolve();
              },
              afterData: (context) => {
                calls.push(`afterData ${context.baseId}`);
                context.report.views = 1;
                return Promise.resolve();
              },
            },
          ],
        });
        expect(calls).toEqual([
          'base',
          'table Orders: Status, Owner, Files, Amount, Summary, Parent',
          'table Customers: ',
          'link Customer/Orders',
          'afterSchema 1',
          'file a.png',
          'records 2',
          'records 1',
          'records 1',
          'links 1',
          'parents 1',
          `afterData ${baseId}`,
          'finish 4',
        ]);
        expect(result.report).toMatchObject({
          tables: 2,
          fields: 10,
          records: 4,
          links: 1,
          attachments: 1,
          views: 1,
          unmatched_user_emails: ['gone@example.com'],
          unmatched_users: 1,
          skipped_personal_views: 2,
          files_skipped: [{ filename: 'setup.exe', reason: 'blocked_file_type' }],
        });
      } finally {
        reader.close();
      }
    },
    ZIP_TEST_TIMEOUT_MS,
  );
});
