import {
  createAutomationRequestSchema,
  newId,
  type AutomationDefinitionInput,
  type Id,
} from '@cellhive/contracts';
import {
  AutomationsRepository,
  FieldsRepository,
  orgScope,
  UsersRepository,
} from '@cellhive/server-core';

import { AccessService } from '../common/access/access.service.js';
import { SessionService } from '../common/auth/session.service.js';
import { AutomationService } from '../modules/automation/automation.service.js';

import { SeedError } from './seed-error.js';

import type { Principal } from '../common/auth/principal.js';
import type { RequestMeta } from '../common/auth/request-meta.js';
import type { INestApplicationContext } from '@nestjs/common';

/** Automations of `seed:bench` (BACKLOG T519), all off: the automation bench turns them on. */
export const BENCH_AUTOMATION_NAMES = {
  /** `record.updated` on "Trạng thái" → `update_record` "Tiến độ" = 1 (1 000 parallel runs). */
  status: 'Bench: trạng thái → tiến độ',
  /** `record.date_reached` on "Hạn" → `send_notification` to "Phụ trách" (the 200k date scan). */
  due: 'Bench: đến hạn → thông báo',
  /** `record.updated` on "Mã" → `update_records` "Điểm" = 7 on the rows marked `BENCH_BULK_MARK`. */
  bulk: 'Bench: cập nhật hàng loạt',
} as const;

/** Text the bulk bench marks its rows with ("Địa chỉ"), the filter of `update_records`. */
export const BENCH_BULK_MARK = 'BENCH-BULK';

export interface BenchAutomationsInput {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly ownerId: Id<'usr'>;
}

/**
 * The automations of `pnpm seed:bench` (BACKLOG T519, CONTRACTS §9) on the
 * 200k table, created **off** by the bench owner through `AutomationService`
 * (same validation, events and audit as the API) — on, they would start
 * runs on a development worker. Idempotent: an automation of the same name
 * is kept. Returns how many were created.
 */
export async function seedBenchAutomations(
  app: INestApplicationContext,
  input: BenchAutomationsInput,
): Promise<number> {
  const scope = orgScope(input.organizationId);
  const existing = new Set(
    (
      await app
        .get(AutomationsRepository)
        .listPage(scope, input.baseId, {}, { offset: 0, limit: 100 })
    ).items.map((row) => row.name),
  );
  const fields = await app.get(FieldsRepository).listByTable(scope, input.tableId);
  const field = (name: string): Id<'fld'> => {
    const found = fields.find((item) => item.name === name);
    if (found === undefined) throw new SeedError(`the bench table has no field ${name}`);
    return found.id;
  };
  const definitions: Record<keyof typeof BENCH_AUTOMATION_NAMES, AutomationDefinitionInput> = {
    status: {
      trigger: {
        type: 'record.updated',
        table_id: input.tableId,
        watch_fields: [field('Trạng thái')],
      },
      actions: [
        {
          id: 'act_progress',
          type: 'update_record',
          config: { table_id: input.tableId, fields: { [field('Tiến độ')]: { literal: 1 } } },
        },
      ],
    },
    due: {
      trigger: { type: 'record.date_reached', table_id: input.tableId, field_id: field('Hạn') },
      actions: [
        {
          id: 'act_notify',
          type: 'send_notification',
          config: {
            recipients: [{ field: field('Phụ trách') }],
            title: { template: `Đến hạn: {{ [${field('Tên')}] }}` },
          },
        },
      ],
    },
    bulk: {
      trigger: {
        type: 'record.updated',
        table_id: input.tableId,
        watch_fields: [field('Mã')],
        skip_bulk: true,
      },
      actions: [
        {
          id: 'act_bulk',
          type: 'update_records',
          config: {
            table_id: input.tableId,
            filter: {
              op: 'and',
              items: [{ field: field('Địa chỉ'), operator: 'eq', value: BENCH_BULK_MARK }],
            },
            fields: { [field('Điểm')]: { literal: 7 } },
            limit: 10_000,
          },
        },
      ],
    },
  };

  const owner = await app.get(UsersRepository).findById(input.ownerId);
  if (owner === undefined) throw new SeedError('the bench owner is missing');
  const meta = (): RequestMeta => ({
    requestId: newId('req'),
    ip: null,
    userAgent: 'cellhive-seed',
  });
  const sessions = app.get(SessionService);
  const { session } = await sessions.create(owner.id, meta());
  const principal: Principal = { kind: 'session', userId: owner.id, user: owner, session };
  let created = 0;
  try {
    for (const [key, name] of Object.entries(BENCH_AUTOMATION_NAMES) as [
      keyof typeof BENCH_AUTOMATION_NAMES,
      string,
    ][]) {
      if (existing.has(name)) continue;
      await app.get(AutomationService).create(
        principal,
        input.baseId,
        createAutomationRequestSchema.parse({
          name,
          enabled: false,
          definition: definitions[key],
        }),
        meta(),
      );
      created += 1;
    }
  } finally {
    await sessions.revoke(session);
    app.get(AccessService).invalidate(principal);
  }
  return created;
}
