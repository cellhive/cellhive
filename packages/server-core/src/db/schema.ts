import type {
  ApiTokenScope,
  EmailAssetKind,
  EmailIdentityBaseScope,
  EmailIdentityErrorReason,
  EmailIdentityMode,
  EmailIdentityStatus,
  EmailIdentityTransport,
  EmailIdentityVerifiedVia,
  HttpDeliveryKind,
  HttpDeliveryStatus,
  Id,
  IdPrefix,
  IncomingWebhookAuth,
  SecretBaseScope,
  SecretKind,
  UserChannelErrorReason,
  UserChannelKind,
  SmtpSecurity,
  TelegramWebhookErrorCode,
  TelegramWebhookStatus,
} from '@cellhive/contracts';
import type { ColumnType, Insertable, RawBuilder, Selectable, Updateable } from 'kysely';

/**
 * Kysely types of the `meta` schema (SPEC §5.10), created by migration 0001
 * onwards. Keep in sync with the migrations: a column added by a migration is
 * added here in the same change.
 *
 * Runtime representations follow the type parsers in `type-parsers.ts`:
 * `timestamptz` → `Date`, `int8` → `bigint`, `numeric` → `string`,
 * `date` → `'YYYY-MM-DD'` string, `inet` → `string`, `jsonb` → parsed JSON.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Values accepted when writing a `jsonb` column. `pg` serialises plain objects
 * with `JSON.stringify`, but turns JS arrays into PostgreSQL array literals, so
 * anything that is not an object must go through `jsonb()` (see `json.ts`).
 */
export type JsonbInput = JsonObject | RawBuilder<unknown>;

/** Immutable primary key with a public prefix (CONTRACTS §1.2). */
type PrimaryId<P extends IdPrefix> = ColumnType<Id<P>, Id<P>, never>;
/** Reference to another row by public ID. */
type Ref<P extends IdPrefix> = ColumnType<Id<P>, Id<P>, Id<P>>;
type NullableRef<P extends IdPrefix> = ColumnType<
  Id<P> | null,
  Id<P> | null | undefined,
  Id<P> | null
>;
/** Tenant key: set on insert, never changed. */
type OrganizationRef = ColumnType<Id<'org'>, Id<'org'>, never>;

/** `timestamptz NOT NULL` without default. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** `timestamptz NULL`. */
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
/** `created_at timestamptz NOT NULL DEFAULT now()`; never updated. */
export type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
/**
 * `updated_at timestamptz NOT NULL DEFAULT now()`. A `BEFORE UPDATE` trigger
 * (`meta.set_updated_at`) sets it on every update, so callers never write it.
 */
export type UpdatedAt = ColumnType<Date, Date | string | undefined, never>;
/** `timestamptz NOT NULL DEFAULT now()` that callers may update. */
export type TimestampWithDefault = ColumnType<Date, Date | string | undefined, Date | string>;

/** `int8`, parsed as `bigint` (never loses precision). */
export type Int8 = ColumnType<bigint, bigint | number, bigint | number>;
export type Int8WithDefault = ColumnType<bigint, bigint | number | undefined, bigint | number>;

export type Jsonb = ColumnType<JsonValue, JsonbInput, JsonbInput>;
export type JsonbWithDefault = ColumnType<JsonValue, JsonbInput | undefined, JsonbInput>;
export type NullableJsonb = ColumnType<
  JsonValue | null,
  JsonbInput | null | undefined,
  JsonbInput | null
>;

/** `text NULL`. */
export type NullableText = ColumnType<string | null, string | null | undefined, string | null>;
/** `text NOT NULL DEFAULT …`. */
export type TextWithDefault = ColumnType<string, string | undefined, string>;

export type OrgRole = 'owner' | 'admin' | 'member';
export type InvitableOrgRole = Exclude<OrgRole, 'owner'>;
export type PrincipalType = 'user' | 'group';
export type WorkspaceRole = 'admin' | 'member';
export type BaseRoleKind = 'system_admin' | 'system_editor' | 'system_reader' | 'custom';
export type UserStatus = 'active' | 'disabled' | 'deleted';
/** Who created a password reset link (SPEC §14.2). */
export type PasswordResetSource = 'self_service' | 'admin' | 'cli';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
/** `actor.type` of events and audit entries (CONTRACTS §8). */
export type ActorType =
  | 'user'
  | 'api_token'
  | 'automation'
  | 'share_link'
  | 'system'
  /** `webhook.received` only (T603): `meta.events`, never `meta.audit_logs`. */
  | 'webhook';

// --- Global tables (no organization_id; SPEC §5.10 closed list) -------------

export interface OrganizationsTable {
  id: PrimaryId<'org'>;
  name: string;
  slug: string;
  settings: JsonbWithDefault;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface UsersTable {
  id: PrimaryId<'usr'>;
  email: string;
  display_name: string;
  avatar_url: NullableText;
  password_hash: NullableText;
  status: ColumnType<UserStatus, UserStatus | undefined, UserStatus>;
  /** `NULL` = use the organization default. */
  locale: NullableText;
  /** `NULL` = use the organization default. */
  timezone: NullableText;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface UserIdentitiesTable {
  id: PrimaryId<'idn'>;
  user_id: Ref<'usr'>;
  provider: string;
  subject: string;
  /** Email reported by the provider at the last sign-in; display only (migration 0050). */
  email: NullableText;
  /** Last successful sign-in through this identity (migration 0050). */
  last_login_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface SessionsTable {
  id: PrimaryId<'ses'>;
  user_id: Ref<'usr'>;
  token_hash: string;
  expires_at: Timestamp;
  ip: NullableText;
  user_agent: NullableText;
  last_seen_at: TimestampWithDefault;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface PasswordResetsTable {
  id: PrimaryId<'pwr'>;
  user_id: Ref<'usr'>;
  token_hash: string;
  /** The issuing admin (`source = 'admin'`); `NULL` otherwise or once that user is deleted. */
  created_by: NullableRef<'usr'>;
  source: PasswordResetSource;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// --- Tenant tables ------------------------------------------------------------

export interface OrgMembersTable {
  organization_id: OrganizationRef;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  role: OrgRole;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface GroupsTable {
  id: PrimaryId<'grp'>;
  organization_id: OrganizationRef;
  name: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface GroupMembersTable {
  organization_id: OrganizationRef;
  group_id: ColumnType<Id<'grp'>, Id<'grp'>, never>;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface WorkspacesTable {
  id: PrimaryId<'wsp'>;
  organization_id: OrganizationRef;
  name: string;
  slug: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface WorkspaceMembersTable {
  organization_id: OrganizationRef;
  workspace_id: ColumnType<Id<'wsp'>, Id<'wsp'>, never>;
  principal_type: ColumnType<PrincipalType, PrincipalType, never>;
  /** `usr_…` or `grp_…` depending on `principal_type`. */
  principal_id: ColumnType<Id<'usr'> | Id<'grp'>, Id<'usr'> | Id<'grp'>, never>;
  role: WorkspaceRole;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface BasesTable {
  id: PrimaryId<'bse'>;
  organization_id: OrganizationRef;
  workspace_id: Ref<'wsp'>;
  owner_id: Ref<'usr'>;
  name: string;
  icon: NullableText;
  description: NullableText;
  settings: JsonbWithDefault;
  /** Bumped on every permission change (SPEC §14.1). */
  permission_version: Int8WithDefault;
  deleted_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface BaseRolesTable {
  id: PrimaryId<'rol'>;
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  name: string;
  kind: ColumnType<BaseRoleKind, BaseRoleKind, never>;
  config: JsonbWithDefault;
  position: ColumnType<number, number | undefined, number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface BaseRoleMembersTable {
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  role_id: Ref<'rol'>;
  principal_type: ColumnType<PrincipalType, PrincipalType, never>;
  principal_id: ColumnType<Id<'usr'> | Id<'grp'>, Id<'usr'> | Id<'grp'>, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface InvitationsTable {
  id: PrimaryId<'inv'>;
  organization_id: OrganizationRef;
  email: string;
  inviter_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  org_role: InvitableOrgRole;
  workspace_id: NullableRef<'wsp'>;
  token_hash: string;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface JobsTable {
  id: PrimaryId<'job'>;
  organization_id: OrganizationRef;
  type: string;
  status: ColumnType<JobStatus, JobStatus | undefined, JobStatus>;
  /** 0…1 */
  progress: ColumnType<number, number | undefined, number>;
  result: NullableJsonb;
  error: NullableJsonb;
  /** `NULL` = started by the system. */
  created_by: NullableRef<'usr'>;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface IdempotencyKeysTable {
  organization_id: OrganizationRef;
  /** Who sent the key, e.g. `usr_…` or `tok_…`. */
  principal_key: ColumnType<string, string, never>;
  key: ColumnType<string, string, never>;
  request_hash: string;
  /** Random id of the current claim; `complete`/`release` must match it. */
  claim_id: string | null;
  /** `NULL` while the first request is still being processed. */
  status_code: ColumnType<number | null, number | null | undefined, number | null>;
  response: NullableJsonb;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** Partitioned by month on `created_at`; primary key `(id, created_at)`. */
export interface EventsTable {
  id: ColumnType<Id<'evt'>, Id<'evt'>, never>;
  organization_id: OrganizationRef;
  type: ColumnType<string, string, never>;
  entity_type: ColumnType<string, string, never>;
  entity_id: ColumnType<string, string, never>;
  actor_type: ColumnType<ActorType, ActorType, never>;
  actor_id: ColumnType<string | null, string | null | undefined, never>;
  payload: ColumnType<JsonValue, JsonbInput | undefined, never>;
  causation: ColumnType<JsonValue | null, JsonbInput | null | undefined, never>;
  created_at: CreatedAt;
  /** Set by the `events.dispatch` job (T010). */
  dispatched_at: NullableTimestamp;
}

/**
 * Append-only (ADR-23): UPDATE/DELETE/TRUNCATE are rejected by triggers,
 * except the redaction done by `meta.audit_redact(...)`. Partitioned by month
 * on `created_at`; primary key `(id, created_at)`.
 */
export interface AuditLogsTable {
  id: ColumnType<Id<'aud'>, Id<'aud'>, never>;
  /** `NULL` only for `auth.*` without a known organization and for CLI commands (CONTRACTS §8). */
  organization_id: ColumnType<Id<'org'> | null, Id<'org'> | null | undefined, never>;
  base_id: ColumnType<Id<'bse'> | null, Id<'bse'> | null | undefined, never>;
  table_id: ColumnType<Id<'tbl'> | null, Id<'tbl'> | null | undefined, never>;
  actor_type: ColumnType<ActorType, ActorType, never>;
  actor_id: ColumnType<string | null, string | null | undefined, never>;
  via: ColumnType<JsonValue | null, JsonbInput | null | undefined, never>;
  action: ColumnType<string, string, never>;
  entity_type: ColumnType<string, string, never>;
  entity_id: ColumnType<string | null, string | null | undefined, never>;
  batch_id: ColumnType<string | null, string | null | undefined, never>;
  request_id: ColumnType<string | null, string | null | undefined, never>;
  before: ColumnType<JsonValue | null, JsonbInput | null | undefined, never>;
  after: ColumnType<JsonValue | null, JsonbInput | null | undefined, never>;
  ip: ColumnType<string | null, string | null | undefined, never>;
  user_agent: ColumnType<string | null, string | null | undefined, never>;
  created_at: CreatedAt;
}

/** `meta.tables.schema_state` (ADR-20): DDL is refused while `compacting`. */
export type TableSchemaState = 'ready' | 'compacting';
/** `meta.fields.compute_mode` of formula/lookup fields (SPEC §5.9); `NULL` otherwise. */
export type ComputeMode = 'stored' | 'virtual';
/** `meta.fields.compute_state` of formula/lookup fields (migration 0022, T456); `NULL` otherwise. */
export type ComputeState = 'ready' | 'backfilling' | 'recomputing' | 'error';

/**
 * `meta.tables` (SPEC §5.10, migration 0003): one row per physical
 * `data.<db_table_name>` table. Written only by `SchemaService`, except
 * `data_version` (bumped by record mutations, SPEC §10.4).
 */
export interface TablesTable {
  id: PrimaryId<'tbl'>;
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  name: string;
  description: NullableText;
  /** `t_<12 base36>` (SPEC §5.3), in schema `data`. Never changes, even on compaction. */
  db_table_name: ColumnType<string, string, never>;
  /** Collation of every text column of the table, copied from the base at creation. */
  collation: ColumnType<string, string, string>;
  /** Set in the transaction that creates the table (deferred FK). */
  primary_field_id: NullableRef<'fld'>;
  data_version: Int8WithDefault;
  schema_state: ColumnType<TableSchemaState, TableSchemaState | undefined, TableSchemaState>;
  compacted_at: NullableTimestamp;
  position: ColumnType<number, number | undefined, number>;
  deleted_at: NullableTimestamp;
  /** Migration 0020 (T461): purged from the trash; `data.t_x` is gone, lookups treat it as missing. */
  purged_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.fields` (SPEC §5.10, migration 0003). Written only by `SchemaService`. */
export interface FieldsTable {
  id: PrimaryId<'fld'>;
  organization_id: OrganizationRef;
  table_id: ColumnType<Id<'tbl'>, Id<'tbl'>, never>;
  name: string;
  /** A `FieldType` of `@cellhive/field-types`. */
  type: string;
  /**
   * `f_<12 base36>`; `NULL` for types without a column (system types). Only
   * a type conversion from/to such a type changes it (T403).
   */
  db_column_name: ColumnType<string | null, string | null | undefined, string | null>;
  compute_mode: ColumnType<ComputeMode | null, ComputeMode | null | undefined, ComputeMode | null>;
  /** Migration 0022 (T456): formula type of a computed field's value (`FormulaType` JSON). */
  result_type: ColumnType<JsonValue | null, JsonbInput | null | undefined, JsonbInput | null>;
  /** Migration 0022 (T456): `ready` | `backfilling` | `recomputing` | `error`. */
  compute_state: ColumnType<
    ComputeState | null,
    ComputeState | null | undefined,
    ComputeState | null
  >;
  /** Migration 0022 (T456/T460): `null` or `{ code, refs }`. */
  compute_error: ColumnType<JsonValue | null, JsonbInput | null | undefined, JsonbInput | null>;
  options: JsonbWithDefault;
  is_primary: ColumnType<boolean, boolean | undefined, never>;
  required: ColumnType<boolean, boolean | undefined, boolean>;
  unique_values: ColumnType<boolean, boolean | undefined, boolean>;
  description: NullableText;
  position: ColumnType<number, number | undefined, number>;
  deleted_at: NullableTimestamp;
  /** Physical name of the column while the field is in the trash (`f_…__deleted_<epoch>`). */
  deleted_column_name: NullableText;
  /** The deleted field's column was dropped (compaction): it can no longer be restored. */
  purged_at: NullableTimestamp;
  /** `link` fields only (migration 0011): the junction `l_<12 base36>` holding the values. */
  link_junction: ColumnType<string | null, string | null | undefined, never>;
  /** `link` fields only: the junction column of this field's table (`a` created it, `b` is the reverse). */
  link_side: ColumnType<LinkSide | null, LinkSide | null | undefined, never>;
  /**
   * Migration 0020 (T461): a `link` field put in the trash because its linked
   * table was purged (junction dropped): it can no longer be restored.
   */
  link_table_purged_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** Side of a link junction (`a_id` / `b_id`) a link field reads from (SPEC §5.6). */
export type LinkSide = 'a' | 'b';

/** `meta.views.type` (SPEC §8). */
export type ViewKind = 'grid' | 'kanban' | 'form';

/**
 * `meta.views` (SPEC §5.10, §8, migration 0007). `config` holds a
 * `StoredViewConfig` of `@cellhive/contracts`; a personal view has an owner,
 * a shared view none.
 */
export interface ViewsTable {
  id: PrimaryId<'viw'>;
  organization_id: OrganizationRef;
  table_id: ColumnType<Id<'tbl'>, Id<'tbl'>, never>;
  type: ColumnType<ViewKind, ViewKind, never>;
  name: string;
  config: JsonbWithDefault;
  position: ColumnType<number, number | undefined, number>;
  is_personal: ColumnType<boolean, boolean | undefined, boolean>;
  owner_id: NullableRef<'usr'>;
  locked: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.dashboard_widgets.type` (SPEC §10.2, CONTRACTS §28.2). */
export type DashboardWidgetKind =
  'kpi' | 'bar' | 'line' | 'pie' | 'combo' | 'table' | 'text' | 'filter_control';

/**
 * `meta.dashboards` (SPEC §5.10, §10, migration 0053, T805): one dashboard
 * of a base. `theme` / `global_filters` are checked by the API (CONTRACTS
 * §28.1); `version` grows with every change of the dashboard, its layout or
 * its widgets; `deleted_at` puts it in the base trash (30 days).
 */
export interface DashboardsTable {
  id: PrimaryId<'dsh'>;
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  name: string;
  icon: NullableText;
  description: NullableText;
  theme: JsonbWithDefault;
  global_filters: JsonbWithDefault;
  position: ColumnType<number, number | undefined, number>;
  version: ColumnType<number, number | undefined, number>;
  created_by: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  deleted_at: NullableTimestamp;
  deleted_by: NullableRef<'usr'>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * `meta.dashboard_widgets` (SPEC §5.10, §10, migration 0053, T805): one
 * widget of a dashboard, with its place on the 12-column grid (`layout
 * {x, y, w, h}`, the only layout source — BACKLOG "Quyết định S7" #5).
 */
export interface DashboardWidgetsTable {
  id: PrimaryId<'wgt'>;
  organization_id: OrganizationRef;
  dashboard_id: ColumnType<Id<'dsh'>, Id<'dsh'>, never>;
  type: ColumnType<DashboardWidgetKind, DashboardWidgetKind, never>;
  title: TextWithDefault;
  config: JsonbWithDefault;
  layout: Jsonb;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.share_links.target_type` (SPEC §15A.1). */
export type ShareLinkTargetKind = 'view' | 'form' | 'dashboard';
/** `meta.share_links.audience` (SPEC §15A.1). */
export type ShareLinkAudienceKind = 'org' | 'public';

/**
 * `meta.share_links` (SPEC §5.10, §15A, migration 0008). The token itself is
 * never stored: `token_hash` is its SHA-256 (hex), `token_prefix` its first
 * six characters. A revoked link is kept so that its token answers `410`.
 */
export interface ShareLinksTable {
  id: PrimaryId<'shl'>;
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  /** Table of the target view/form; `null` for dashboards. */
  table_id: ColumnType<Id<'tbl'> | null, Id<'tbl'> | null, never>;
  target_type: ColumnType<ShareLinkTargetKind, ShareLinkTargetKind, never>;
  target_id: ColumnType<string, string, never>;
  audience: ShareLinkAudienceKind;
  token_prefix: ColumnType<string, string, never>;
  token_hash: ColumnType<string, string, never>;
  password_hash: ColumnType<string | null, string | null | undefined, string | null>;
  expires_at: NullableTimestamp;
  settings: JsonbWithDefault;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  revoked_at: NullableTimestamp;
  revoked_by: NullableRef<'usr'>;
  last_accessed_at: NullableTimestamp;
  access_count: Int8WithDefault;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.share_link_daily_stats` (SPEC §15A.4, migration 0008): accesses per link and UTC day. */
export interface ShareLinkDailyStatsTable {
  organization_id: OrganizationRef;
  share_link_id: ColumnType<Id<'shl'>, Id<'shl'>, never>;
  /** `YYYY-MM-DD` (UTC). */
  day: ColumnType<string, string, never>;
  access_count: Int8WithDefault;
}

/**
 * `meta.form_submissions` (migration 0009, BACKLOG T306): a record created
 * through a form by a signed-in person, for per-person submission limits.
 */
export interface FormSubmissionsTable {
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  view_id: ColumnType<Id<'viw'>, Id<'viw'>, never>;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  share_link_id: ColumnType<Id<'shl'> | null, Id<'shl'> | null, never>;
  record_id: ColumnType<Id<'rec'>, Id<'rec'>, never>;
  submitted_at: ColumnType<Date, Date | undefined, never>;
}

/** `meta.imports.format` (CONTRACTS §19). */
export type ImportFileFormat = 'csv' | 'xlsx';

/**
 * `meta.imports` (migration 0010, BACKLOG T308): a temporary CSV/XLSX
 * upload, the parse options of its latest preview, and the import job that
 * used it. The file is in object storage under `{organization_id}/{id}`.
 */
export interface ImportsTable {
  id: PrimaryId<'imp'>;
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  created_by: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  filename: ColumnType<string, string, never>;
  format: ColumnType<ImportFileFormat, ImportFileFormat, never>;
  /** Bytes (≤ 50 MB); `int8` is read as `bigint`. */
  size: ColumnType<bigint, number, never>;
  options: JsonbWithDefault;
  job_id: NullableRef<'job'>;
  expires_at: Timestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.field_conversions.status` (T403). */
export type FieldConversionStatus = 'running' | 'succeeded' | 'failed' | 'reverted' | 'cleaned';

/**
 * `meta.field_conversions` (migration 0013, BACKLOG T403): one field type
 * conversion, keyed by its `field.convert` job. Written only by
 * `SchemaService` (definitions, columns, status) and the backfill
 * (`cursor_auto`, `counts`).
 */
/** `meta.field_conversions.kind` (migration 0015). */
export type FieldConversionKindValue = 'column' | 'to_two_way' | 'to_one_way' | 'to_single';

/** `meta.field_dependencies.kind` (SPEC §5.9). */
export type FieldDependencyKind = 'same_row' | 'via_link' | 'cross_table';

/**
 * `meta.field_dependencies` (SPEC §5.9, §5.10; migration 0022, T456): the
 * dependency graph of the computed fields of a base. Written only by
 * `SchemaService` with the field definition, in the same transaction.
 */
export interface FieldDependenciesTable {
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  field_id: ColumnType<Id<'fld'>, Id<'fld'>, never>;
  depends_on_field_id: ColumnType<Id<'fld'>, Id<'fld'>, never>;
  kind: ColumnType<FieldDependencyKind, FieldDependencyKind, never>;
  /** `[{ kind, link_path, condition_refs }]`: every way the field is read. */
  paths: ColumnType<JsonValue, JsonbInput, never>;
  created_at: CreatedAt;
}

/**
 * `meta.computed_recompute_queue` (migration 0024, BACKLOG T458): records of
 * a stored computed field left for the `computed.recompute` job (`'*'` =
 * every record, `after_auto` = where the job is). Written only by
 * `ComputedRecomputeService`.
 */
export interface ComputedRecomputeQueueTable {
  organization_id: OrganizationRef;
  field_id: ColumnType<Id<'fld'>, Id<'fld'>, never>;
  /** `rec_…`, or `'*'` for every record of the field's table. */
  record_id: ColumnType<string, string, never>;
  after_auto: ColumnType<bigint, string | bigint | undefined, string | bigint>;
  enqueued_at: ColumnType<Date, Date | string | undefined, Date | string>;
  /**
   * Causation (SPEC §11.6) of the writes that queued the row, merged
   * conservatively (migration 0030, T509); `NULL` = unknown.
   */
  causation: ColumnType<JsonValue | null, JsonbInput | null | undefined, JsonbInput | null>;
  /** Only the first value of a just created/restored record: no `record.updated` (T509). */
  created: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface FieldConversionsTable {
  job_id: PrimaryId<'job'>;
  organization_id: OrganizationRef;
  table_id: ColumnType<Id<'tbl'>, Id<'tbl'>, never>;
  field_id: ColumnType<Id<'fld'>, Id<'fld'>, never>;
  status: ColumnType<
    FieldConversionStatus,
    FieldConversionStatus | undefined,
    FieldConversionStatus
  >;
  /** `{ type, options, unique_values }` before the conversion. */
  from_definition: ColumnType<JsonValue, JsonbInput, never>;
  /** `{ type, options, unique_values }` after it. */
  to_definition: ColumnType<JsonValue, JsonbInput, never>;
  /** `f_x__old_<epoch ms>` after the swap; `NULL` when the source type had no column of its own. */
  old_column_name: ColumnType<string | null, string | null, never>;
  /** Canonical `f_…` of the converted values after the swap; `NULL` for link conversions (T404). */
  new_column_name: ColumnType<string | null, string | null, never>;
  /** `f_x__new_<epoch ms>`: filled by the job while `running`, renamed at the end; `NULL` for links. */
  shadow_column_name: ColumnType<string | null, string | null, never>;
  /** `column` (T403) or the link change (T404, migration 0015). */
  kind: ColumnType<FieldConversionKindValue, FieldConversionKindValue | undefined, never>;
  /** Other side of a link conversion (its schema is locked too while running). */
  partner_table_id: ColumnType<Id<'tbl'> | null, Id<'tbl'> | null | undefined, never>;
  partner_field_id: ColumnType<Id<'fld'> | null, Id<'fld'> | null | undefined, never>;
  /** `to_single`: `l_<id>__old_<epoch ms>`, the links it removed (7-day revert). */
  backup_table_name: ColumnType<string | null, string | null | undefined, never>;
  /** `{ locale, time_zone, settings }` the values are converted with. */
  context: ColumnType<JsonValue, JsonbInput | undefined, never>;
  /** Last `__auto` when the conversion started: rows created later are written in the new type. */
  max_auto: ColumnType<bigint, bigint | number | undefined, never>;
  /** Rows with `__auto` ≤ this are converted. */
  cursor_auto: Int8WithDefault;
  /** `{ total, affected, lost, truncated }` so far. */
  counts: JsonbWithDefault;
  created_by: ColumnType<Id<'usr'> | null, Id<'usr'> | null | undefined, never>;
  expires_at: ColumnType<Date, Date | string, never>;
  finished_at: NullableTimestamp;
  reverted_at: NullableTimestamp;
  cleaned_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.attachments.status` (CONTRACTS §20). */
export type AttachmentStatusValue = 'pending_upload' | 'ready' | 'pending_scan';

/** `meta.attachments.thumbnail_status` (migration 0016, BACKLOG T407). */
export type AttachmentThumbnailStatus = 'pending' | 'running' | 'ready' | 'skipped' | 'failed';

/**
 * `meta.attachments` (migration 0012, BACKLOG T406): one file of an
 * `attachment` cell per record (copies share `object_key`), or an upload
 * not attached yet (`record_id` `NULL`).
 */
export interface AttachmentsTable {
  id: PrimaryId<'att'>;
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  table_id: ColumnType<Id<'tbl'>, Id<'tbl'>, never>;
  field_id: ColumnType<Id<'fld'>, Id<'fld'>, never>;
  record_id: NullableRef<'rec'>;
  object_key: ColumnType<string, string, never>;
  filename: ColumnType<string, string, never>;
  mime: ColumnType<string, string, never>;
  /** Bytes; `int8` is read as `bigint`. */
  size: ColumnType<bigint, number, number>;
  sha256: ColumnType<string | null, string | null | undefined, string | null>;
  status: ColumnType<
    AttachmentStatusValue,
    AttachmentStatusValue | undefined,
    AttachmentStatusValue
  >;
  created_by: ColumnType<Id<'usr'> | null, Id<'usr'> | null, never>;
  detached_at: NullableTimestamp;
  /** Migration 0016 (T407): `NULL` = no thumbnail expected. */
  thumbnail_status: ColumnType<
    AttachmentThumbnailStatus | null,
    AttachmentThumbnailStatus | null | undefined,
    AttachmentThumbnailStatus | null
  >;
  thumbnail_started_at: NullableTimestamp;
  /** Migration 0017 (T408): the record was permanently deleted; the cleanup removes the file. */
  record_purged_at: NullableTimestamp;
  /** Migration 0018 (T410): the form link an upload came through; `NULL` for members. */
  share_link_id: ColumnType<Id<'shl'> | null, Id<'shl'> | null | undefined, never>;
  /** Migration 0018 (T410): the submit token session of a form link upload (SHA-256 hex). */
  upload_session: ColumnType<string | null, string | null | undefined, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.form_covers.status` (migration 0019, BACKLOG T419). */
export type FormCoverStatus = 'pending_upload' | 'ready';

/**
 * `meta.form_covers` (migration 0019, BACKLOG T419): a cover image uploaded
 * for a form view. The view config names the cover a form shows; covers no
 * form view names are deleted by `attachments.cleanup`.
 */
export interface FormCoversTable {
  id: PrimaryId<'att'>;
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  table_id: ColumnType<Id<'tbl'>, Id<'tbl'>, never>;
  view_id: ColumnType<Id<'viw'>, Id<'viw'>, never>;
  object_key: ColumnType<string, string, never>;
  filename: ColumnType<string, string, never>;
  mime: ColumnType<string, string, never>;
  /** Bytes; `int8` is read as `bigint`. */
  size: ColumnType<bigint, number, number>;
  sha256: ColumnType<string | null, string | null | undefined, string | null>;
  status: ColumnType<FormCoverStatus, FormCoverStatus | undefined, FormCoverStatus>;
  created_by: ColumnType<Id<'usr'> | null, Id<'usr'> | null, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.email_assets.status` (migration 0035, BACKLOG T534). */
export type EmailAssetStatus = 'pending_upload' | 'ready';

/**
 * `meta.email_assets` (migration 0035, BACKLOG T534): an image uploaded for
 * automation emails — a signature image (`kind = signature`) or an image of
 * one automation's body (`kind = automation`). Markdown references it as
 * `asset:<id>`; assets nothing references are deleted by
 * `attachments.cleanup`. Once `ready`, `mime`/`size`/`width`/`height` are
 * the processed image's (no metadata, ≤ 1280 px).
 */
export interface EmailAssetsTable {
  id: PrimaryId<'att'>;
  organization_id: OrganizationRef;
  kind: ColumnType<EmailAssetKind, EmailAssetKind, never>;
  /** Set once on a staged copy of a duplicated automation (T551); the foreign key clears it. */
  automation_id: ColumnType<Id<'aut'> | null, Id<'aut'> | null | undefined, Id<'aut'> | null>;
  object_key: ColumnType<string, string, never>;
  filename: ColumnType<string, string, never>;
  mime: ColumnType<string, string, string>;
  /** Bytes; `int8` is read as `bigint`. */
  size: ColumnType<bigint, number, number>;
  width: ColumnType<number | null, number | null | undefined, number | null>;
  height: ColumnType<number | null, number | null | undefined, number | null>;
  sha256: ColumnType<string | null, string | null | undefined, string | null>;
  status: ColumnType<EmailAssetStatus, EmailAssetStatus | undefined, EmailAssetStatus>;
  created_by: ColumnType<Id<'usr'> | null, Id<'usr'> | null, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.automations.disabled_reason` (ADR-25 §5, ADR-26 §5). */
export type AutomationDisabledReasonKind = 'run_as_lost_access' | 'circuit_breaker';

/**
 * `meta.automations` (SPEC §5.10, §11; migration 0027, BACKLOG T502).
 * `definition` is the stored definition (CONTRACTS §21, ids only);
 * `trigger_type`/`trigger_table_id` are copied from it on every save.
 * `run_as_user_id` is whose permissions the actions use (ADR-25).
 */
export interface AutomationsTable {
  id: PrimaryId<'aut'>;
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  name: string;
  description: TextWithDefault;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  disabled_reason: ColumnType<
    AutomationDisabledReasonKind | null,
    AutomationDisabledReasonKind | null | undefined,
    AutomationDisabledReasonKind | null
  >;
  definition: Jsonb;
  trigger_type: string;
  trigger_table_id: NullableRef<'tbl'>;
  version: ColumnType<number, number | undefined, number>;
  created_by: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  updated_by: Ref<'usr'>;
  run_as_user_id: Ref<'usr'>;
  run_as_since: TimestampWithDefault;
  /**
   * When it was last turned on (migration 0033, T508; set by a database
   * trigger): time triggers fire only for moments after it.
   */
  trigger_armed_at: ColumnType<Date | null, never, never>;
  deleted_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * `meta.automation_time_cursors` (migration 0033, BACKLOG T508): the end of
 * the window the `schedule` / `record.date_reached` scanner handled.
 */
export interface AutomationTimeCursorsTable {
  organization_id: OrganizationRef;
  automation_id: ColumnType<Id<'aut'>, Id<'aut'>, never>;
  scanned_until: ColumnType<Date, Date, Date>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.automation_runs.status` (SPEC §11.1). */
export type AutomationRunStatusKind =
  'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/** `meta.automation_runs` (SPEC §5.10, §11.1; migration 0027). Written from T503 on. */
export interface AutomationRunsTable {
  id: PrimaryId<'run'>;
  organization_id: OrganizationRef;
  automation_id: ColumnType<Id<'aut'>, Id<'aut'>, never>;
  automation_version: ColumnType<number, number, never>;
  trigger_event_id: ColumnType<Id<'evt'> | null, Id<'evt'> | null | undefined, never>;
  /** ADR-26 §5: `batch.id` of a bulk event, else `root_event_id` (a fire time for `schedule`). */
  trigger_unit: ColumnType<string, string, never>;
  status: ColumnType<
    AutomationRunStatusKind,
    AutomationRunStatusKind | undefined,
    AutomationRunStatusKind
  >;
  depth: ColumnType<number, number | undefined, never>;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  error: NullableJsonb;
  input: JsonbWithDefault;
  /** Running time of the segments already ended (SPEC §11.7; migration 0031, T505). */
  active_ms: ColumnType<bigint, bigint | number | undefined, bigint | number | RawBuilder<number>>;
  /** Start of the current running segment; `NULL` unless `running` (migration 0031). */
  running_since: NullableTimestamp;
  /**
   * Dedupe key of a run without an event (migration 0033, T508):
   * `automation_id:fired_at` or `automation_id:record_id:<value>`.
   */
  trigger_key: ColumnType<string | null, string | null | undefined, never>;
  /** Run this one repeats (`POST /automation-runs/:id/rerun`; migration 0032, T518). */
  rerun_of_run_id: ColumnType<Id<'run'> | null, Id<'run'> | null | undefined, never>;
  /** Who asked for the re-run; set for every re-run, even once the original is deleted. */
  rerun_by_user_id: ColumnType<Id<'usr'> | null, Id<'usr'> | null | undefined, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.automation_run_steps.status` (SPEC §11.7). */
export type AutomationStepStatusKind =
  'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/**
 * `meta.automation_run_steps` (SPEC §5.10, §11.7; migration 0027): created
 * before the side effect, `idempotency_key = automation_id:trigger_event_id:action_id`.
 */
export interface AutomationRunStepsTable {
  id: PrimaryId<'stp'>;
  organization_id: OrganizationRef;
  run_id: ColumnType<Id<'run'>, Id<'run'>, never>;
  action_id: ColumnType<string, string, never>;
  status: ColumnType<
    AutomationStepStatusKind,
    AutomationStepStatusKind | undefined,
    AutomationStepStatusKind
  >;
  attempt: ColumnType<number, number | undefined, number>;
  idempotency_key: ColumnType<string, string, never>;
  started_at: TimestampWithDefault;
  finished_at: NullableTimestamp;
  input: NullableJsonb;
  output: NullableJsonb;
  error: NullableJsonb;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.automation_batch_counters` (ADR-26 §4; migration 0027): fan-out per batch, kept 24h. */
export interface AutomationBatchCountersTable {
  organization_id: OrganizationRef;
  automation_id: ColumnType<Id<'aut'>, Id<'aut'>, never>;
  batch_id: ColumnType<string, string, never>;
  runs: ColumnType<number, number | undefined, number>;
  skipped: ColumnType<number, number | undefined, number>;
  /** `record.updated` events a recompute job wrote for it (migration 0030, T509). */
  events: ColumnType<number, number | undefined, number>;
  created_at: CreatedAt;
}

/** `meta.notification_deliveries.status` (migration 0028, T511). */
export type NotificationDeliveryStatus = 'pending' | 'sent' | 'skipped' | 'failed';

/**
 * `meta.notifications` (migration 0028, BACKLOG T511, ADR-29 §1): one row
 * per recipient. `type`/`entity_type` follow `@cellhive/contracts`
 * (`NOTIFICATION_TYPES`, `NOTIFICATION_ENTITY_TYPES`).
 */
export interface NotificationsTable {
  id: PrimaryId<'ntf'>;
  organization_id: OrganizationRef;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  type: ColumnType<string, string, never>;
  base_id: ColumnType<Id<'bse'> | null, Id<'bse'> | null | undefined, never>;
  table_id: ColumnType<Id<'tbl'> | null, Id<'tbl'> | null | undefined, never>;
  entity_type: ColumnType<string, string, never>;
  entity_id: ColumnType<string, string, never>;
  actor_type: ColumnType<ActorType | null, ActorType | null | undefined, never>;
  actor_id: ColumnType<string | null, string | null | undefined, never>;
  group_key: ColumnType<string | null, string | null | undefined, never>;
  payload: ColumnType<JsonValue, JsonbInput | undefined, never>;
  in_app: ColumnType<boolean, boolean | undefined, never>;
  read_at: NullableTimestamp;
  created_at: CreatedAt;
}

/** `meta.notification_deliveries` (migration 0028; `telegram` from 0040): email/Telegram outbox. */
export interface NotificationDeliveriesTable {
  organization_id: OrganizationRef;
  notification_id: ColumnType<Id<'ntf'>, Id<'ntf'>, never>;
  channel: ColumnType<'email' | 'telegram', 'email' | 'telegram', never>;
  status: ColumnType<
    NotificationDeliveryStatus,
    NotificationDeliveryStatus | undefined,
    NotificationDeliveryStatus
  >;
  attempts: ColumnType<number, number | undefined, number>;
  error_code: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  sent_at: NullableTimestamp;
}

/** `meta.notification_preferences` (migration 0028): no row = the type default. */
export interface NotificationPreferencesTable {
  organization_id: OrganizationRef;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  type: ColumnType<string, string, never>;
  channel: ColumnType<string, string, never>;
  enabled: ColumnType<boolean, boolean, boolean>;
  updated_at: UpdatedAt;
}

/** `meta.notification_settings` (migration 0028): email frequency per user and organization. */
export interface NotificationSettingsTable {
  organization_id: OrganizationRef;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  email_frequency: ColumnType<string, string | undefined, string>;
  daily_hour: ColumnType<number, number | undefined, number>;
  /** Migration 0039 (T543): follow the records the user creates by hand. */
  auto_follow_created: ColumnType<boolean, boolean | undefined, boolean>;
  /** Migration 0039 (T543): follow the records the user is assigned to (T544). */
  auto_follow_assigned: ColumnType<boolean, boolean | undefined, boolean>;
  updated_at: UpdatedAt;
}

/** `meta.notification_base_mutes` (migration 0028). */
export interface NotificationBaseMutesTable {
  organization_id: OrganizationRef;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  created_at: CreatedAt;
}

/**
 * `meta.notification_buffer` (migration 0038, BACKLOG T542, ADR-34 §2): rows
 * of bulk `record.assigned` / `record.followed_changed` waiting for
 * `notifications.flush`. `kind` follows `NOTIFICATION_BUFFER_KINDS`.
 */
export interface NotificationBufferTable {
  /** `bigint` identity (int8 parses to `bigint`, migration 0038). */
  id: ColumnType<bigint, never, never>;
  organization_id: OrganizationRef;
  kind: ColumnType<string, string, never>;
  group_key: ColumnType<string, string, never>;
  user_id: ColumnType<Id<'usr'> | null, Id<'usr'> | null | undefined, never>;
  table_id: ColumnType<Id<'tbl'>, Id<'tbl'>, never>;
  record_id: ColumnType<Id<'rec'>, Id<'rec'>, never>;
  field_ids: ColumnType<Id<'fld'>[], Id<'fld'>[] | undefined, never>;
  actor_type: ColumnType<ActorType | null, ActorType | null | undefined, never>;
  actor_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: CreatedAt;
}

/**
 * `meta.record_follows` (migration 0039, BACKLOG T543, ADR-34 §2): who
 * follows a record, and why (`source` follows `RECORD_FOLLOW_SOURCES`);
 * `muted` = unfollowed by hand (no automatic source follows again).
 */
export interface RecordFollowsTable {
  organization_id: OrganizationRef;
  table_id: ColumnType<Id<'tbl'>, Id<'tbl'>, never>;
  record_id: ColumnType<Id<'rec'>, Id<'rec'>, never>;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  source: ColumnType<string, string, string>;
  muted: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * `meta.date_reminder_cursors` (migration 0041, BACKLOG T547, ADR-34 §1):
 * the cursor of a `datetime` field whose reminder is on (the row exists
 * exactly while it is on). `boundary_*`: the due moment a capped scan
 * stopped at and the records due then that it already reminded of.
 */
export interface DateReminderCursorsTable {
  organization_id: OrganizationRef;
  field_id: ColumnType<Id<'fld'>, Id<'fld'>, never>;
  armed_at: ColumnType<Date, Date, Date>;
  scanned_until: ColumnType<Date, Date, Date>;
  boundary_due_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  boundary_record_ids: ColumnType<Id<'rec'>[], Id<'rec'>[] | undefined, Id<'rec'>[]>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * `meta.email_identities` (migration 0029, BACKLOG T530, ADR-33): a sender
 * identity. SMTP columns are set only for `transport = smtp`;
 * `smtp_password_enc` is sealed (`sealSecret`, purpose `email-identity-smtp`).
 */
export interface EmailIdentitiesTable {
  id: PrimaryId<'eid'>;
  organization_id: OrganizationRef;
  email: string;
  display_name: string;
  reply_to: NullableText;
  transport: EmailIdentityTransport;
  mode: EmailIdentityMode;
  status: ColumnType<EmailIdentityStatus, EmailIdentityStatus | undefined, EmailIdentityStatus>;
  status_before_disable: ColumnType<
    EmailIdentityStatus | null,
    EmailIdentityStatus | null | undefined,
    EmailIdentityStatus | null
  >;
  error_reason: ColumnType<
    EmailIdentityErrorReason | null,
    EmailIdentityErrorReason | null | undefined,
    EmailIdentityErrorReason | null
  >;
  verified_at: NullableTimestamp;
  verified_via: ColumnType<
    EmailIdentityVerifiedVia | null,
    EmailIdentityVerifiedVia | null | undefined,
    EmailIdentityVerifiedVia | null
  >;
  base_scope: ColumnType<
    EmailIdentityBaseScope,
    EmailIdentityBaseScope | undefined,
    EmailIdentityBaseScope
  >;
  signature_md: NullableText;
  smtp_host: NullableText;
  smtp_port: ColumnType<number | null, number | null | undefined, number | null>;
  smtp_security: ColumnType<
    SmtpSecurity | null,
    SmtpSecurity | null | undefined,
    SmtpSecurity | null
  >;
  smtp_username: NullableText;
  smtp_password_enc: NullableText;
  smtp_version: ColumnType<number, number | undefined, number>;
  auth_failures: ColumnType<number, number | undefined, number>;
  created_by: ColumnType<Id<'usr'> | null, Id<'usr'> | null | undefined, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.email_identity_bases` (migration 0029): bases of a `selected` identity scope. */
export interface EmailIdentityBasesTable {
  organization_id: OrganizationRef;
  identity_id: ColumnType<Id<'eid'>, Id<'eid'>, never>;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  created_at: CreatedAt;
}

/**
 * `meta.secrets` (migration 0036, BACKLOG T516; kinds and rotation columns
 * 0047, T606): a credential automations use (a Telegram bot token, an HTTP
 * auth header value, a Standard Webhooks signing secret). `ciphertext` is
 * the value sealed with AES-256-GCM (`sealSecret`, purpose `org-secret`):
 * never returned, logged or audited. `previous_ciphertext` (same seal) is
 * the value a `webhook_signing` secret had before it was replaced, used for
 * a second signature until `previous_expires_at`.
 */
export interface SecretsTable {
  id: PrimaryId<'sec'>;
  organization_id: OrganizationRef;
  kind: SecretKind;
  name: string;
  ciphertext: string;
  previous_ciphertext: ColumnType<string | null, string | null | undefined, string | null>;
  previous_expires_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * Migration 0051 (T701): canonical host patterns an HTTP secret may be sent
   * to; `{}` for `telegram_bot`, and for an HTTP secret stored before the
   * list existed (then `legacy_hosts_until` is set — exactly one of the two).
   */
  allowed_hosts: ColumnType<string[], string[] | undefined, string[]>;
  legacy_hosts_until: ColumnType<Date | null, Date | null | undefined, Date | null>;
  base_scope: ColumnType<SecretBaseScope, SecretBaseScope | undefined, SecretBaseScope>;
  created_by: ColumnType<Id<'usr'> | null, Id<'usr'> | null | undefined, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `meta.secret_bases` (migration 0036): bases of a `selected` secret scope. */
export interface SecretBasesTable {
  organization_id: OrganizationRef;
  secret_id: ColumnType<Id<'sec'>, Id<'sec'>, never>;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  created_at: CreatedAt;
}

/**
 * `meta.http_allowlist` (migration 0042, BACKLOG T600, ADR-35 §3): a host
 * automations may call on a private network. `pattern` is canonical and
 * unique in the organization; `host`/`wildcard`/`port` are its parts
 * (`port` `null` = ports 80/443).
 */
export interface HttpAllowlistTable {
  id: PrimaryId<'hal'>;
  organization_id: OrganizationRef;
  pattern: ColumnType<string, string, never>;
  host: ColumnType<string, string, never>;
  wildcard: ColumnType<boolean, boolean, never>;
  port: ColumnType<number | null, number | null, never>;
  note: ColumnType<string, string | undefined, never>;
  created_by: ColumnType<Id<'usr'> | null, Id<'usr'> | null | undefined, never>;
  created_at: CreatedAt;
}

/**
 * `meta.incoming_webhooks` (migration 0043, BACKLOG T602, ADR-35 §1): an
 * incoming webhook of a base. `token_hash` (hex SHA-256 of the URL token,
 * unique in the instance) finds it; `token_enc` lets base admins read the
 * URL again; `signing_secret_enc`/`signing_secret_prev_enc` are sealed,
 * `bearer_hash` is a hex SHA-256. `auth` agrees with the credentials present
 * (CHECK).
 */
export interface IncomingWebhooksTable {
  id: PrimaryId<'hok'>;
  organization_id: OrganizationRef;
  base_id: ColumnType<Id<'bse'>, Id<'bse'>, never>;
  name: string;
  token_hash: string;
  token_enc: string;
  auth: IncomingWebhookAuth;
  signing_secret_enc: ColumnType<string | null, string | null | undefined, string | null>;
  signing_secret_prev_enc: ColumnType<string | null, string | null | undefined, string | null>;
  signing_secret_prev_expires_at: NullableTimestamp;
  bearer_hash: ColumnType<string | null, string | null | undefined, string | null>;
  rate_limit_per_sec: ColumnType<number, number | undefined, number>;
  listen_until: NullableTimestamp;
  listened_by: NullableRef<'usr'>;
  sample: NullableJsonb;
  sample_captured_at: NullableTimestamp;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: ColumnType<Id<'usr'> | null, Id<'usr'> | null | undefined, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: NullableTimestamp;
}

/**
 * `meta.incoming_webhook_requests` (migration 0043, BACKLOG T602, ADR-35
 * §1): one received request, kept 7 days. `message_id` is the
 * `webhook-id` (unique per hook; `NULL` = no dedupe); a `duplicate` row
 * only logs a replay (no body, message id or event).
 */
export interface IncomingWebhookRequestsTable {
  id: PrimaryId<'whr'>;
  organization_id: OrganizationRef;
  incoming_webhook_id: ColumnType<Id<'hok'>, Id<'hok'>, never>;
  message_id: ColumnType<string | null, string | null | undefined, never>;
  received_at: CreatedAt;
  body: NullableJsonb;
  headers: JsonbWithDefault;
  query: JsonbWithDefault;
  size_bytes: ColumnType<number, number, never>;
  duplicate: ColumnType<boolean, boolean | undefined, never>;
  causation_accepted: ColumnType<boolean, boolean | undefined, never>;
  event_id: NullableRef<'evt'>;
}

/**
 * `meta.http_deliveries` (migration 0044, BACKLOG T605, ADR-35 §4): the
 * outbox of outbound HTTP calls. `request_enc` (URL, headers, body,
 * causation — sealed, purpose `http-delivery`) is `null` once the row is
 * final; `target_host` is the only part of the URL kept in clear.
 */
export interface HttpDeliveriesTable {
  id: PrimaryId<'hdl'>;
  organization_id: OrganizationRef;
  kind: ColumnType<HttpDeliveryKind, HttpDeliveryKind, never>;
  automation_id: ColumnType<Id<'aut'> | null, Id<'aut'> | null | undefined, never>;
  run_id: ColumnType<Id<'run'> | null, Id<'run'> | null | undefined, never>;
  action_id: ColumnType<string | null, string | null | undefined, never>;
  requested_by: NullableRef<'usr'>;
  idempotency_key: ColumnType<string, string, never>;
  message_id: ColumnType<string, string, never>;
  method: ColumnType<string, string, never>;
  target_host: ColumnType<string, string, never>;
  request_enc: ColumnType<string | null, string | null, string | null>;
  auth_secret_id: NullableRef<'sec'>;
  signing_secret_id: NullableRef<'sec'>;
  status: ColumnType<HttpDeliveryStatus, HttpDeliveryStatus | undefined, HttpDeliveryStatus>;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: TimestampWithDefault;
  lease_until: NullableTimestamp;
  last_status: ColumnType<number | null, number | null | undefined, number | null>;
  last_error: NullableJsonb;
  response: NullableJsonb;
  created_at: CreatedAt;
  completed_at: NullableTimestamp;
}

/**
 * `meta.telegram_webhooks` (migration 0046, BACKLOG T609, ADR-35 §7): the
 * webhook of an organization's notification bot in `webhook` mode. The
 * path token is only kept as its SHA-256 (`path_token_hash`); the
 * `secret_token` is sealed (purpose `telegram-webhook`); `registered_url`
 * is the registered URL **without** the path token.
 */
export interface TelegramWebhooksTable {
  organization_id: OrganizationRef;
  secret_id: Ref<'sec'>;
  path_token_hash: string;
  secret_token_enc: string;
  registered_url: string;
  status: ColumnType<
    TelegramWebhookStatus,
    TelegramWebhookStatus | undefined,
    TelegramWebhookStatus
  >;
  last_error_code: ColumnType<
    TelegramWebhookErrorCode | null,
    TelegramWebhookErrorCode | null | undefined,
    TelegramWebhookErrorCode | null
  >;
  last_checked_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * `meta.user_channels` (migration 0040, BACKLOG T549, ADR-34 §3): a
 * member's personal notification channel. `address_enc` is the chat id
 * sealed with `sealSecret` (purpose `user-channel`); `address_hmac` its
 * lookup HMAC (purpose `user-channel-lookup`). Neither is ever returned,
 * logged or audited.
 */
export interface UserChannelsTable {
  id: PrimaryId<'uch'>;
  organization_id: OrganizationRef;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  kind: ColumnType<UserChannelKind, UserChannelKind, never>;
  secret_id: NullableRef<'sec'>;
  address_enc: string;
  address_hmac: string;
  status: ColumnType<'linked' | 'error', 'linked' | 'error' | undefined, 'linked' | 'error'>;
  error_reason: ColumnType<
    UserChannelErrorReason | null,
    UserChannelErrorReason | null | undefined,
    UserChannelErrorReason | null
  >;
  linked_at: TimestampWithDefault;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * `meta.user_channel_link_tokens` (migration 0040, BACKLOG T549): one-time
 * `/start` tokens, by SHA-256 (`token_hash`) — never the token itself.
 */
export interface UserChannelLinkTokensTable {
  organization_id: OrganizationRef;
  token_hash: ColumnType<string, string, never>;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  kind: ColumnType<UserChannelKind, UserChannelKind | undefined, never>;
  secret_id: ColumnType<Id<'sec'>, Id<'sec'>, never>;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: TimestampWithDefault;
}

/**
 * `meta.email_identity_verifications` (migration 0029): the live
 * verification of an identity (link token hash, code HMAC, 24 h).
 */
export interface EmailIdentityVerificationsTable {
  identity_id: ColumnType<Id<'eid'>, Id<'eid'>, never>;
  organization_id: OrganizationRef;
  email: string;
  token_hash: string;
  code_hash: string;
  failed_attempts: ColumnType<number, number | undefined, number>;
  requested_by: NullableRef<'usr'>;
  expires_at: Timestamp;
  created_at: TimestampWithDefault;
  updated_at: UpdatedAt;
}

/**
 * `meta.api_tokens` (migration 0049, BACKLOG T703, ADR-36 §1): a personal
 * API token of a member. `token_hash` (SHA-256 of the whole token, 32
 * bytes, unique in the instance) finds it; the token itself is never
 * stored. Revocation is soft (`revoked_at`, `revoked_by`).
 */
export interface ApiTokensTable {
  id: PrimaryId<'tok'>;
  organization_id: OrganizationRef;
  user_id: ColumnType<Id<'usr'>, Id<'usr'>, never>;
  name: string;
  token_prefix: ColumnType<string, string, never>;
  token_hash: ColumnType<Buffer, Buffer, never>;
  scopes: ColumnType<ApiTokenScope[], ApiTokenScope[], never>;
  base_ids: ColumnType<Id<'bse'>[] | null, Id<'bse'>[] | null, never>;
  expires_at: ColumnType<Date | null, Date | string | null, never>;
  last_used_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revoked_by: NullableRef<'usr'>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** Every table of the `meta` schema, keyed as Kysely expects (`schema.table`). */
export interface Database {
  'meta.organizations': OrganizationsTable;
  'meta.users': UsersTable;
  'meta.user_identities': UserIdentitiesTable;
  'meta.sessions': SessionsTable;
  'meta.password_resets': PasswordResetsTable;
  'meta.org_members': OrgMembersTable;
  'meta.groups': GroupsTable;
  'meta.group_members': GroupMembersTable;
  'meta.workspaces': WorkspacesTable;
  'meta.workspace_members': WorkspaceMembersTable;
  'meta.bases': BasesTable;
  'meta.tables': TablesTable;
  'meta.fields': FieldsTable;
  'meta.views': ViewsTable;
  'meta.dashboards': DashboardsTable;
  'meta.dashboard_widgets': DashboardWidgetsTable;
  'meta.share_links': ShareLinksTable;
  'meta.share_link_daily_stats': ShareLinkDailyStatsTable;
  'meta.form_submissions': FormSubmissionsTable;
  'meta.base_roles': BaseRolesTable;
  'meta.base_role_members': BaseRoleMembersTable;
  'meta.invitations': InvitationsTable;
  'meta.jobs': JobsTable;
  'meta.imports': ImportsTable;
  'meta.field_conversions': FieldConversionsTable;
  'meta.field_dependencies': FieldDependenciesTable;
  'meta.computed_recompute_queue': ComputedRecomputeQueueTable;
  'meta.attachments': AttachmentsTable;
  'meta.form_covers': FormCoversTable;
  'meta.email_assets': EmailAssetsTable;
  'meta.automations': AutomationsTable;
  'meta.automation_runs': AutomationRunsTable;
  'meta.automation_run_steps': AutomationRunStepsTable;
  'meta.automation_batch_counters': AutomationBatchCountersTable;
  'meta.automation_time_cursors': AutomationTimeCursorsTable;
  'meta.idempotency_keys': IdempotencyKeysTable;
  'meta.events': EventsTable;
  'meta.audit_logs': AuditLogsTable;
  'meta.notifications': NotificationsTable;
  'meta.notification_deliveries': NotificationDeliveriesTable;
  'meta.notification_preferences': NotificationPreferencesTable;
  'meta.notification_settings': NotificationSettingsTable;
  'meta.notification_base_mutes': NotificationBaseMutesTable;
  'meta.notification_buffer': NotificationBufferTable;
  'meta.record_follows': RecordFollowsTable;
  'meta.date_reminder_cursors': DateReminderCursorsTable;
  'meta.email_identities': EmailIdentitiesTable;
  'meta.email_identity_bases': EmailIdentityBasesTable;
  'meta.email_identity_verifications': EmailIdentityVerificationsTable;
  'meta.secrets': SecretsTable;
  'meta.secret_bases': SecretBasesTable;
  'meta.http_allowlist': HttpAllowlistTable;
  'meta.incoming_webhooks': IncomingWebhooksTable;
  'meta.incoming_webhook_requests': IncomingWebhookRequestsTable;
  'meta.http_deliveries': HttpDeliveriesTable;
  'meta.user_channels': UserChannelsTable;
  'meta.user_channel_link_tokens': UserChannelLinkTokensTable;
  'meta.telegram_webhooks': TelegramWebhooksTable;
  'meta.api_tokens': ApiTokensTable;
}

/** Unqualified name of a `meta` table, e.g. `bases`. */
export type MetaTableName = keyof Database extends `meta.${infer T}` ? T : never;

export type Organization = Selectable<OrganizationsTable>;
export type User = Selectable<UsersTable>;
export type UserIdentity = Selectable<UserIdentitiesTable>;
export type Session = Selectable<SessionsTable>;
export type PasswordReset = Selectable<PasswordResetsTable>;
export type OrgMember = Selectable<OrgMembersTable>;
export type Base = Selectable<BasesTable>;
export type NewBase = Insertable<BasesTable>;
export type BaseUpdate = Updateable<BasesTable>;
export type TableRow = Selectable<TablesTable>;
export type FieldRow = Selectable<FieldsTable>;
export type ViewRow = Selectable<ViewsTable>;
export type DashboardRow = Selectable<DashboardsTable>;
export type DashboardWidgetRow = Selectable<DashboardWidgetsTable>;
export type ShareLinkRow = Selectable<ShareLinksTable>;
export type ImportRow = Selectable<ImportsTable>;
export type FieldConversionRow = Selectable<FieldConversionsTable>;
export type AttachmentRow = Selectable<AttachmentsTable>;
export type FormCoverRow = Selectable<FormCoversTable>;
export type EmailAssetRow = Selectable<EmailAssetsTable>;
export type EmailIdentityRow = Selectable<EmailIdentitiesTable>;
export type EmailIdentityVerificationRow = Selectable<EmailIdentityVerificationsTable>;
export type SecretRow = Selectable<SecretsTable>;
export type HttpAllowlistRow = Selectable<HttpAllowlistTable>;
export type IncomingWebhookRow = Selectable<IncomingWebhooksTable>;
export type IncomingWebhookRequestRow = Selectable<IncomingWebhookRequestsTable>;
export type HttpDeliveryRow = Selectable<HttpDeliveriesTable>;
export type UserChannelRow = Selectable<UserChannelsTable>;
export type UserChannelLinkTokenRow = Selectable<UserChannelLinkTokensTable>;
export type TelegramWebhookRow = Selectable<TelegramWebhooksTable>;
export type ApiTokenRow = Selectable<ApiTokensTable>;
export type AutomationRow = Selectable<AutomationsTable>;
export type AutomationRunRow = Selectable<AutomationRunsTable>;
export type AutomationRunStepRow = Selectable<AutomationRunStepsTable>;
export type Group = Selectable<GroupsTable>;
export type GroupMember = Selectable<GroupMembersTable>;
export type Workspace = Selectable<WorkspacesTable>;
export type WorkspaceMember = Selectable<WorkspaceMembersTable>;
export type BaseRole = Selectable<BaseRolesTable>;
export type BaseRoleMember = Selectable<BaseRoleMembersTable>;
export type Invitation = Selectable<InvitationsTable>;
