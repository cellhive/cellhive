import { availableParallelism, loadavg } from 'node:os';

import {
  automationDefinitionSchema,
  newId,
  validateAutomationTemplateResponseSchema,
  type Id,
} from '@cellhive/contracts';
import {
  AutomationsRepository,
  AutomationValueError,
  AutomationValueEvaluator,
  GroupMembersRepository,
  loadBaseSchemaRows,
  orgScope,
  RecordQueryService,
  recordQueryReader,
  refusedFunctionsIn,
  type AutomationValidationContext,
  type Db,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessService } from '../../src/common/access/access.service.js';
import { recordAccessContextOf } from '../../src/common/access/record-access-context.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

/** Absolute time budgets only while the machine is not overloaded (S4b-review §7.1). */
const timingBudgetsApply = (): boolean => (loadavg()[0] ?? 0) < 2 * availableParallelism();

/**
 * T504: automation templates — the builder check
 * (`POST /bases/:id/automations/validate-template`, CONTRACTS §21), checks
 * when saving (`422 AUTOMATION_INVALID`, `REGEX*` refused), and the run-time
 * evaluator reading records through `RecordQueryService` with the access of
 * `run_as` (CONTRACTS §5 fixture: Sales cannot read `cost`, reads only the
 * orders it owns).
 */
describe('automation templates (T504)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let mine: Id<'rec'>;
  let theirs: Id<'rec'>;

  const fid = (name: string): Id<'fld'> => {
    const field = fx.fld[name];
    if (field === undefined) throw new Error(`missing field ${name}`);
    return field.id;
  };
  const validateUrl = () => `/bases/${fx.baseId}/automations/validate-template`;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        {
          fields: {
            title: 'Đơn <b>1</b>',
            amount: 1500,
            cost: 7,
            owner: [{ id: fx.users.u_sales1.id }],
          },
        },
        { fields: { title: 'Đơn 2', amount: 9, cost: 1, owner: [{ id: fx.users.u_admin.id }] } },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    [mine, theirs] = created
      .json<{ records: { id: Id<'rec'> }[] }>()
      .records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>];
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('POST /bases/:id/automations/validate-template', () => {
    it('turns names into ids and describes each placeholder', async () => {
      const response = await fx.call('u_admin', 'POST', validateUrl(), {
        table_id: fx.orders.id,
        template: 'Đơn {{[title]}}: {{ [amount] * 2 }}',
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = validateAutomationTemplateResponseSchema.parse(response.json());
      expect(body).toMatchObject({
        valid: true,
        stored: `Đơn {{ [${fid('title')}] }}: {{ [${fid('amount')}] * 2 }}`,
        display: 'Đơn {{ [title] }}: {{ [amount] * 2 }}',
        errors: [],
      });
      expect(body.placeholders).toEqual([
        expect.objectContaining({
          index: 0,
          start: 4,
          display: '[title]',
          result_type: { kind: 'text', list: false },
          fields: [{ field_id: fid('title'), link_path: [] }],
        }),
        expect.objectContaining({ index: 1, result_type: { kind: 'number', list: false } }),
      ]);
      // The stored form round-trips with current names.
      const back = validateAutomationTemplateResponseSchema.parse(
        (
          await fx.call('u_admin', 'POST', validateUrl(), {
            table_id: fx.orders.id,
            template: body.stored,
            form: 'stored',
          })
        ).json(),
      );
      expect(back.display).toBe(body.display);
    });

    it('reports REGEX, unknown fields and syntax with positions (200, valid: false)', async () => {
      const response = await fx.call('u_admin', 'POST', validateUrl(), {
        table_id: fx.orders.id,
        template: '{{ REGEXMATCH([title], "^(a+)+$") }} {{ [nope] }} {{ 1',
      });
      expect(response.statusCode).toBe(200);
      const body = validateAutomationTemplateResponseSchema.parse(response.json());
      expect(body.valid).toBe(false);
      expect(body.stored).toBeNull();
      expect(
        body.errors.map(({ path, code, params }) => ({
          path,
          code,
          position: params?.['position'],
        })),
      ).toEqual([
        { path: 'template', code: 'UNSUPPORTED_FUNCTION', position: { start: 3, length: 30 } },
        { path: 'template', code: 'UNKNOWN_FIELD', position: { start: 40, length: 6 } },
        { path: 'template', code: 'UNTERMINATED_PLACEHOLDER', position: { start: 50, length: 4 } },
      ]);
    });

    it('limits a digest row template to the fields of the step', async () => {
      const body = validateAutomationTemplateResponseSchema.parse(
        (
          await fx.call('u_admin', 'POST', validateUrl(), {
            table_id: fx.orders.id,
            template: '{{ [title] }} {{ [amount] }}',
            row_fields: [fid('title')],
          })
        ).json(),
      );
      expect(body.errors.map((error) => error.code)).toEqual(['UNKNOWN_FIELD']);
    });

    it('checks trigger data and earlier step records (T505)', async () => {
      const response = await fx.call('u_admin', 'POST', validateUrl(), {
        table_id: fx.orders.id,
        template:
          '{{ [act_new].[Tên] }} {{ [act_new].[@url] }} {{ [@url] }} {{ TEXT([@fired_at], "YYYY") }}',
        trigger_type: 'record.created',
        steps: [{ id: 'act_new', table_id: fx.customers.id }],
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = validateAutomationTemplateResponseSchema.parse(response.json());
      expect(body).toMatchObject({
        valid: true,
        stored:
          `{{ [act_new].[${fid('customerName')}] }} {{ [act_new].[@url] }} {{ [@url] }} ` +
          '{{ TEXT([@fired_at], "YYYY") }}',
      });
      expect(body.placeholders[0]).toMatchObject({
        result_type: { kind: 'text', list: false },
        fields: [{ field_id: fid('customerName'), link_path: ['act_new'] }],
      });
      // Only real fields are listed.
      expect(body.placeholders[2]?.fields).toEqual([]);
      const invalid = validateAutomationTemplateResponseSchema.parse(
        (
          await fx.call('u_admin', 'POST', validateUrl(), {
            table_id: fx.orders.id,
            template: '{{ [act_new].[Tên] }} {{ [@clicked_by] }}',
            trigger_type: 'record.created',
          })
        ).json(),
      );
      expect(invalid.errors.map((error) => error.code)).toEqual(['UNKNOWN_FIELD', 'UNKNOWN_FIELD']);
    });

    it('a step on a table the caller cannot read is left out (T505)', async () => {
      // An unknown table answers exactly like a hidden one: the step reference is unknown.
      const body = validateAutomationTemplateResponseSchema.parse(
        (
          await fx.call('u_admin', 'POST', validateUrl(), {
            table_id: fx.orders.id,
            template: '{{ [act_x].[@id] }}',
            trigger_type: 'record.created',
            steps: [{ id: 'act_x', table_id: newId('tbl') }],
          })
        ).json(),
      );
      expect(body.errors.map((error) => error.code)).toEqual(['UNKNOWN_FIELD']);
    });

    it('needs to manage an automation of the base, and a readable table', async () => {
      const body = { table_id: fx.orders.id, template: '{{ 1 }}' };
      expectProblem(
        await fx.call('u_editor', 'POST', validateUrl(), body),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call('u_sales1', 'POST', validateUrl(), body),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await fx.call('u_out', 'POST', validateUrl(), body), 404, 'NOT_FOUND');
      expectProblem(await fx.call('stranger', 'POST', validateUrl(), body), 404, 'NOT_FOUND');
      expectProblem(
        await fx.call('u_admin', 'POST', validateUrl(), { ...body, table_id: newId('tbl') }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('u_admin', 'POST', validateUrl(), { table_id: fx.orders.id }),
        422,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('saving', () => {
    const definition = (template: string) => ({
      trigger: { type: 'record.created', table_id: fx.orders.id },
      actions: [
        {
          id: 'act_1',
          type: 'update_record',
          config: { table_id: fx.orders.id, fields: { [fid('title')]: { template } } },
        },
      ],
    });

    it('refuses ^(a+)+$ in a template with 422 UNSUPPORTED_FUNCTION', async () => {
      const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Regex',
        definition: definition('{{ REGEXMATCH([fld_x000000000000000], "^(a+)+$") }}'),
      });
      expectProblem(response, 422, 'AUTOMATION_INVALID');
      expect(problemOf(response.body).errors).toEqual([
        expect.objectContaining({
          path: `definition.actions[0].config.fields.${fid('title')}.template`,
          code: 'UNSUPPORTED_FUNCTION',
          params: expect.objectContaining({
            function: 'REGEXMATCH',
            position: { start: 3, length: 45 },
          }) as unknown,
        }),
      ]);
    });

    it('stores the canonical form', async () => {
      const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Ok',
        definition: definition(`#{{[${fid('title')}]}}`),
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({
        definition: {
          actions: [
            {
              config: { fields: { [fid('title')]: { template: `#{{ [${fid('title')}] }}` } } },
            },
          ],
        },
      });
    });
  });

  describe('run time: reads as run_as through RecordQueryService', () => {
    async function evaluatorAs(
      user: 'u_admin' | 'u_sales1',
      recordId: Id<'rec'>,
      definition: unknown = { trigger: { type: 'record.created', table_id: fx.orders.id } },
    ): Promise<AutomationValueEvaluator> {
      const accessService = t.app.get(AccessService);
      const base = await accessService.findBaseForUser(fx.orgId, fx.users[user].id, fx.baseId);
      if (base === undefined) throw new Error('no access');
      const access = await recordAccessContextOf(
        { groupMembers: new GroupMembersRepository(db), config: t.config },
        { id: fx.users[user].id, locale: null, timezone: null },
        base,
      );
      const rows = await loadBaseSchemaRows(db, orgScope(fx.orgId), fx.baseId);
      const context: AutomationValidationContext = {
        tables: rows.tables,
        fields: rows.fields,
        access: base.access,
      };
      return new AutomationValueEvaluator({
        context,
        definition: automationDefinitionSchema.parse(definition),
        reader: recordQueryReader(t.app.get(RecordQueryService), orgScope(fx.orgId), access),
        trigger: { tableId: fx.orders.id, recordId },
        timeZone: 'Asia/Ho_Chi_Minh',
        locale: 'vi',
        now: new Date('2026-10-05T03:00:00Z'),
      });
    }

    const template = () => `{{ [${fid('title')}] }}|{{ [${fid('cost')}] }}|{{ [${fid('owner')}] }}`;

    it('the admin reads every field', async () => {
      const result = await (
        await evaluatorAs('u_admin', mine)
      ).resolve({ template: template() }, { context: 'telegram_html' });
      expect(result).toEqual({
        value: 'Đơn &lt;b&gt;1&lt;/b&gt;|7|User sales1',
        warnings: [],
        truncated: false,
      });
    });

    it('a field run_as cannot read is empty, with a warning and no value', async () => {
      const result = await (await evaluatorAs('u_sales1', mine)).resolve({ template: template() });
      expect(result).toEqual({
        value: 'Đơn <b>1</b>||User sales1',
        warnings: [{ code: 'unknown_reference', placeholder: 1 }],
        truncated: false,
      });
      expect(
        await (await evaluatorAs('u_sales1', mine)).resolve({ field: fid('cost') }),
      ).toMatchObject({ value: null, warnings: [{ code: 'field_unavailable' }] });
    });

    it('a record outside the read rule of run_as reads as empty', async () => {
      const result = await (
        await evaluatorAs('u_sales1', theirs)
      ).resolve({
        template: `[{{ [${fid('title')}] }}]`,
      });
      expect(result.value).toBe('[]');
      expect(
        (await (await evaluatorAs('u_admin', theirs)).resolve({ field: fid('title') })).value,
      ).toBe('Đơn 2');
    });

    it('a REGEX definition put in the database fails the step at once, no RegExp', async () => {
      const regex = {
        trigger: { type: 'record.created', table_id: fx.orders.id },
        actions: [
          {
            id: 'act_1',
            type: 'update_record',
            config: {
              table_id: fx.orders.id,
              fields: {
                [fid('amount')]: {
                  template: `{{ REGEXMATCH([${fid('title')}] & "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "^(a+)+$") }}`,
                },
              },
            },
          },
        ],
      };
      const row = await new AutomationsRepository(db).insert(orgScope(fx.orgId), {
        id: newId('aut'),
        baseId: fx.baseId,
        name: 'Injected',
        description: '',
        enabled: true,
        definition: regex,
        triggerType: 'record.created',
        triggerTableId: fx.orders.id,
        createdBy: fx.users.u_admin.id,
      });
      const stored = automationDefinitionSchema.parse(row.definition);
      expect(refusedFunctionsIn(stored)).toEqual([
        {
          path: `definition.actions[0].config.fields.${fid('amount')}.template`,
          function: 'REGEXMATCH',
        },
      ]);
      const evaluator = await evaluatorAs('u_admin', mine, stored);
      const [action] = stored.actions;
      if (action?.type !== 'update_record') throw new Error('unexpected action');
      const value = action.config.fields[fid('amount')];
      if (value === undefined) throw new Error('missing value');
      const started = performance.now();
      const error = await evaluator.resolve(value).catch((caught: unknown) => caught);
      if (timingBudgetsApply()) expect(performance.now() - started).toBeLessThan(50);
      expect(error).toBeInstanceOf(AutomationValueError);
      expect(error).toMatchObject({ code: 'unsupported_function' });
    });
  });
});
