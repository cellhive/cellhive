import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  baseImportResultSchema,
  jobAcceptedSchema,
  jobSchema,
  type BaseImportResult,
  type Id,
  type JobDto,
} from '@cellhive/contracts';
import {
  createStorageDriver,
  type BaseImportTarget,
  type Db,
  type StorageDriver,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildPackage,
  field,
  leftovers,
  MULTIPART,
  multipart,
  P,
  pid,
  record,
  sha256,
  thingsTable,
  type PackageSpec,
} from './chbase-packages.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const MIB = 1024 * 1024;
/** Building, importing and purging packages: more than the default 60 s on a slow runner. */
const IMPORT_TEST_TIMEOUT_MS = 120_000;

/** A 1 × 1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Ids of the package (`pid` keeps them readable). */
const D = {
  others: pid('tbl', 'Others'),
  amount: pid('fld', 'Amount'),
  double: pid('fld', 'Double'),
  broken: pid('fld', 'Broken'),
  summary: pid('fld', 'Summary'),
  back: pid('fld', 'ThingOthers'),
  label: pid('fld', 'OtherLabel'),
  link: pid('fld', 'OtherThings'),
  gone: pid('fld', 'Gone'),
  grid: pid('viw', 'Grid'),
  form: pid('viw', 'Form'),
  dashboard: pid('dsh', 'Dash'),
  total: pid('wgt', 'Total'),
  stale: pid('wgt', 'Stale'),
  readers: pid('rol', 'Readers'),
  frozen: pid('rol', 'Frozen'),
  automation: pid('aut', 'Tell'),
  cover: pid('att', 'Cover'),
  image: pid('att', 'Image'),
  cell: pid('att', 'Cell'),
  one: pid('rec', 'One'),
  two: pid('rec', 'Two'),
  other: pid('rec', 'Other'),
} as const;

const above = (fieldId: string, value: number) => ({
  op: 'and',
  items: [{ field: fieldId, operator: 'gt', value }],
});

/**
 * A package with one of everything T1019 creates: a stored formula
 * (`Double`), a formula naming a field of `missing_ids` (`Broken`), an AI
 * text field, a link whose `record_filter` names that missing field, a grid view
 * filtered on it and a form view with a cover (Things; Others has no view
 * of its own), a dashboard with a widget and a broken one, two custom
 * roles (one naming the missing field), an automation with a detached bot
 * and an email image, a file in a cell.
 */
function deferredSpec(overrides: Partial<PackageSpec> = {}): PackageSpec {
  const file = (meta: Record<string, unknown>, data: Buffer) => ({
    meta: { mime: 'image/png', size: data.length, sha256: sha256(data), ...meta },
    data,
  });
  return {
    base: { missing_ids: [D.gone] },
    tables: [
      thingsTable([
        field(D.amount, 'Amount', 'number', {}, { position: 3, required: true }),
        field(
          D.double,
          'Double',
          'formula',
          { expression: `[${D.amount}] * 2`, style: null },
          { position: 4 },
        ),
        field(
          D.broken,
          'Broken',
          'formula',
          { expression: `[${D.gone}] + 1`, style: null },
          { position: 5, result_type: { kind: 'number' } },
        ),
        field(
          D.summary,
          'Summary',
          'text',
          { ai: { task: 'summarize', prompt: `Summarize {{ [${P.name}] }}` } },
          { position: 6 },
        ),
        field(
          D.back,
          'Others',
          'link',
          {
            link_table: D.others,
            bidirectional: true,
            allow_multiple: true,
            record_filter: null,
            symmetric_field_id: D.link,
          },
          { position: 7, link_side: 'b' },
        ),
      ]),
      {
        id: D.others,
        name: 'Others',
        description: null,
        position: 1,
        primary_field_id: D.label,
        fields: [
          field(D.label, 'Label', 'text', {}, { is_primary: true }),
          field(
            D.link,
            'Things',
            'link',
            {
              link_table: P.things,
              bidirectional: true,
              allow_multiple: true,
              record_filter: above(D.gone, 3),
              symmetric_field_id: D.back,
            },
            { position: 1, link_side: 'a' },
          ),
        ],
      },
    ],
    records: {
      [P.things]: [
        record(D.one, 1, {
          [P.name]: 'One',
          [D.amount]: 2,
          [D.summary]: 'The first one',
          [P.files]: [{ id: D.cell, name: 'one.png', size: PNG.length, mime: 'image/png' }],
        }),
        record(D.two, 2, { [P.name]: 'Two', [D.amount]: 5, [D.summary]: null }),
      ],
      [D.others]: [record(D.other, 1, { [D.label]: 'Other' })],
    },
    links: { [D.link]: [{ a: D.other, b: D.two, position: 0 }] },
    files: [
      file(
        {
          id: D.cell,
          kind: 'cell',
          filename: 'one.png',
          table_id: P.things,
          field_id: P.files,
          record_id: D.one,
        },
        PNG,
      ),
      file(
        {
          id: D.cover,
          kind: 'form_cover',
          filename: 'cover.png',
          table_id: P.things,
          view_id: D.form,
        },
        PNG,
      ),
      file(
        {
          id: D.image,
          kind: 'email_asset',
          filename: 'logo.png',
          automation_id: D.automation,
          width: 1,
          height: 1,
        },
        PNG,
      ),
    ],
    views: [
      {
        id: D.grid,
        table_id: P.things,
        type: 'grid',
        name: 'Big ones',
        position: 0,
        locked: true,
        config: { filter: above(D.double, 5), sort: [{ field: D.double, direction: 'desc' }] },
      },
      {
        id: D.form,
        table_id: P.things,
        type: 'form',
        name: 'Ask',
        position: 1,
        locked: false,
        config: {
          form: {
            title: 'Ask',
            cover_attachment_id: D.cover,
            fields: [{ field: P.name, required: false, label: null, help: null }],
          },
        },
      },
    ],
    dashboards: [
      {
        id: D.dashboard,
        name: 'Numbers',
        icon: null,
        description: null,
        theme: {},
        global_filters: [],
        position: 0,
        widgets: [
          {
            id: D.total,
            type: 'kpi',
            title: 'Total',
            config: {
              table_id: P.things,
              metrics: [{ id: 'm1', aggregation: 'sum', field: D.double }],
            },
            layout: { x: 0, y: 0, w: 4, h: 3 },
          },
          {
            id: D.stale,
            type: 'kpi',
            title: 'Stale',
            config: {
              table_id: P.things,
              metrics: [{ id: 'm1', aggregation: 'sum', field: D.gone }],
            },
            layout: { x: 4, y: 0, w: 4, h: 3 },
          },
        ],
      },
    ],
    roles: [
      {
        id: D.readers,
        name: 'Readers',
        position: 0,
        config: {
          tables: {
            [P.things]: {
              perm: 'read_only',
              view_rule: { allow_edit: false, visible_views: [D.grid] },
              record_rule: { read_scope: 'filter', read_filter: above(D.amount, 3) },
            },
          },
          dashboards: { [D.dashboard]: 'read_only' },
        },
      },
      {
        id: D.frozen,
        name: 'Frozen',
        position: 1,
        config: {
          tables: {
            [P.things]: {
              perm: 'read_only',
              record_rule: { read_scope: 'filter', read_filter: above(D.gone, 1) },
            },
          },
        },
      },
    ],
    automations: [
      {
        id: D.automation,
        name: 'Tell the team',
        description: '',
        definition: {
          trigger: { type: 'record.created', table_id: P.things },
          condition: null,
          actions: [
            {
              id: 'act_tg',
              type: 'send_telegram',
              config: { secret_id: null, chat_id: { literal: '@team' }, text: { template: 'New' } },
            },
            {
              id: 'act_mail',
              type: 'send_email',
              config: {
                identity_id: null,
                to: [{ literal: 'team@example.com' }],
                subject: { template: 'New thing' },
                body: { format: 'markdown', template: `A new one ![logo](asset:${D.image})` },
              },
            },
          ],
        },
        detached: [{ path: 'actions[0].config.secret_id', kind: 'secret', name: 'Team bot' }],
      },
    ],
    ...overrides,
  };
}

async function finishedJob(read: () => Promise<LightMyRequestResponse>): Promise<JobDto> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const response = await read();
    expect(response.statusCode, response.body).toBe(200);
    const job = jobSchema.parse(response.json());
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${job.id} still ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** `target` with some of its methods replaced (the others keep their receiver). */
function wrapTarget(
  target: BaseImportTarget,
  overrides: Partial<BaseImportTarget>,
): BaseImportTarget {
  return new Proxy(target, {
    get(own, key: keyof BaseImportTarget) {
      const replaced = overrides[key];
      if (replaced !== undefined) return replaced;
      const value: unknown = Reflect.get(own, key);
      return typeof value === 'function' ? (value as () => unknown).bind(own) : value;
    },
  });
}

/**
 * BACKLOG T1019 (CONTRACTS §12.2): what pass 1 defers, created by the
 * `computed` phase of `base.import` — formula fields in the order of their
 * references then their values, a formula naming a field of `missing_ids`
 * kept broken (`REF`), AI options (nothing queued, `ai_fields`), the link
 * `record_filter` naming a formula, shared views in place of the default
 * view with their order, lock and filter, the form cover, dashboards and
 * widgets (a broken one kept broken), custom roles assigned to nobody (one
 * naming a missing field kept as it is), automations off with their
 * detached bot reported and their email image — and the purge when any of
 * these steps fails or refuses the package, nothing left behind.
 */
describe('base import: what pass 1 deferred (T1019)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let storage: StorageDriver;
  let tempRoot: string;
  let workspace: Id<'wsp'>;
  let nextTarget: ((target: BaseImportTarget) => BaseImportTarget) | null = null;

  const jobOf = (jobId: Id<'job'>) => finishedJob(() => fx.call('owner', 'GET', `/jobs/${jobId}`));

  async function startImport(bytes: Buffer): Promise<JobDto> {
    const response = await fx.call(
      'owner',
      'POST',
      `/workspaces/${workspace}/bases/import`,
      multipart('base.chbase', bytes),
      MULTIPART,
    );
    expect(response.statusCode, response.body).toBe(202);
    return jobOf(jobAcceptedSchema.parse(response.json()).job_id);
  }

  async function imported(spec: PackageSpec): Promise<BaseImportResult> {
    const job = await startImport(buildPackage(spec));
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    return baseImportResultSchema.parse(job.result);
  }

  const roots = () => ({ storage: t.storageRoot, temp: tempRoot });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, BASE_PACKAGE_MAX_BYTES: String(4 * MIB) });
    fx = await buildRecordFixture(t, db);
    storage = createStorageDriver(t.config);
    tempRoot = await mkdtemp(join(tmpdir(), 'cellhive-base-import-deferred-'));
    const target = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/workspaces`, {
      name: 'Imported',
    });
    expect(target.statusCode, target.body).toBe(201);
    workspace = target.json<{ id: Id<'wsp'> }>().id;
    const { logger } = captureLogger();
    worker = await createWorker(t.config, {
      logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db,
        logger,
        baseImport: {
          tempRoot,
          target: (own) => {
            const wrap = nextTarget;
            nextTarget = null;
            return wrap === null ? own : wrap(own);
          },
        },
      }),
    });
  }, 240_000);

  afterAll(async () => {
    await (worker as WorkerHandle | undefined)?.close();
    await storage.close();
    await t.close();
    await db.destroy();
    await database.drop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe('a package with one of everything', () => {
    let result: BaseImportResult;
    let tables: { id: Id<'tbl'>; name: string; db_table_name: string }[];
    let fields: {
      id: Id<'fld'>;
      table_id: Id<'tbl'>;
      name: string;
      type: string;
      options: unknown;
      db_column_name: string | null;
      compute_mode: string | null;
      compute_state: string | null;
      compute_error: unknown;
    }[];
    const fieldNamed = (name: string) => {
      const found = fields.find((item) => item.name === name);
      if (found === undefined) throw new Error(`no field ${name}`);
      return found;
    };

    beforeAll(async () => {
      result = await imported(deferredSpec());
      tables = await db.kysely
        .selectFrom('meta.tables')
        .select(['id', 'name', 'db_table_name'])
        .where('base_id', '=', result.base_id)
        .orderBy('position')
        .execute();
      fields = await db.kysely
        .selectFrom('meta.fields')
        .select([
          'id',
          'table_id',
          'name',
          'type',
          'options',
          'db_column_name',
          'compute_mode',
          'compute_state',
          'compute_error',
        ])
        .where(
          'table_id',
          'in',
          tables.map((table) => table.id),
        )
        .execute();
    }, IMPORT_TEST_TIMEOUT_MS);

    it('reports what it created and what to set up again', () => {
      expect(result.report).toMatchObject({
        tables: 2,
        fields: 10,
        records: 3,
        links: 1,
        attachments: 3,
        views: 2,
        dashboards: 1,
        widgets: 2,
        automations: 1,
        roles: 2,
        automations_disabled: 1,
        secrets_to_reconnect: [
          {
            kind: 'secret',
            name: 'Team bot',
            automations: [{ id: expect.any(String) as string, name: 'Tell the team' }],
          },
        ],
        webhooks_to_recreate: [],
        ai_fields: [
          {
            table_id: tables[0]?.id,
            field_id: fieldNamed('Summary').id,
            name: 'Summary',
          },
        ],
        files_skipped: [],
      });
    });

    it('computes the stored formula on every record; one naming a missing field is REF', async () => {
      const double = fieldNamed('Double');
      expect(double).toMatchObject({ compute_mode: 'stored', compute_state: 'ready' });
      const things = tables[0];
      const { rows } = await sql<{ value: string | null }>`
        SELECT ${sql.id(double.db_column_name ?? '')}::text AS value
          FROM ${sql.id('data', things?.db_table_name ?? '')} ORDER BY __auto
      `.execute(db.kysely);
      expect(rows.map((row) => Number(row.value))).toEqual([4, 10]);
      expect(fieldNamed('Broken')).toMatchObject({
        compute_mode: 'virtual',
        compute_state: 'error',
        db_column_name: null,
        compute_error: { code: 'REF' },
      });
      const records = await fx.call('owner', 'GET', `/tables/${things?.id ?? ''}/records`);
      expect(records.statusCode, records.body).toBe(200);
      expect(
        records
          .json<{ records: { fields: Record<string, unknown> }[] }>()
          .records.map((item) => [item.fields['Double'], item.fields['Summary']]),
      ).toEqual([
        [4, 'The first one'],
        [10, null],
      ]);
    });

    it('sets the AI options with the new ids and queues nothing; a link filter naming a missing field keeps it', async () => {
      const summary = fieldNamed('Summary');
      const name = fields.find((item) => item.name === 'Name' && item.table_id === tables[0]?.id);
      expect((summary.options as { ai: { prompt: string } }).ai.prompt).toBe(
        `Summarize {{ [${name?.id ?? ''}] }}`,
      );
      const queued = await db.kysely
        .selectFrom('meta.ai_generation_queue')
        .select('field_id')
        .where('field_id', '=', summary.id)
        .execute();
      expect(queued).toEqual([]);
      const link = fields.find((item) => item.name === 'Things' && item.type === 'link');
      const filter = (link?.options as { record_filter: { items: { field: string }[] } })
        .record_filter;
      expect(filter.items).toHaveLength(1);
      expect(filter.items[0]?.field).toMatch(/^fld_/u);
      expect(fields.map((item) => item.id)).not.toContain(filter.items[0]?.field);
      expect(filter.items[0]?.field).not.toBe(D.gone);
    });

    it('replaces the default view by the shared views of the package; the form keeps its cover', async () => {
      const [things, others] = tables;
      const views = await db.kysely
        .selectFrom('meta.views')
        .select(['id', 'table_id', 'name', 'type', 'position', 'locked', 'config'])
        .where(
          'table_id',
          'in',
          tables.map((table) => table.id),
        )
        .orderBy('position')
        .execute();
      expect(
        views
          .filter((view) => view.table_id === things?.id)
          .map((view) => [view.name, view.type, view.position, view.locked]),
      ).toEqual([
        ['Big ones', 'grid', 0, true],
        ['Ask', 'form', 1, false],
      ]);
      expect(views.filter((view) => view.table_id === others?.id).map((view) => view.name)).toEqual(
        ['Grid view'],
      );
      const grid = views.find((view) => view.name === 'Big ones');
      expect((grid?.config as { filter: unknown }).filter).toEqual(
        above(fieldNamed('Double').id, 5),
      );
      const form = views.find((view) => view.name === 'Ask');
      // `Amount` is required by the table: the form asks it too.
      expect(
        (form?.config as { form: { fields: { field: string; required: boolean }[] } }).form.fields,
      ).toEqual([
        expect.objectContaining({ field: fields.find((item) => item.name === 'Name')?.id }),
        expect.objectContaining({ field: fieldNamed('Amount').id, required: true }),
      ]);
      const coverId = (form?.config as { form: { cover_attachment_id: string } }).form
        .cover_attachment_id;
      const cover = await db.kysely
        .selectFrom('meta.form_covers')
        .selectAll()
        .where('id', '=', coverId as Id<'att'>)
        .executeTakeFirstOrThrow();
      expect(cover).toMatchObject({ status: 'ready', view_id: form?.id, sha256: sha256(PNG) });
      const response = await fx.call(
        'owner',
        'GET',
        `/views/${form?.id ?? ''}/form-cover/${coverId}`,
      );
      expect(response.statusCode, response.body).toBe(302);
      const listed = await fx.call(
        'owner',
        'GET',
        `/tables/${things?.id ?? ''}/records?view_id=${grid?.id ?? ''}`,
      );
      expect(listed.json<{ records: unknown[] }>().records).toHaveLength(1);
    });

    it('creates the dashboard and its widgets; one naming a missing field stays broken', async () => {
      const dashboards = await fx.call('owner', 'GET', `/bases/${result.base_id}/dashboards`);
      expect(dashboards.statusCode, dashboards.body).toBe(200);
      const [dashboard] = dashboards.json<{ items: { id: string; name: string }[] }>().items;
      expect(dashboard?.name).toBe('Numbers');
      const read = await fx.call('owner', 'GET', `/dashboards/${dashboard?.id ?? ''}`);
      const widgets = read.json<{ widgets: { id: string; title: string; status: string }[] }>()
        .widgets;
      expect(widgets.map((widget) => [widget.title, widget.status])).toEqual([
        ['Total', 'ok'],
        ['Stale', 'broken'],
      ]);
      const data = await fx.call('owner', 'POST', `/widgets/${widgets[0]?.id ?? ''}/data`, {});
      expect(data.statusCode, data.body).toBe(200);
      expect(data.json<{ rows: unknown[][] }>().rows).toEqual([[14]]);
    });

    it('creates the custom roles for nobody; one naming a missing field keeps its rule', async () => {
      const roles = await db.kysely
        .selectFrom('meta.base_roles')
        .select(['id', 'name', 'kind', 'config'])
        .where('base_id', '=', result.base_id)
        .where('kind', '=', 'custom')
        .orderBy('position')
        .execute();
      expect(roles.map((role) => role.name)).toEqual(['Readers', 'Frozen']);
      const [readers, frozen] = roles;
      const things = tables[0]?.id ?? '';
      const config = readers?.config as {
        tables: Record<string, { record_rule: { read_filter: unknown }; view_rule: unknown }>;
        dashboards: Record<string, string>;
      };
      expect(config.tables[things]?.record_rule.read_filter).toEqual(
        above(fieldNamed('Amount').id, 3),
      );
      const dashboard = await db.kysely
        .selectFrom('meta.dashboards')
        .select('id')
        .where('base_id', '=', result.base_id)
        .executeTakeFirstOrThrow();
      expect(config.dashboards).toEqual({ [dashboard.id]: 'read_only' });
      const filter = (
        frozen?.config as { tables: Record<string, { record_rule: { read_filter: unknown } }> }
      ).tables[things]?.record_rule.read_filter as { items: { field: string }[] };
      expect(filter.items[0]?.field).toMatch(/^fld_/u);
      expect(filter.items[0]?.field).not.toBe(D.gone);
      const members = await db.kysely
        .selectFrom('meta.base_role_members')
        .select('role_id')
        .where(
          'role_id',
          'in',
          roles.map((role) => role.id),
        )
        .execute();
      expect(members).toEqual([]);
    });

    it('creates the automation off with its email image; turning it on is 422 AUTOMATION_INVALID', async () => {
      const list = await fx.call('owner', 'GET', `/bases/${result.base_id}/automations`);
      expect(list.statusCode, list.body).toBe(200);
      const [automation] = list.json<{
        items: { id: Id<'aut'>; enabled: boolean; run_as: { id: string }; definition: unknown }[];
      }>().items;
      expect(automation).toMatchObject({ enabled: false, run_as: { id: fx.users.owner.id } });
      const definition = automation?.definition as {
        actions: { config: Record<string, unknown> }[];
      };
      expect(definition.actions[0]?.config['secret_id']).toBeNull();
      const image = await db.kysely
        .selectFrom('meta.email_assets')
        .selectAll()
        .where('automation_id', '=', automation?.id ?? ('' as Id<'aut'>))
        .executeTakeFirstOrThrow();
      expect(image).toMatchObject({ status: 'ready', width: 1, height: 1, sha256: sha256(PNG) });
      expect(JSON.stringify(definition)).toContain(`asset:${image.id}`);
      const stream = await storage.getStream(image.object_key);
      expect(stream).not.toBeNull();
      stream?.destroy();
      const enabled = await fx.call('owner', 'POST', `/automations/${automation?.id ?? ''}/enable`);
      expect(enabled.statusCode, enabled.body).toBe(422);
      expect(
        enabled.json<{ code: string; errors: { path: string; code: string }[] }>(),
      ).toMatchObject({
        code: 'AUTOMATION_INVALID',
        errors: [{ path: 'definition.actions[0].config.secret_id', code: 'SECRET_NOT_USABLE' }],
      });
    });
  });

  describe('a failure in each new step purges the base', () => {
    const steps: (keyof BaseImportTarget)[] = [
      'createComputedField',
      'backfillComputed',
      'setLinkFilter',
      'setFieldAi',
      'createViews',
      'storeFormCover',
      'createDashboard',
      'createRole',
      'createAutomation',
      'storeEmailAsset',
    ];
    for (const step of steps) {
      it(
        `${step} fails after writing: nothing of the import is left`,
        async () => {
          const before = await leftovers(db, roots());
          nextTarget = (own) =>
            wrapTarget(own, {
              [step]: async (...args: unknown[]) => {
                await (own[step] as (...items: unknown[]) => Promise<unknown>).apply(own, args);
                throw new Error(`injected failure after ${step}`);
              },
            });
          const job = await startImport(buildPackage(deferredSpec()));
          expect(job.status).toBe('failed');
          expect(job.error?.code).toBe('INTERNAL');
          expect(await leftovers(db, roots())).toEqual(before);
        },
        IMPORT_TEST_TIMEOUT_MS,
      );
    }
  });

  describe('objects of the package the instance refuses: INVALID_PACKAGE, nothing left', () => {
    const cases: [string, () => PackageSpec, string][] = [
      [
        'a link filter naming a formula field',
        () => {
          const spec = deferredSpec();
          const [things, others] = spec.tables as Record<string, unknown>[];
          const fields = (others?.['fields'] as Record<string, unknown>[]).map((item) =>
            item['id'] === D.link
              ? {
                  ...item,
                  options: {
                    ...(item['options'] as object),
                    record_filter: above(D.double, 3),
                  },
                }
              : item,
          );
          return { ...spec, tables: [things ?? {}, { ...others, fields }] };
        },
        'schema/tables.json#/tables/1/fields/1/options/record_filter',
      ],
      [
        'two formulas reading each other',
        () => {
          const spec = deferredSpec();
          const things = thingsTable([
            field(D.amount, 'Amount', 'formula', { expression: `[${D.double}] + 1`, style: null }),
            field(D.double, 'Double', 'formula', { expression: `[${D.amount}] * 2`, style: null }),
          ]);
          return { ...spec, tables: [things], records: { [P.things]: [] }, links: {}, ...EMPTY };
        },
        'schema/tables.json#/tables/0/fields/3/options',
      ],
      [
        'a formula that does not typecheck',
        () => {
          const things = thingsTable([
            field(D.double, 'Double', 'formula', { expression: `[${P.name}] * 2`, style: null }),
          ]);
          return { tables: [things], records: { [P.things]: [] } };
        },
        'schema/tables.json#/tables/0/fields/3',
      ],
      [
        'an AI prompt reading a file',
        () => {
          const things = thingsTable([
            field(D.summary, 'Summary', 'text', {
              ai: { task: 'summarize', prompt: `Summarize {{ [${P.files}] }}` },
            }),
          ]);
          return { tables: [things], records: { [P.things]: [] } };
        },
        'schema/tables.json#/tables/0/fields/3/options/ai',
      ],
      [
        'widgets that overlap',
        () => {
          const spec = deferredSpec();
          const [dashboard] = spec.dashboards as Record<string, unknown>[];
          const widgets = dashboard?.['widgets'] as Record<string, unknown>[];
          return {
            ...spec,
            dashboards: [
              {
                ...dashboard,
                widgets: widgets.map((widget) => ({
                  ...widget,
                  layout: { x: 0, y: 0, w: 4, h: 3 },
                })),
              },
            ],
          };
        },
        'schema/dashboards.json#/dashboards/0/widgets',
      ],
      [
        'a role named like a system role',
        () => {
          const spec = deferredSpec();
          const [readers, frozen] = spec.roles as Record<string, unknown>[];
          return { ...spec, roles: [{ ...readers, name: 'Editor' }, frozen] };
        },
        'schema/roles.json#/roles/0',
      ],
    ];
    for (const [name, spec, path] of cases) {
      it(
        name,
        async () => {
          const before = await leftovers(db, roots());
          const job = await startImport(buildPackage(spec()));
          expect(job.status).toBe('failed');
          expect(job.error?.code, JSON.stringify(job.error)).toBe('INVALID_PACKAGE');
          expect(job.error?.errors).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: 'INVALID_DEFINITION', path })]),
          );
          expect(await leftovers(db, roots())).toEqual(before);
        },
        IMPORT_TEST_TIMEOUT_MS,
      );
    }
  });

  it(
    'a cover that is not an image is left out and reported; the form shows none',
    async () => {
      const spec = deferredSpec();
      const files = (spec.files ?? []).map((file) =>
        file.meta['kind'] === 'form_cover'
          ? {
              meta: { ...file.meta, size: 9, sha256: sha256(Buffer.from('%PDF-1.7\n')) },
              data: Buffer.from('%PDF-1.7\n'),
            }
          : file,
      );
      const result = await imported({ ...spec, files });
      expect(result.report.files_skipped).toEqual([
        { filename: 'cover.png', reason: 'content_mismatch' },
      ]);
      expect(result.report.attachments).toBe(2);
      const form = await db.kysely
        .selectFrom('meta.views')
        .innerJoin('meta.tables', 'meta.tables.id', 'meta.views.table_id')
        .select('meta.views.config')
        .where('meta.tables.base_id', '=', result.base_id)
        .where('meta.views.type', '=', 'form')
        .executeTakeFirstOrThrow();
      expect(
        (form.config as { form: { cover_attachment_id: unknown } }).form.cover_attachment_id,
      ).toBeNull();
    },
    IMPORT_TEST_TIMEOUT_MS,
  );
});

/** A package without the objects that name the second table. */
const EMPTY = {
  views: [],
  dashboards: [],
  roles: [],
  automations: [],
  files: [],
  base: { missing_ids: [] },
} satisfies Partial<PackageSpec>;
