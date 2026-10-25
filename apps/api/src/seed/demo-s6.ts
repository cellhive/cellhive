import {
  createApiTokenRequestSchema,
  createRoleRequestSchema,
  createSecretRequestSchema,
  recordQueryRequestSchema,
  recordReadParamsSchema,
  type ApiTokenScope,
  type Id,
} from '@cellhive/contracts';
import { FieldsRepository, orgScope } from '@cellhive/server-core';

import { AccessService } from '../common/access/access.service.js';
import { ApiTokenService } from '../modules/api-token/api-token.service.js';
import { RecordService } from '../modules/record/record.service.js';
import { RoleService } from '../modules/role/role.service.js';
import { SecretService } from '../modules/secret/secret.service.js';

import { DEMO_ORDER_FIELDS, DEMO_TABLE_NAMES } from './demo-tables.js';
import { SeedError } from './seed-error.js';

import type { Principal } from '../common/auth/principal.js';
import type { RequestMeta } from '../common/auth/request-meta.js';
import type { INestApplicationContext } from '@nestjs/common';

type DemoTableKey = keyof typeof DEMO_TABLE_NAMES;

const DAY_MS = 86_400_000;

/**
 * The sample API token of `u_admin` (CONTRACTS §9, §26): read-only, limited
 * to the demo base, 90 days (the UI default). Its value is printed once.
 */
export const DEMO_API_TOKEN = {
  name: 'Đồng bộ kế toán',
  scopes: ['records:read', 'schema:read'] satisfies ApiTokenScope[],
  lifetimeDays: 90,
} as const;

/** A token of `u_admin` revoked right away: the token lists show a revoked row. */
export const DEMO_REVOKED_API_TOKEN = {
  name: 'Script nhập đơn cũ',
  scopes: ['records:write'] satisfies ApiTokenScope[],
  lifetimeDays: 30,
} as const;

/**
 * The sample HTTP secret (CONTRACTS §24): an auth header value for a CRM,
 * sendable only to `api.crm.example.com` (a reserved name — nothing is ever
 * sent there by the seed). The value is a placeholder.
 */
export const DEMO_HTTP_SECRET = {
  name: 'CRM API (demo)',
  value: 'Bearer demo-crm-token-0000000000000000',
  allowedHosts: ['api.crm.example.com'],
} as const;

/**
 * The custom role "Kho" (warehouse, BACKLOG T719): every part of a role
 * configured, including a record rule on a link field (T710) — it reads
 * only the orders of a few customers (`Khách hàng has_any_of [...]`), edits
 * their status, reads the order lines without prices
 * and the customers; no cost, no amount, no sharing. Not given to anyone:
 * the demo users keep the access of CONTRACTS §5.
 */
export const DEMO_WAREHOUSE_ROLE = {
  name: 'Kho',
  /** Customers whose orders the role reads (the first ones by name). */
  customers: 3,
} as const;

export interface DemoS6Input {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly tables: Readonly<Record<DemoTableKey, Id<'tbl'>>>;
  /** `u_admin`: organization owner and base owner. */
  readonly admin: Principal;
  readonly meta: () => RequestMeta;
}

/** The S6 samples of the run, for the summary (BACKLOG T719). */
export interface DemoS6Result {
  readonly apiToken: {
    readonly id: Id<'tok'>;
    readonly name: string;
    readonly scopes: readonly string[];
    readonly expiresAt: string | null;
    /** The token value, returned only by this call (stored as a hash). */
    readonly token: string;
  };
  readonly revokedTokenName: string;
  readonly secret: { readonly name: string; readonly allowedHosts: readonly string[] };
  readonly warehouseRole: { readonly name: string; readonly adjustments: number };
}

/**
 * The S6 part of `pnpm seed:demo` (BACKLOG T719, CONTRACTS §9), as
 * `u_admin` through the services behind the API — same validation, events
 * and audit as the web UI. It runs before the sample-data events are
 * settled, like the S5b/S5c samples. Nothing here calls the network: the
 * secret's host is only stored, the revocation is a Valkey message.
 */
export async function seedDemoS6(
  app: INestApplicationContext,
  input: DemoS6Input,
): Promise<DemoS6Result> {
  const tokens = app.get(ApiTokenService);
  const expiresIn = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
  // Like `POST /orgs/:orgId/me/api-tokens`.
  const token = await tokens.create(
    input.admin,
    input.organizationId,
    createApiTokenRequestSchema.parse({
      name: DEMO_API_TOKEN.name,
      scopes: DEMO_API_TOKEN.scopes,
      base_ids: [input.baseId],
      expires_at: expiresIn(DEMO_API_TOKEN.lifetimeDays),
    }),
    input.meta(),
  );
  const revoked = await tokens.create(
    input.admin,
    input.organizationId,
    createApiTokenRequestSchema.parse({
      name: DEMO_REVOKED_API_TOKEN.name,
      scopes: DEMO_REVOKED_API_TOKEN.scopes,
      base_ids: [input.baseId],
      expires_at: expiresIn(DEMO_REVOKED_API_TOKEN.lifetimeDays),
    }),
    input.meta(),
  );
  // Like `DELETE /api-tokens/:id`.
  await tokens.revoke(input.admin, revoked.id, input.meta());

  // Like `POST /orgs/:orgId/secrets`.
  const secret = await app.get(SecretService).create(
    input.admin,
    input.organizationId,
    createSecretRequestSchema.parse({
      kind: 'http_header',
      name: DEMO_HTTP_SECRET.name,
      value: DEMO_HTTP_SECRET.value,
      base_scope: 'selected',
      base_ids: [input.baseId],
      allowed_hosts: DEMO_HTTP_SECRET.allowedHosts,
    }),
    input.meta(),
  );

  const role = await seedWarehouseRole(app, input);
  return {
    apiToken: {
      id: token.id,
      name: token.name,
      scopes: token.scopes,
      expiresAt: token.expires_at,
      token: token.token,
    },
    revokedTokenName: revoked.name,
    secret: { name: secret.name, allowedHosts: secret.allowed_hosts },
    warehouseRole: role,
  };
}

async function seedWarehouseRole(
  app: INestApplicationContext,
  input: DemoS6Input,
): Promise<DemoS6Result['warehouseRole']> {
  const scope = orgScope(input.organizationId);
  const fieldRows = app.get(FieldsRepository);
  const fieldsOf = async (table: DemoTableKey) => fieldRows.listByTable(scope, input.tables[table]);
  const idIn = (rows: Awaited<ReturnType<typeof fieldsOf>>, table: DemoTableKey) => {
    return (name: string): Id<'fld'> => {
      const field = rows.find((item) => item.name === name);
      if (field === undefined)
        throw new SeedError(`${DEMO_TABLE_NAMES[table]} has no field ${name}`);
      return field.id;
    };
  };
  const order = idIn(await fieldsOf('orders'), 'orders');
  const line = idIn(await fieldsOf('orderLines'), 'orderLines');
  const customer = idIn(await fieldsOf('customers'), 'customers');

  // The customers of the rule: the first ones by name, read as u_admin.
  const page = await app.get(RecordService).queryRecords(
    input.admin,
    input.tables.customers,
    recordReadParamsSchema.parse({ field_key_type: 'id' }),
    recordQueryRequestSchema.parse({
      sort: [{ field: customer('Tên') }],
      limit: DEMO_WAREHOUSE_ROLE.customers,
      include_total: false,
    }),
  );
  if (page.records.length < DEMO_WAREHOUSE_ROLE.customers) {
    throw new SeedError(`${DEMO_TABLE_NAMES.customers} has too few records for the role "Kho"`);
  }
  const customerIds = page.records.map((record) => record.id);

  const base = await app.get(AccessService).requireBase(input.admin, input.baseId, 'admin');
  // Like `POST /bases/:baseId/roles`.
  const created = await app.get(RoleService).create(
    input.admin,
    base,
    createRoleRequestSchema.parse({
      name: DEMO_WAREHOUSE_ROLE.name,
      config: {
        base_rule: { copy: true, download: true, share_link: false },
        tables: {
          [input.tables.orders]: {
            perm: 'edit',
            view_rule: { allow_edit: false, visible_views: null },
            record_rule: {
              operations: [],
              // No edit filter: it is re-checked after the write (CONTRACTS §2),
              // so `status is Mới` would refuse setting an order to "Xong".
              edit_filter: null,
              // A record rule on a link field (T710): orders of these customers.
              read_scope: 'filter',
              read_filter: {
                op: 'and',
                items: [
                  {
                    field: order(DEMO_ORDER_FIELDS.customer),
                    operator: 'has_any_of',
                    value: customerIds,
                  },
                ],
              },
            },
            field_rule: {
              mode: 'all_read',
              fields: {
                [order('status')]: 'edit',
                [order('amount')]: 'no_perm',
                [order('cost')]: 'no_perm',
              },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
          [input.tables.orderLines]: {
            perm: 'read_only',
            view_rule: { allow_edit: false, visible_views: null },
            record_rule: {
              operations: [],
              edit_filter: null,
              read_scope: 'all',
              read_filter: null,
            },
            field_rule: {
              mode: 'all_read',
              fields: { [line('Đơn giá')]: 'no_perm' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
          [input.tables.customers]: {
            perm: 'read_only',
            view_rule: { allow_edit: false, visible_views: null },
            record_rule: {
              operations: [],
              edit_filter: null,
              read_scope: 'all',
              read_filter: null,
            },
            field_rule: {
              mode: 'all_read',
              fields: {},
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
        dashboards: {},
      },
    }),
    input.meta(),
  );
  return { name: created.name, adjustments: created.adjustments.length };
}
