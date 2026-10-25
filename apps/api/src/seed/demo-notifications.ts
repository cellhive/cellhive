import {
  recordFollowParamsSchema,
  recordQueryRequestSchema,
  recordReadParamsSchema,
  updateFieldRequestSchema,
  type Id,
} from '@cellhive/contracts';
import { FieldsRepository, orgScope } from '@cellhive/server-core';

import { AccessService } from '../common/access/access.service.js';
import { FieldService } from '../modules/field/field.service.js';
import { FollowService } from '../modules/record/follow.service.js';
import { RecordService } from '../modules/record/record.service.js';

import { DEMO_TABLE_NAMES } from './demo-tables.js';
import { SeedError } from './seed-error.js';

import type { DemoUserKey } from './demo-fixture.js';
import type { Principal } from '../common/auth/principal.js';
import type { RequestMeta } from '../common/auth/request-meta.js';
import type { INestApplicationContext } from '@nestjs/common';

type DemoTableKey = keyof typeof DEMO_TABLE_NAMES;

/**
 * The `user` fields of the demo whose new assignees are told (`notify_on_assign`,
 * CONTRACTS §22.2 "Bên phát `record.assigned`"): the person in charge of a
 * ticket and the owner of an order.
 */
export const DEMO_ASSIGN_FIELDS: readonly {
  readonly table: DemoTableKey;
  readonly name: string;
}[] = [
  { table: 'tickets', name: 'Phụ trách' },
  { table: 'orders', name: 'owner' },
];

/**
 * The due-date reminder of the demo (CONTRACTS §22.6): the day before a
 * ticket's "Hạn" at 09:00 (date-only field: the organization's time zone,
 * `Asia/Ho_Chi_Minh`), to the person in charge at that moment.
 */
export const DEMO_REMINDER = {
  table: 'tickets',
  field: 'Hạn',
  recipientField: 'Phụ trách',
  offsetMinutes: -1_440,
  timeOfDay: '09:00',
} as const;

/**
 * Sample follows (CONTRACTS §22.5), made by hand like the "Follow" button:
 * who follows which records, picked by a query as that user (first records
 * of the filter in `sort` order). Sales members get theirs from
 * `notify_on_assign` once someone assigns them: their custom role is given
 * last (`DemoSeeder.detect`), so they read nothing yet at this step.
 */
export const DEMO_FOLLOWS: readonly {
  readonly user: DemoUserKey;
  readonly table: DemoTableKey;
  /**
   * `mine`: assigned to the user ("Phụ trách"/`owner` has `current_user`);
   * `urgent`: "Ưu tiên" = Khẩn cấp; `none`: no filter.
   */
  readonly filter: 'mine' | 'urgent' | 'none';
  readonly count: number;
}[] = [
  { user: 'u_editor', table: 'tickets', filter: 'mine', count: 3 },
  { user: 'u_editor', table: 'orders', filter: 'mine', count: 2 },
  { user: 'u_admin', table: 'tickets', filter: 'urgent', count: 2 },
  { user: 'u_reader', table: 'orders', filter: 'none', count: 2 },
];

export interface DemoNotificationsInput {
  readonly organizationId: Id<'org'>;
  readonly tables: Readonly<Record<DemoTableKey, Id<'tbl'>>>;
  /** `u_admin` (base owner): changes the fields. */
  readonly admin: Principal;
  /** Runs a step as a demo user through a short-lived session. */
  readonly as: <T>(user: DemoUserKey, step: (principal: Principal) => Promise<T>) => Promise<T>;
  readonly meta: () => RequestMeta;
}

export interface DemoNotificationsResult {
  /** Fields with `notify_on_assign` turned on, as `Table · field`. */
  readonly assignFields: readonly string[];
  /** The reminder, as `Table · field`. */
  readonly reminder: string;
  /** Follows made, by user. */
  readonly follows: Readonly<Partial<Record<DemoUserKey, number>>>;
}

/**
 * The S5b part of `pnpm seed:demo` (BACKLOG T557, CONTRACTS §9), through the
 * services behind the API so that every step validates, audits and writes
 * its events like the web UI:
 *
 * - `notify_on_assign` on Tickets "Phụ trách" and Orders `owner`
 *   (`FieldService.update`, like `PATCH /fields/:id`);
 * - the reminder of Tickets "Hạn" (`options.reminder`: the day before at
 *   09:00, to "Phụ trách"); saving it arms its cursor now (`SchemaService`),
 *   so the dates of the sample data already past are never reminded;
 * - a few manual follows (`FollowService`, like `PUT …/follow`).
 *
 * It runs **before** the sample-data events are settled (`DemoSeeder`): the
 * records already exist, their events start nothing — no notification,
 * email or Telegram message is ever made for sample data. Telegram is not
 * linked (it needs a real bot).
 */
export async function seedDemoNotifications(
  app: INestApplicationContext,
  input: DemoNotificationsInput,
): Promise<DemoNotificationsResult> {
  const scope = orgScope(input.organizationId);
  const fieldsRepository = app.get(FieldsRepository);
  const fieldService = app.get(FieldService);
  const fieldId = async (table: DemoTableKey, name: string): Promise<Id<'fld'>> => {
    const field = (await fieldsRepository.listByTable(scope, input.tables[table])).find(
      (item) => item.name === name,
    );
    if (field === undefined) throw new SeedError(`${DEMO_TABLE_NAMES[table]} has no field ${name}`);
    return field.id;
  };
  const patchField = async (id: Id<'fld'>, options: Record<string, unknown>) => {
    await fieldService.update(
      input.admin,
      id,
      updateFieldRequestSchema.parse({ options }),
      input.meta(),
    );
  };

  const assignFields: string[] = [];
  for (const { table, name } of DEMO_ASSIGN_FIELDS) {
    await patchField(await fieldId(table, name), { notify_on_assign: true });
    assignFields.push(`${DEMO_TABLE_NAMES[table]} · ${name}`);
  }

  await patchField(await fieldId(DEMO_REMINDER.table, DEMO_REMINDER.field), {
    reminder: {
      offset_minutes: DEMO_REMINDER.offsetMinutes,
      time_of_day: DEMO_REMINDER.timeOfDay,
      recipients: 'field_user',
      user_field_id: await fieldId(DEMO_REMINDER.table, DEMO_REMINDER.recipientField),
    },
  });
  // The cached access of `u_admin` predates the changed fields (a request would load it afresh).
  app.get(AccessService).invalidate(input.admin);

  const records = app.get(RecordService);
  const follows = app.get(FollowService);
  const counts: Partial<Record<DemoUserKey, number>> = {};
  for (const spec of DEMO_FOLLOWS) {
    const tableId = input.tables[spec.table];
    const owner = await fieldId(spec.table, spec.table === 'tickets' ? 'Phụ trách' : 'owner');
    const filter =
      spec.filter === 'mine'
        ? {
            op: 'and',
            items: [{ field: owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
          }
        : spec.filter === 'urgent'
          ? {
              op: 'and',
              items: [
                { field: await fieldId(spec.table, 'Ưu tiên'), operator: 'is', value: 'Khẩn cấp' },
              ],
            }
          : null;
    const sort =
      spec.table === 'tickets' ? [{ field: await fieldId(spec.table, 'Hạn') }] : undefined;
    await input.as(spec.user, async (principal) => {
      const page = await records.queryRecords(
        principal,
        tableId,
        recordReadParamsSchema.parse({ field_key_type: 'id' }),
        recordQueryRequestSchema.parse({
          filter,
          ...(sort === undefined ? {} : { sort }),
          limit: spec.count,
          include_total: false,
        }),
      );
      if (page.records.length < spec.count) {
        throw new SeedError(
          `${spec.user} reads fewer than ${String(spec.count)} records to follow`,
        );
      }
      for (const record of page.records) {
        await follows.follow(
          principal,
          recordFollowParamsSchema.parse({ tableId, recordId: record.id }),
        );
      }
    });
    counts[spec.user] = (counts[spec.user] ?? 0) + spec.count;
  }

  return {
    assignFields,
    reminder: `${DEMO_TABLE_NAMES[DEMO_REMINDER.table]} · ${DEMO_REMINDER.field}`,
    follows: counts,
  };
}
