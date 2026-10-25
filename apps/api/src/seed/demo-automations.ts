import {
  createAutomationRequestSchema,
  createEmailIdentityRequestSchema,
  createFieldRequestSchema,
  createSecretRequestSchema,
  type AutomationDefinitionInput,
  type CreateEmailIdentityRequest,
  type Id,
} from '@cellhive/contracts';
import { AppError, FieldsRepository, orgScope, type AppConfig } from '@cellhive/server-core';

import { AccessService } from '../common/access/access.service.js';
import { APP_CONFIG } from '../common/tokens.js';
import { AutomationService } from '../modules/automation/automation.service.js';
import { EmailIdentityService } from '../modules/email-identity/email-identity.service.js';
import { FieldService } from '../modules/field/field.service.js';
import { SecretService } from '../modules/secret/secret.service.js';

import { DEMO_COMPUTED_FIELDS } from './demo-computed.js';
import { DEMO_EMAIL_DOMAIN } from './demo-fixture.js';
import { DEMO_ORDER_FIELDS, DEMO_TABLE_NAMES } from './demo-tables.js';
import { SeedError } from './seed-error.js';

import type { Principal } from '../common/auth/principal.js';
import type { RequestMeta } from '../common/auth/request-meta.js';
import type { INestApplicationContext } from '@nestjs/common';

type DemoTableKey = keyof typeof DEMO_TABLE_NAMES;

/** Names of the S5 sample automations (CONTRACTS §9), in creation order. */
export const DEMO_AUTOMATION_NAMES = {
  urgent: 'Ticket khẩn cấp: báo người phụ trách',
  sla: 'Nhắc SLA ticket mới sau 4 giờ',
  digest: 'Tổng hợp ticket quá hạn lúc 08:00',
  approve: 'Duyệt nhanh đơn hàng',
  linesTotal: 'Báo khi tổng tiền hàng thay đổi',
  telegram: 'Ticket khẩn cấp: báo nhóm qua Telegram',
} as const;

/** The button field of Orders that runs "Duyệt nhanh đơn hàng" (T517). */
export const DEMO_BUTTON_FIELD = { name: 'Duyệt nhanh', label: 'Duyệt nhanh' } as const;

/**
 * The sample Telegram bot (T516): a well-formed but fake token — it never
 * reaches Telegram, the automations using it are off.
 */
export const DEMO_TELEGRAM_BOT = {
  name: 'Bot CSKH (demo)',
  token: '123456789:DEMO-not-a-real-bot-token-000000000',
  chat: '@cellhive_demo_cskh',
} as const;

/** Never a real password: the "Phòng IT" identity has its own (example) SMTP server. */
export const DEMO_IT_SMTP = {
  host: 'example.com',
  port: 587,
  password: 'demo-placeholder-not-a-real-password',
} as const;

/** Display names of the sample sender identities (ADR-33). */
export const DEMO_IDENTITY_NAMES = {
  support: 'Phòng CSKH',
  hr: 'Phòng Nhân sự',
  it: 'Phòng IT',
} as const;

export interface DemoAutomationsInput {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly tables: Readonly<Record<DemoTableKey, Id<'tbl'>>>;
  /** `u_admin`: org owner and base owner; `run_as` of every sample automation. */
  readonly admin: Principal;
  /** Address of `u_admin`: the recipient of the daily digest. */
  readonly adminEmail: string;
  readonly meta: () => RequestMeta;
}

export interface DemoAutomationsResult {
  readonly automations: readonly { readonly name: string; readonly enabled: boolean }[];
  readonly identities: readonly {
    readonly name: string;
    readonly email: string;
    readonly mode: string;
    readonly status: string;
  }[];
  /** Why an identity could not be created (offline: its SMTP host does not resolve). */
  readonly warnings: readonly string[];
}

/** The domain of `SMTP_FROM`, else the demo domain (no SMTP configured). */
export function supportDomainOf(config: AppConfig): string {
  const from = config.mail?.fromAddress;
  const domain = from?.slice(from.lastIndexOf('@') + 1).toLowerCase();
  return domain === undefined || domain === '' ? DEMO_EMAIL_DOMAIN : domain;
}

/**
 * The S5 part of `pnpm seed:demo` (BACKLOG T519, CONTRACTS §9), created as
 * `u_admin` through the services behind the API (`EmailIdentityService`,
 * `SecretService`, `FieldService`, `AutomationService`: same validation,
 * events and audit as the web UI):
 *
 * - three sender identities, **pending** on a fresh database (the seed sends
 *   no email and never verifies one): "Phòng CSKH" `support@<domain of
 *   SMTP_FROM>` (`system`, `send_as` when SMTP is configured), "Phòng Nhân
 *   sự" `hr-demo@example.com` (`system`, `on_behalf`) and "Phòng IT"
 *   (`smtp` on `example.com:587`, a placeholder password — never a real
 *   one), each with a signature;
 * - a Telegram bot secret with a fake token;
 * - the button field "Duyệt nhanh" on Orders;
 * - six automations: Tickets entering "Ưu tiên = Khẩn cấp" →
 *   `send_notification` + `send_email` (on only when SMTP is configured);
 *   new ticket → `delay` 4 h + recheck "not done" → `send_notification`;
 *   `schedule` 08:00 → `find_records` overdue tickets → `digest` email +
 *   Telegram (off); the "Duyệt nhanh" button → `update_record` status; a
 *   `watch_fields` trigger on the stored lookup "Tổng tiền hàng" →
 *   `send_notification`; "Khẩn cấp" → `send_telegram` (off).
 *
 * Email steps use the system sender: identities are not verified yet.
 */
export async function seedDemoAutomations(
  app: INestApplicationContext,
  input: DemoAutomationsInput,
): Promise<DemoAutomationsResult> {
  const config = app.get<AppConfig>(APP_CONFIG);
  const scope = orgScope(input.organizationId);
  const fieldsRepository = app.get(FieldsRepository);
  const fieldsOf = async (table: DemoTableKey) => {
    const rows = await fieldsRepository.listByTable(scope, input.tables[table]);
    return (name: string): Id<'fld'> => {
      const field = rows.find((item) => item.name === name);
      if (field === undefined) {
        throw new SeedError(`${DEMO_TABLE_NAMES[table]} has no field ${name}`);
      }
      return field.id;
    };
  };

  // Sender identities: created like `POST /orgs/:orgId/email-identities`.
  const identityService = app.get(EmailIdentityService);
  const identities: DemoAutomationsResult['identities'][number][] = [];
  const warnings: string[] = [];
  const supportDomain = supportDomainOf(config);
  const identityBodies: CreateEmailIdentityRequest[] = [
    {
      email: `support@${supportDomain}`,
      display_name: DEMO_IDENTITY_NAMES.support,
      transport: 'system',
      signature_md:
        '**Phòng Chăm sóc khách hàng**  \nCellhive Demo · Hotline 1900 1234  \n' +
        `support@${supportDomain}`,
    },
    {
      email: 'hr-demo@example.com',
      display_name: DEMO_IDENTITY_NAMES.hr,
      transport: 'system',
      signature_md: '**Phòng Nhân sự**  \nCellhive Demo · 028 3822 1234',
    },
    {
      email: 'it-demo@example.com',
      display_name: DEMO_IDENTITY_NAMES.it,
      transport: 'smtp',
      smtp: {
        host: DEMO_IT_SMTP.host,
        port: DEMO_IT_SMTP.port,
        security: 'starttls',
        username: 'it-demo@example.com',
        password: DEMO_IT_SMTP.password,
      },
      signature_md: '**Phòng IT**  \nHỗ trợ kỹ thuật nội bộ · máy lẻ 108',
    },
  ];
  for (const body of identityBodies) {
    try {
      const created = await identityService.create(
        input.admin,
        input.organizationId,
        createEmailIdentityRequestSchema.parse(body),
        input.meta(),
      );
      identities.push({
        name: created.identity.display_name,
        email: created.identity.email,
        mode: created.identity.mode,
        status: created.identity.status,
      });
    } catch (error) {
      // Only the SMTP host check can fail on a fresh database (no network, no DNS).
      const code = error instanceof AppError ? error.errors?.[0]?.code : undefined;
      if (code !== 'HOST_UNRESOLVABLE') throw error;
      warnings.push(
        `Sender identity "${body.display_name}" skipped: ${DEMO_IT_SMTP.host} could not be resolved (offline?).`,
      );
    }
  }

  // The Telegram bot: like `POST /orgs/:orgId/secrets`.
  const bot = await app.get(SecretService).create(
    input.admin,
    input.organizationId,
    createSecretRequestSchema.parse({
      kind: 'telegram_bot',
      name: DEMO_TELEGRAM_BOT.name,
      value: DEMO_TELEGRAM_BOT.token,
      base_scope: 'selected',
      base_ids: [input.baseId],
    }),
    input.meta(),
  );

  // The button field of Orders: like `POST /tables/:tableId/fields`.
  const button = await app.get(FieldService).create(
    input.admin,
    input.tables.orders,
    createFieldRequestSchema.parse({
      name: DEMO_BUTTON_FIELD.name,
      type: 'button',
      options: {
        label: DEMO_BUTTON_FIELD.label,
        color: 5,
        confirm: {
          title: 'Duyệt đơn hàng này?',
          message: 'Trạng thái của đơn sẽ chuyển sang "Xong".',
          confirm_label: 'Duyệt',
        },
      },
    }),
    input.meta(),
  );

  // The cached access of `u_admin` predates the new field (a request would load it afresh).
  app.get(AccessService).invalidate(input.admin);

  const ticket = await fieldsOf('tickets');
  const order = await fieldsOf('orders');
  const ref = (fieldId: Id<'fld'>) => `{{ [${fieldId}] }}`;
  const urgent = {
    op: 'and',
    items: [{ field: ticket('Ưu tiên'), operator: 'is', value: 'Khẩn cấp' }],
  };
  const notDone = {
    op: 'and',
    items: [{ field: ticket('Trạng thái'), operator: 'is_not', value: 'Đã xong' }],
  };
  const mailConfigured = config.mail !== null;

  const samples: { name: string; enabled: boolean; definition: AutomationDefinitionInput }[] = [
    {
      name: DEMO_AUTOMATION_NAMES.urgent,
      // Its email step needs SMTP: off on an instance without SMTP_URL.
      enabled: mailConfigured,
      definition: {
        trigger: { type: 'record.matches', table_id: input.tables.tickets, condition: urgent },
        actions: [
          {
            id: 'act_notify',
            type: 'send_notification',
            config: {
              recipients: [{ field: ticket('Phụ trách') }],
              title: { template: `Ticket khẩn cấp: ${ref(ticket('Tiêu đề'))}` },
              body: {
                template: `Mã ${ref(ticket('Mã ticket'))} · hạn ${ref(ticket('Hạn'))}`,
              },
            },
          },
          {
            id: 'act_email',
            type: 'send_email',
            config: {
              to: [{ field: ticket('Phụ trách') }],
              subject: { template: `[Khẩn cấp] ${ref(ticket('Tiêu đề'))}` },
              body: {
                format: 'markdown',
                template:
                  'Chào bạn,\n\n' +
                  `Ticket **${ref(ticket('Mã ticket'))}** vừa chuyển sang mức *Khẩn cấp*:\n\n` +
                  `- Tiêu đề: ${ref(ticket('Tiêu đề'))}\n` +
                  `- Hạn xử lý: ${ref(ticket('Hạn'))}\n\n` +
                  'Mở ticket: {{ [@url] }}',
              },
            },
          },
        ],
      },
    },
    {
      name: DEMO_AUTOMATION_NAMES.sla,
      enabled: true,
      definition: {
        trigger: { type: 'record.created', table_id: input.tables.tickets, skip_bulk: true },
        actions: [
          {
            id: 'act_wait',
            type: 'delay',
            config: { minutes: 240, recheck_condition: notDone },
          },
          {
            id: 'act_notify',
            type: 'send_notification',
            config: {
              recipients: [{ field: ticket('Phụ trách') }],
              title: { template: `Ticket quá SLA 4 giờ: ${ref(ticket('Tiêu đề'))}` },
            },
          },
        ],
      },
    },
    {
      name: DEMO_AUTOMATION_NAMES.digest,
      enabled: false,
      definition: {
        trigger: { type: 'schedule', cron: '0 8 * * *' },
        actions: [
          {
            id: 'act_find',
            type: 'find_records',
            config: {
              table_id: input.tables.tickets,
              filter: {
                op: 'and',
                items: [
                  {
                    field: ticket('Hạn'),
                    operator: 'before',
                    value: { $date: { relative: 'today' } },
                  },
                  ...notDone.items,
                ],
              },
              sort: [{ field: ticket('Hạn'), direction: 'asc' }],
              fields: [ticket('Tiêu đề'), ticket('Hạn'), ticket('Phụ trách')],
              limit: 200,
            },
          },
          {
            id: 'act_email',
            type: 'send_email',
            config: {
              to: [{ literal: input.adminEmail }],
              subject: { template: 'Ticket quá hạn chưa xong' },
              body: {
                format: 'markdown',
                template: 'Các ticket quá hạn chưa xong:\n\n{{ [@digest] }}',
                digest: {
                  step: 'act_find',
                  row_template: `- ${ref(ticket('Tiêu đề'))} (hạn ${ref(ticket('Hạn'))})`,
                  max_rows: 50,
                },
              },
            },
          },
          {
            id: 'act_telegram',
            type: 'send_telegram',
            config: {
              secret_id: bot.id,
              chat_id: { literal: DEMO_TELEGRAM_BOT.chat },
              text: {
                template: '<b>Ticket quá hạn chưa xong</b>\n{{ [@digest] }}',
                digest: {
                  step: 'act_find',
                  row_template: `• ${ref(ticket('Tiêu đề'))}`,
                  max_rows: 20,
                },
              },
            },
          },
        ],
      },
    },
    {
      name: DEMO_AUTOMATION_NAMES.approve,
      enabled: true,
      definition: {
        trigger: {
          type: 'button.clicked',
          table_id: input.tables.orders,
          field_id: button.id,
          min_permission: 'edit',
          enabled_when: {
            op: 'and',
            items: [{ field: order('status'), operator: 'is', value: 'Mới' }],
          },
        },
        actions: [
          {
            id: 'act_approve',
            type: 'update_record',
            config: {
              table_id: input.tables.orders,
              fields: { [order('status')]: { literal: 'Xong' } },
            },
          },
        ],
      },
    },
    {
      name: DEMO_AUTOMATION_NAMES.linesTotal,
      enabled: true,
      definition: {
        trigger: {
          type: 'record.updated',
          table_id: input.tables.orders,
          // A stored lookup (T509: recomputed values are events too).
          watch_fields: [order(DEMO_COMPUTED_FIELDS.orders.linesTotal)],
          skip_bulk: true,
        },
        actions: [
          {
            id: 'act_notify',
            type: 'send_notification',
            config: {
              recipients: [{ field: order('owner') }],
              title: { template: `Đơn ${ref(order(DEMO_ORDER_FIELDS.title))} đổi tổng tiền hàng` },
              body: {
                template: `Tổng tiền hàng mới: ${ref(order(DEMO_COMPUTED_FIELDS.orders.linesTotal))}`,
              },
              skip_actor: true,
            },
          },
        ],
      },
    },
    {
      name: DEMO_AUTOMATION_NAMES.telegram,
      enabled: false,
      definition: {
        trigger: { type: 'record.matches', table_id: input.tables.tickets, condition: urgent },
        actions: [
          {
            id: 'act_telegram',
            type: 'send_telegram',
            config: {
              secret_id: bot.id,
              chat_id: { literal: DEMO_TELEGRAM_BOT.chat },
              text: { template: `<b>Ticket khẩn cấp</b>: ${ref(ticket('Tiêu đề'))}` },
            },
          },
        ],
      },
    },
  ];

  const automationService = app.get(AutomationService);
  const automations: DemoAutomationsResult['automations'][number][] = [];
  for (const sample of samples) {
    const created = await automationService.create(
      input.admin,
      input.baseId,
      createAutomationRequestSchema.parse({
        name: sample.name,
        enabled: sample.enabled,
        definition: sample.definition,
      }),
      input.meta(),
    );
    automations.push({ name: created.name, enabled: created.enabled });
  }
  return { automations, identities, warnings };
}
