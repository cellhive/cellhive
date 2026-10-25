import type { MetaTableName } from './schema.js';

/**
 * Global (non-tenant) tables of the `meta` schema: the **closed** list of
 * SPEC §5.10. They have no `organization_id` and are the only tables a
 * `GlobalRepository` may use. Adding a table here means changing SPEC §5.10
 * and the schema test in the same change.
 */
export const GLOBAL_TABLES = [
  'organizations',
  'users',
  'user_identities',
  'sessions',
  'password_resets',
] as const satisfies readonly MetaTableName[];

export type GlobalTableName = (typeof GLOBAL_TABLES)[number];

/** Every other `meta` table belongs to a tenant and has `organization_id`. */
export type TenantTableName = Exclude<MetaTableName, GlobalTableName>;

/**
 * Tenant tables created so far. The `Record` makes the compiler reject a
 * table added to `Database` but forgotten here.
 */
const TENANT_TABLE_SET = {
  org_members: true,
  groups: true,
  group_members: true,
  workspaces: true,
  workspace_members: true,
  bases: true,
  tables: true,
  fields: true,
  views: true,
  dashboards: true,
  dashboard_widgets: true,
  share_links: true,
  share_link_daily_stats: true,
  form_submissions: true,
  base_roles: true,
  base_role_members: true,
  invitations: true,
  jobs: true,
  imports: true,
  field_conversions: true,
  field_dependencies: true,
  computed_recompute_queue: true,
  attachments: true,
  form_covers: true,
  email_assets: true,
  automations: true,
  automation_runs: true,
  automation_run_steps: true,
  automation_batch_counters: true,
  automation_time_cursors: true,
  email_identities: true,
  email_identity_bases: true,
  email_identity_verifications: true,
  secrets: true,
  secret_bases: true,
  http_allowlist: true,
  incoming_webhooks: true,
  incoming_webhook_requests: true,
  http_deliveries: true,
  idempotency_keys: true,
  events: true,
  audit_logs: true,
  notifications: true,
  notification_deliveries: true,
  notification_preferences: true,
  notification_settings: true,
  notification_base_mutes: true,
  notification_buffer: true,
  record_follows: true,
  date_reminder_cursors: true,
  user_channels: true,
  user_channel_link_tokens: true,
  telegram_webhooks: true,
  api_tokens: true,
} as const satisfies Record<TenantTableName, true>;

export const TENANT_TABLES = Object.keys(TENANT_TABLE_SET) as readonly TenantTableName[];

export function isGlobalTable(name: string): name is GlobalTableName {
  return (GLOBAL_TABLES as readonly string[]).includes(name);
}

export function isTenantTable(name: string): name is TenantTableName {
  return Object.hasOwn(TENANT_TABLE_SET, name);
}
