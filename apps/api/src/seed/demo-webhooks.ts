import {
  createAutomationRequestSchema,
  createHttpAllowlistEntryRequestSchema,
  createIncomingWebhookRequestSchema,
  type AutomationDefinitionInput,
  type Id,
} from '@cellhive/contracts';
import { FieldsRepository, orgScope } from '@cellhive/server-core';

import { AutomationService } from '../modules/automation/automation.service.js';
import { HttpAllowlistService } from '../modules/http-allowlist/http-allowlist.service.js';
import { IncomingWebhookService } from '../modules/incoming-webhook/incoming-webhook.service.js';

import { DEMO_ORDER_FIELDS, DEMO_TABLE_NAMES } from './demo-tables.js';
import { SeedError } from './seed-error.js';

import type { Principal } from '../common/auth/principal.js';
import type { RequestMeta } from '../common/auth/request-meta.js';
import type { INestApplicationContext } from '@nestjs/common';

type DemoTableKey = keyof typeof DEMO_TABLE_NAMES;

/** The sample incoming webhook (CONTRACTS §9, §25.1): Bearer only, the default rate. */
export const DEMO_INCOMING_WEBHOOK = { name: 'Đơn từ website', auth: 'bearer' } as const;

/**
 * The sample allowlist entry of the organization (CONTRACTS §25.4): an n8n
 * on the local network, by host name and port — nothing resolves it on a
 * fresh install, it only shows the format.
 */
export const DEMO_ALLOWLIST_PATTERN = 'n8n.local:5678';

/**
 * Where the sample `http_request` sends: port 9 (discard) on loopback. It is
 * off, and loopback stays blocked until the organization allowlists exactly
 * `localhost:9` (CONTRACTS §25.4) — the description says so.
 */
export const DEMO_HTTP_REQUEST_URL = 'http://localhost:9/';

/** Names of the S5c sample automations (CONTRACTS §9), in creation order. */
export const DEMO_WEBHOOK_AUTOMATION_NAMES = {
  fromWebsite: 'Đơn từ website: tạo đơn hàng',
  httpRequest: 'Gửi đơn mới ra hệ thống ngoài (mẫu)',
} as const;

export interface DemoWebhookSourcesInput {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  /** `u_admin`: organization owner and base owner. */
  readonly admin: Principal;
  readonly meta: () => RequestMeta;
}

export interface DemoWebhookSources {
  readonly hookId: Id<'hok'>;
  readonly hookName: string;
  /** `PUBLIC_URL/api/v1/hooks/<token>` (base admins can read it again). */
  readonly hookUrl: string;
  /** The Bearer token, returned only by this call (never stored in clear). */
  readonly bearerToken: string;
  readonly allowlist: readonly string[];
}

export interface DemoWebhookAutomationsInput {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly tables: Readonly<Record<DemoTableKey, Id<'tbl'>>>;
  readonly hookId: Id<'hok'>;
  readonly admin: Principal;
  readonly meta: () => RequestMeta;
}

/** The S5c samples of the run, for the summary (BACKLOG T615). */
export interface DemoWebhooksResult extends DemoWebhookSources {
  readonly automations: readonly { readonly name: string; readonly enabled: boolean }[];
}

/**
 * The first S5c part of `pnpm seed:demo` (BACKLOG T615, CONTRACTS §9), as
 * `u_admin` through the services behind the API — same validation, events
 * and audit as the web UI:
 *
 * - the incoming webhook "Đơn từ website" of the demo base, `auth = bearer`
 *   (`IncomingWebhookService.create`, like `POST /bases/:id/incoming-webhooks`):
 *   its Bearer token is returned once and printed once by the seed (dev);
 * - the allowlist entry `n8n.local:5678` (`HttpAllowlistService.create`,
 *   like `POST /orgs/:id/http-allowlist`).
 *
 * It runs **before** the sample-data events are settled (`DemoSeeder`),
 * like the S5b samples, so the hook's event is settled with the rest. No
 * request is sent anywhere: nothing here calls the network.
 */
export async function seedDemoWebhookSources(
  app: INestApplicationContext,
  input: DemoWebhookSourcesInput,
): Promise<DemoWebhookSources> {
  const hook = await app.get(IncomingWebhookService).create(
    input.admin,
    input.baseId,
    createIncomingWebhookRequestSchema.parse({
      name: DEMO_INCOMING_WEBHOOK.name,
      auth: DEMO_INCOMING_WEBHOOK.auth,
    }),
    input.meta(),
  );
  if (hook.bearer_token === null) throw new SeedError('the sample webhook has no Bearer token');
  const entry = await app
    .get(HttpAllowlistService)
    .create(
      input.admin,
      input.organizationId,
      createHttpAllowlistEntryRequestSchema.parse({ pattern: DEMO_ALLOWLIST_PATTERN }),
      input.meta(),
    );
  return {
    hookId: hook.id,
    hookName: hook.name,
    hookUrl: hook.url,
    bearerToken: hook.bearer_token,
    allowlist: [entry.pattern],
  };
}

/**
 * The second S5c part of `pnpm seed:demo`: two automations, both **off**,
 * created like the S5 samples after the settlement (an organization with an
 * automation cannot settle its events, BACKLOG T519):
 *
 * - "Đơn từ website: tạo đơn hàng": `webhook.received` of the sample hook →
 *   `create_record` in Orders (title and amount from the request body,
 *   status "Mới");
 * - "Gửi đơn mới ra hệ thống ngoài (mẫu)": a new order → `http_request`
 *   `POST http://localhost:9/` with a JSON body; it needs `localhost:9` in
 *   the organization's allowlist before it can send (its description says
 *   so).
 */
export async function seedDemoWebhookAutomations(
  app: INestApplicationContext,
  input: DemoWebhookAutomationsInput,
): Promise<DemoWebhooksResult['automations']> {
  const rows = await app
    .get(FieldsRepository)
    .listByTable(orgScope(input.organizationId), input.tables.orders);
  const order = (name: string): Id<'fld'> => {
    const field = rows.find((item) => item.name === name);
    if (field === undefined) throw new SeedError(`${DEMO_TABLE_NAMES.orders} has no field ${name}`);
    return field.id;
  };
  const title = order(DEMO_ORDER_FIELDS.title);
  const amount = order('amount');

  const samples: {
    name: string;
    description: string;
    definition: AutomationDefinitionInput;
  }[] = [
    {
      name: DEMO_WEBHOOK_AUTOMATION_NAMES.fromWebsite,
      description:
        'Tạo đơn hàng từ request của webhook "Đơn từ website" — body JSON ' +
        '{ "title": "…", "amount": 1500000 }. Bật khi website đã gửi Bearer token.',
      definition: {
        trigger: { type: 'webhook.received', incoming_webhook_id: input.hookId },
        actions: [
          {
            id: 'act_create',
            type: 'create_record',
            config: {
              table_id: input.tables.orders,
              fields: {
                [title]: { trigger: 'body', path: 'title' },
                [amount]: { trigger: 'body', path: 'amount' },
                [order('status')]: { literal: 'Mới' },
              },
            },
          },
        ],
      },
    },
    {
      name: DEMO_WEBHOOK_AUTOMATION_NAMES.httpRequest,
      description:
        'Mẫu gọi HTTP ra ngoài: cần thêm localhost:9 vào allowlist HTTP của tổ chức ' +
        '(Cài đặt › Tích hợp) — hoặc đổi URL sang hệ thống thật — trước khi bật.',
      definition: {
        trigger: { type: 'record.created', table_id: input.tables.orders, skip_bulk: true },
        actions: [
          {
            id: 'act_http',
            type: 'http_request',
            config: {
              method: 'POST',
              url: { literal: DEMO_HTTP_REQUEST_URL },
              body: {
                type: 'json',
                value: {
                  template: `{ "order": "{{ [${title}] }}", "amount": "{{ [${amount}] }}" }`,
                },
              },
            },
          },
        ],
      },
    },
  ];

  const service = app.get(AutomationService);
  const automations: { name: string; enabled: boolean }[] = [];
  for (const sample of samples) {
    const created = await service.create(
      input.admin,
      input.baseId,
      createAutomationRequestSchema.parse({
        name: sample.name,
        description: sample.description,
        enabled: false,
        definition: sample.definition,
      }),
      input.meta(),
    );
    automations.push({ name: created.name, enabled: created.enabled });
  }
  return automations;
}
