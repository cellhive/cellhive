import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { ACTOR_TYPES, AUDIT_ACTIONS, type AuditAction } from './events.js';
import { idOf } from './ids.js';
import { cursorListSchema, cursorQuerySchema, cursorRecordListSchema } from './pagination.js';
import { fieldKeyTypeSchema, MAX_RECORDS_PER_REQUEST, recordSchema } from './records.js';

/**
 * Record history, value revert, record trash and the audit log admin API
 * (ADR-23, CONTRACTS §11). Every list here is cursor-paginated
 * (`{ items | records, next_cursor }`, no `total`).
 */

/** Actions shown in a record's history (CONTRACTS §11.1). */
export const RECORD_HISTORY_ACTIONS = [
  'record.created',
  'record.updated',
  'record.deleted',
  'record.restored',
] as const;
export type RecordHistoryAction = (typeof RECORD_HISTORY_ACTIONS)[number];

/**
 * Who made a change (CONTRACTS §11.1). `name`: a user's display name, a
 * share link's target view/form name (record history: only for readers who
 * see that view); `null` for the system, deleted users and deleted targets.
 */
export const auditActorSchema = z
  .strictObject({
    type: z.enum(ACTOR_TYPES),
    id: z.string().nullable(),
    name: z.string().nullable(),
  })
  .meta({ id: 'AuditActor' });
export type AuditActorDto = z.infer<typeof auditActorSchema>;

/**
 * Where a change came from besides the actor (CONTRACTS §11.1). A change
 * made through an API token (actor = the token's user, ADR-36 §1) names
 * the token only to organization owners/admins and the token's owner:
 * everyone else reads `api_token_id: null, api_token_name: null` (S6
 * decision #19).
 */
export const auditViaSchema = z
  .strictObject({
    automation_id: idOf('aut').optional(),
    run_id: idOf('run').optional(),
    api_token_id: idOf('tok')
      .nullable()
      .optional()
      .meta({
        description:
          'The change was made through an API token; `null` when the reader may not know which ' +
          '(only organization owners/admins and the token owner do)',
      }),
    api_token_name: z
      .string()
      .nullable()
      .optional()
      .meta({
        description:
          'Current name of the token, next to `api_token_id`; `null` once the token is deleted ' +
          'or when `api_token_id` is `null`',
      }),
    share_link_id: idOf('shl').optional(),
    import_job_id: idOf('job').optional(),
    reverted_from: idOf('aud').optional(),
    incoming_webhook_id: idOf('hok')
      .optional()
      .meta({ description: 'Written by a run started by this incoming webhook (T604)' }),
    mcp: z
      .literal(true)
      .optional()
      .meta({ description: 'Through the MCP server, next to `api_token_id` (T921, T923)' }),
    ai_field_id: idOf('fld')
      .optional()
      .meta({ description: 'A value generated for this AI field by the AI worker (T910)' }),
  })
  .meta({ id: 'AuditVia' });
export type AuditViaDto = z.infer<typeof auditViaSchema>;

// --- Record history (§11.1) ----------------------------------------------------------

export const recordHistoryBatchSchema = z
  .strictObject({
    id: z.string().meta({ description: 'Request (`req_…`) or job (`job_…`) id' }),
    size: z.int().min(2).meta({ description: 'Record changes made by the same request or job' }),
  })
  .meta({ id: 'RecordHistoryBatch' });

/** `from`/`to` of one field, rendered like `cell_format=json` against the current meta. */
export const recordHistoryChangeSchema = z.strictObject({
  from: z.unknown(),
  to: z.unknown(),
});

export const recordHistoryEntrySchema = z
  .strictObject({
    id: idOf('aud'),
    action: z.enum(RECORD_HISTORY_ACTIONS),
    created_at: isoDateTimeSchema,
    actor: auditActorSchema,
    via: auditViaSchema.nullable(),
    batch: recordHistoryBatchSchema
      .nullable()
      .meta({ description: 'Set when the request or job changed more than one record' }),
    changes: z.record(z.string(), recordHistoryChangeSchema).meta({
      description:
        'Changed fields (keyed per `field_key_type`) the caller can read now. Deleted ' +
        'options and users read `{ "id", "name": null, "deleted": true }`; deleted fields ' +
        'are absent. Link and `parent` fields (T465) read `[{ "id", "title" }]` / ' +
        '`{ "id", "title" }` with the title under the caller’s current access (`null` when ' +
        'unreadable, P20) and `{ "id", "title": null, "deleted": true }` for records ' +
        'deleted since; computed fields have no history.',
    }),
  })
  .meta({ id: 'RecordHistoryEntry' });
export type RecordHistoryEntry = z.infer<typeof recordHistoryEntrySchema>;

export const recordHistoryResponseSchema = cursorListSchema(recordHistoryEntrySchema).meta({
  id: 'RecordHistory',
});
export type RecordHistoryResponse = z.infer<typeof recordHistoryResponseSchema>;

/** `GET /tables/:tableId/records/:recordId/history`. */
export const recordHistoryQuerySchema = cursorQuerySchema.extend({
  field_key_type: fieldKeyTypeSchema.default('name'),
  field: z.string().min(1).optional().meta({
    description: 'Only entries that changed this field (name or id per `field_key_type`)',
  }),
});
export type RecordHistoryQuery = z.infer<typeof recordHistoryQuerySchema>;

// --- Revert (§11.2) --------------------------------------------------------------------

/** `field_key_type` of the returned record. */
export const recordKeyParamsSchema = z.object({
  field_key_type: fieldKeyTypeSchema.default('name'),
});
export type RecordKeyParams = z.infer<typeof recordKeyParamsSchema>;

export const revertRecordRequestSchema = z
  .strictObject({
    audit_id: idOf('aud'),
    version: z
      .int()
      .min(1)
      .optional()
      .meta({ description: 'Optimistic check; a mismatch is `409 VERSION_CONFLICT`' }),
  })
  .meta({ id: 'RevertRecordRequest' });
export type RevertRecordRequest = z.infer<typeof revertRecordRequestSchema>;

/** The record after a revert (CONTRACTS §11.2), like `PATCH`, plus dropped linked records. */
export const revertedRecordSchema = recordSchema
  .extend({
    skipped: z
      .int()
      .min(1)
      .optional()
      .meta({
        description:
          'Linked records (link and `parent` fields, T465) of the entry that were not ' +
          'restored because they were deleted since; absent when none',
      }),
  })
  .meta({ id: 'RevertedRecord' });
export type RevertedRecordDto = z.infer<typeof revertedRecordSchema>;

// --- Trash (§11.3) ---------------------------------------------------------------------

export const trashedRecordSchema = recordSchema
  .extend({
    deleted_at: isoDateTimeSchema,
    deleted_by: z
      .strictObject({ id: idOf('usr'), name: z.string().nullable() })
      .nullable()
      .meta({ description: 'Who moved the record to the trash; `null` for the system' }),
    branch_size: z
      .int()
      .min(1)
      .optional()
      .meta({
        description:
          'Sub-records (T405): descendants deleted together with this record ("delete whole ' +
          'branch") that `POST …/records/restore` with `branch: true` brings back with it; ' +
          'absent when none',
      }),
  })
  .meta({ id: 'TrashedRecord' });
export type TrashedRecordDto = z.infer<typeof trashedRecordSchema>;

export const recordTrashResponseSchema = cursorRecordListSchema(trashedRecordSchema).meta({
  id: 'RecordTrash',
});
export type RecordTrashResponse = z.infer<typeof recordTrashResponseSchema>;

/** `GET /tables/:tableId/records/trash`. */
export const recordTrashQuerySchema = cursorQuerySchema.extend({
  field_key_type: fieldKeyTypeSchema.default('name'),
});
export type RecordTrashQuery = z.infer<typeof recordTrashQuerySchema>;

// --- Audit log (§11.4) -----------------------------------------------------------------

const entityTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .meta({ description: 'e.g. `record`, `field`, `table`, `base`, `user`' });

/** Most values of one repeatable audit filter (`action`, `action_prefix`, `actor_id`, `via`). */
export const MAX_AUDIT_FILTER_VALUES = 20;

/**
 * Action groups of `action_prefix` (CONTRACTS §8, §11.4): the entity part of
 * every audit action, dot included. Closed: a prefix matches exactly the
 * actions of `AUDIT_ACTIONS` that start with it (`email.` is not
 * `email_identity.`). A unit test keeps it equal to the catalogue.
 */
export const AUDIT_ACTION_PREFIXES = [
  'ai.',
  'ai_settings.',
  'api_token.',
  'audit.',
  'auth.',
  'automation.',
  'base.',
  'button.',
  'dashboard.',
  'email.',
  'email_identity.',
  'export.',
  'field.',
  'form.',
  'group.',
  'group_member.',
  'http_allowlist.',
  'incoming_webhook.',
  'invitation.',
  'mcp.',
  'org.',
  'org_member.',
  'permission.',
  'record.',
  'role.',
  'role_assignment.',
  'schedule.',
  'schema.',
  'secret.',
  'setup.',
  'share_link.',
  'table.',
  'user.',
  'user_channel.',
  'view.',
  'webhook.',
  'workspace.',
  'workspace_member.',
] as const;
export type AuditActionPrefix = (typeof AUDIT_ACTION_PREFIXES)[number];

/** The audit actions an action group stands for (`action_prefix`). */
export function auditActionsOfPrefix(prefix: AuditActionPrefix): AuditAction[] {
  return AUDIT_ACTIONS.filter((action) => action.startsWith(prefix));
}

/**
 * Sources of `via` (CONTRACTS §11.1, §11.4): an entry written through an API
 * token (`via.api_token_id`), an automation (`via.automation_id`), a share
 * link or form (`via.share_link_id`), an import (`via.import_job_id`) or the
 * MCP server (`via.mcp`, always with `api_token_id`, T923).
 */
export const AUDIT_VIA_KINDS = ['api_token', 'automation', 'share_link', 'import', 'mcp'] as const;
export type AuditViaKind = (typeof AUDIT_VIA_KINDS)[number];

/**
 * A repeatable filter: one value (`?action=a`) or several
 * (`?action=a&action=b`, or a JSON array in an export body), at most
 * `MAX_AUDIT_FILTER_VALUES`; the values of one filter combine with OR.
 */
function oneOrMany<T extends z.ZodType<string>>(item: T, description: string) {
  return z
    .union([item, z.array(item).min(1).max(MAX_AUDIT_FILTER_VALUES)])
    .transform((value): z.output<T>[] => (Array.isArray(value) ? value : [value]))
    .optional()
    .meta({
      description:
        `${description}. Repeat it for several values (at most ` +
        `${String(MAX_AUDIT_FILTER_VALUES)}, combined with OR).`,
    });
}

/**
 * Filters of the audit log lists and exports (all optional). Different
 * filters combine with AND; the values of one repeatable filter with OR.
 */
const auditFilterShape = {
  actor_id: oneOrMany(
    z.string().min(1).max(64),
    'Entries by this actor (`usr_…`, `aut_…`, `shl_…`)',
  ),
  table_id: idOf('tbl').optional(),
  entity_type: entityTypeSchema.optional(),
  entity_id: z.string().min(1).max(64).optional(),
  action: oneOrMany(z.string().min(1).max(64), 'Exact action, e.g. `record.updated` (§8)'),
  action_prefix: oneOrMany(
    z.enum(AUDIT_ACTION_PREFIXES).meta({ id: 'AuditActionPrefix' }),
    'Action group: every action starting with it, e.g. `record.`, `field.`, `role.`, `auth.`',
  ),
  via: oneOrMany(
    z.enum(AUDIT_VIA_KINDS).meta({ id: 'AuditViaKind' }),
    'Written through an API token, an automation, a share link/form, an import or the MCP ' +
      'server (`via`); `api_token` includes the MCP entries',
  ),
  batch_id: z.string().min(1).max(64).optional(),
  from: isoDateTimeSchema.optional().meta({ description: 'Inclusive lower bound of `created_at`' }),
  to: isoDateTimeSchema.optional().meta({ description: 'Exclusive upper bound of `created_at`' }),
};

/** `include=refs`: names of the users, fields, tables and API tokens of the page. */
const auditIncludeSchema = z
  .enum(['refs'])
  .optional()
  .meta({ description: '`refs`: add the names of what the page refers to' });

/** `GET /bases/:baseId/audit-logs`. */
export const baseAuditLogQuerySchema = cursorQuerySchema.extend({
  ...auditFilterShape,
  include: auditIncludeSchema,
});
export type BaseAuditLogQuery = z.infer<typeof baseAuditLogQuerySchema>;

/** `GET /orgs/:orgId/audit-logs`: the base filters plus `base_id`. */
export const orgAuditLogQuerySchema = baseAuditLogQuerySchema.extend({
  base_id: idOf('bse').optional(),
});
export type OrgAuditLogQuery = z.infer<typeof orgAuditLogQuerySchema>;

/** Filters of a base export (same keys as the base list, in the JSON body). */
export const baseAuditLogFiltersSchema = z
  .strictObject(auditFilterShape)
  .meta({ id: 'BaseAuditLogFilters' });
export type BaseAuditLogFilters = z.infer<typeof baseAuditLogFiltersSchema>;

/** Filters of an export (same keys as the org list, in the JSON body). */
export const auditLogFiltersSchema = z
  .strictObject({ ...auditFilterShape, base_id: idOf('bse').optional() })
  .meta({ id: 'AuditLogFilters' });
export type AuditLogFilters = z.infer<typeof auditLogFiltersSchema>;

export const auditLogEntrySchema = z
  .strictObject({
    id: idOf('aud'),
    created_at: isoDateTimeSchema,
    actor: auditActorSchema,
    via: auditViaSchema.nullable(),
    action: z.string(),
    entity_type: z.string(),
    entity_id: z.string().nullable(),
    base_id: idOf('bse').nullable(),
    table_id: idOf('tbl').nullable(),
    batch_id: z.string().nullable(),
    request_id: z.string().nullable(),
    before: z.record(z.string(), z.unknown()).nullable().meta({
      description: 'Storage-form values before the change (`{"redacted": true}` once redacted)',
    }),
    after: z.record(z.string(), z.unknown()).nullable(),
    ip: z.string().nullable(),
    user_agent: z.string().nullable(),
  })
  .meta({ id: 'AuditLogEntry' });
export type AuditLogEntryDto = z.infer<typeof auditLogEntrySchema>;

/**
 * `refs` of an audit page (`include=refs`, CONTRACTS §11.4): names of the
 * ids the page's entries carry, never of anything else; one lookup per
 * kind. The base route only names fields and tables of that base.
 */
export const auditRefsSchema = z
  .strictObject({
    users: z.record(z.string(), z.strictObject({ display_name: z.string().nullable() })).meta({
      description:
        'User actors and `entity_type = user` entities of the page, by `usr_…`; ' +
        '`display_name` is `null` for deleted or unknown users',
    }),
    fields: z
      .record(
        z.string(),
        z.strictObject({ name: z.string(), table_id: idOf('tbl'), deleted: z.boolean() }),
      )
      .meta({
        description:
          'Fields the page names (`before`/`after` keys of record entries, `entity_type = ' +
          'field` entities), by `fld_…`; `deleted` while in the trash. A field removed for ' +
          'good is absent.',
      }),
    tables: z.record(z.string(), z.strictObject({ name: z.string(), deleted: z.boolean() })).meta({
      description:
        '`table_id` and `entity_type = table` entities of the page, by `tbl_…`; `deleted` ' +
        'while in the trash, absent once removed for good',
    }),
    api_tokens: z.record(z.string(), z.strictObject({ name: z.string().nullable() })).meta({
      description:
        '`via.api_token_id` and `entity_type = api_token` entities of the page, by `tok_…`; ' +
        '`name` is `null` once the token is gone, and for tokens of other users unless the ' +
        'caller is an organization owner/admin',
    }),
  })
  .meta({ id: 'AuditRefs' });
export type AuditRefsDto = z.infer<typeof auditRefsSchema>;

export const auditLogListSchema = cursorListSchema(auditLogEntrySchema)
  .extend({
    retention_days: z.int().min(0).meta({
      description:
        'How long entries are kept (`AUDIT_RETENTION_DAYS`, instance-wide); `0` = forever',
    }),
    refs: auditRefsSchema.optional().meta({ description: 'Only with `include=refs`' }),
  })
  .meta({ id: 'AuditLogList' });
export type AuditLogList = z.infer<typeof auditLogListSchema>;

/** `POST /orgs/:orgId/audit-logs/export`. */
export const exportAuditLogsRequestSchema = z
  .strictObject({
    format: z.literal('csv'),
    filters: auditLogFiltersSchema.optional(),
  })
  .meta({ id: 'ExportAuditLogsRequest' });

/** `POST /bases/:baseId/audit-logs/export`: the base's entries only. */
export const exportBaseAuditLogsRequestSchema = z
  .strictObject({
    format: z.literal('csv'),
    filters: baseAuditLogFiltersSchema.optional(),
  })
  .meta({ id: 'ExportBaseAuditLogsRequest' });
export type ExportBaseAuditLogsRequest = z.infer<typeof exportBaseAuditLogsRequestSchema>;
export type ExportAuditLogsRequest = z.infer<typeof exportAuditLogsRequestSchema>;

/** Most entity ids one redaction may name. */
export const MAX_REDACT_ENTITY_IDS = MAX_RECORDS_PER_REQUEST;

/** `POST /orgs/:orgId/audit-logs/redact`: by entity, or every entry about/by a user. */
export const redactAuditLogsRequestSchema = z
  .union([
    z.strictObject({
      entity_type: entityTypeSchema,
      entity_ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_REDACT_ENTITY_IDS),
    }),
    z.strictObject({ user_id: idOf('usr') }),
  ])
  .meta({ id: 'RedactAuditLogsRequest' });
export type RedactAuditLogsRequest = z.infer<typeof redactAuditLogsRequestSchema>;

export const redactAuditLogsResponseSchema = z
  .strictObject({ redacted: z.int().min(0) })
  .meta({ id: 'RedactAuditLogsResult' });
export type RedactAuditLogsResponse = z.infer<typeof redactAuditLogsResponseSchema>;
