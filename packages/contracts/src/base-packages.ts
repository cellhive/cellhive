import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';

/**
 * Whole-base export and import (`.chbase`, ADR-24 and its 2026-11
 * amendment, CONTRACTS §12.2): constants of the format and its limits,
 * the result of the `base.export` and `base.import` jobs, the import
 * report, the detail codes of `INVALID_PACKAGE` and the progress bands
 * of each job. The package itself is read and written by
 * `@cellhive/server-core` (`base-package`).
 */

/** File name extension of a package (ADR-37 amendment); no other extension is accepted. */
export const BASE_PACKAGE_EXTENSION = '.chbase';
/** `manifest.json` `format`. */
export const BASE_PACKAGE_FORMAT = 'cellhive-base';
/** `manifest.json` `format_version` written by this version; only the same major is read. */
export const BASE_PACKAGE_FORMAT_VERSION = 1;
/** Media type of a package download. */
export const BASE_PACKAGE_MEDIA_TYPE = 'application/zip';
/** Part of the `multipart/form-data` import request holding the package. */
export const BASE_PACKAGE_UPLOAD_FIELD = 'file';

/** Default of `BASE_PACKAGE_MAX_BYTES` (SPEC §20): 2 GiB, below the 5 GB of one S3 PUT. */
export const BASE_PACKAGE_DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Largest `BASE_PACKAGE_MAX_BYTES`: 5 GiB less one byte, the largest single S3 PUT. */
export const BASE_PACKAGE_MAX_BYTES_LIMIT = 5 * 1024 * 1024 * 1024 - 1;
/** Smallest `BASE_PACKAGE_MAX_BYTES`: 1 MiB. */
export const BASE_PACKAGE_MIN_BYTES_LIMIT = 1024 * 1024;
/** Most entries of a package (ADR-24 §3). */
export const BASE_PACKAGE_MAX_ENTRIES = 100_000;
/** Total uncompressed bytes ≤ this × the package size … */
export const BASE_PACKAGE_MAX_COMPRESSION_RATIO = 20;
/** … and ≤ this × `BASE_PACKAGE_MAX_BYTES`. */
export const BASE_PACKAGE_MAX_UNCOMPRESSED_FACTOR = 4;
/** Largest JSON entry (`manifest.json`, `schema/*.json`, `files/attachments.json`), uncompressed. */
export const BASE_PACKAGE_MAX_JSON_ENTRY_BYTES = 64 * 1024 * 1024;
/** Longest line of an NDJSON entry (`data/*`, `links/*`), in bytes. */
export const BASE_PACKAGE_MAX_NDJSON_LINE_BYTES = 16 * 1024 * 1024;
/** Deepest nesting of arrays and objects in any JSON value of a package. */
export const BASE_PACKAGE_MAX_JSON_DEPTH = 64;
/** A finished export can be downloaded for this long (`result.expires_at`). */
export const BASE_PACKAGE_DOWNLOAD_TTL_SECONDS = 3600;
/** Longest list of the import report (emails, secrets, AI fields, skipped files…). */
export const BASE_IMPORT_REPORT_MAX_ITEMS = 1000;

/** `meta.jobs.type` of the two jobs. */
export const BASE_EXPORT_JOB_TYPE = 'base.export';
export const BASE_IMPORT_JOB_TYPE = 'base.import';

/**
 * Scopes an API token needs for `POST /bases/{baseId}/export` besides the
 * route's `records:read` (CONTRACTS §26.3, "scope per request"): a package
 * holds the schema and the automations too. A token lacking some gets `403
 * INSUFFICIENT_SCOPE` listing them.
 */
export const BASE_EXPORT_REQUEST_SCOPES = ['schema:read', 'automations:read'] as const;

/**
 * Which cap `ARCHIVE_LIMIT_EXCEEDED` names (`params.reason`, with
 * `params.limit`): the package size, its number of entries, its total
 * uncompressed size (or an entry inflating past its declared size), one
 * JSON entry, one NDJSON line, or the nesting of a JSON value.
 */
export const BASE_PACKAGE_LIMIT_REASONS = [
  'package_bytes',
  'entries',
  'uncompressed_bytes',
  'json_entry_bytes',
  'ndjson_line_bytes',
  'json_depth',
] as const;
export type BasePackageLimitReason = (typeof BASE_PACKAGE_LIMIT_REASONS)[number];

// --- Detail codes of `422 INVALID_PACKAGE` (CONTRACTS §6, §12.2) --------------------------

/** Not a readable zip: corrupt central directory, truncated file, bad CRC, inflate error. */
export const INVALID_ARCHIVE = 'INVALID_ARCHIVE';
/** A cap of §12.2 (`params.reason`, `params.limit`). Also an XLSX import code (§19). */
export const PACKAGE_ARCHIVE_LIMIT_EXCEEDED = 'ARCHIVE_LIMIT_EXCEEDED';
/**
 * An entry that is never read: a name with `..`, an absolute or drive path,
 * a backslash, a control character; a directory, symlink or other non-file;
 * an encrypted entry; a compression method other than stored/deflate.
 */
export const UNSAFE_ENTRY = 'UNSAFE_ENTRY';
/** A name outside the entry allowlist, or an entry the manifest does not list. */
export const UNKNOWN_ENTRY = 'UNKNOWN_ENTRY';
/** Two entries with the same name once normalized (Unicode NFC). */
export const DUPLICATE_ENTRY = 'DUPLICATE_ENTRY';
/** `manifest.json`, or an entry the manifest or the schema needs, is missing. */
export const MISSING_ENTRY = 'MISSING_ENTRY';
/** An entry that is not the JSON/NDJSON it should be, or does not match its schema. */
export const INVALID_ENTRY = 'INVALID_ENTRY';
/** An entry whose SHA-256 differs from `manifest.checksums`. */
export const CHECKSUM_MISMATCH = 'CHECKSUM_MISMATCH';
/** `format` is not `cellhive-base`, or `format_version` is not one this version reads. */
export const UNSUPPORTED_FORMAT_VERSION = 'UNSUPPORTED_FORMAT_VERSION';
/** An id the package does not define (`params.id`). */
export const DANGLING_REFERENCE = 'DANGLING_REFERENCE';
/** A formula, filter, view, widget, automation or role the target cannot accept. */
export const INVALID_DEFINITION = 'INVALID_DEFINITION';
/** Two objects of the package with one id (`params.id`). */
export const PACKAGE_DUPLICATE_ID = 'DUPLICATE_ID';
/** Export (`VALIDATION_FAILED`) or upload (`413 PAYLOAD_TOO_LARGE`) over `BASE_PACKAGE_MAX_BYTES`. */
export const PACKAGE_TOO_LARGE = 'PACKAGE_TOO_LARGE';

// --- Detached references of automations ---------------------------------------------

/**
 * What an exported automation no longer names (ADR-24 amendment): secrets
 * (`send_telegram`, `http_request` auth/signing, `run_n8n_workflow`),
 * sending identities (`send_email.identity_id`, `reply_to.identity_id`),
 * groups (`send_notification` recipients) and incoming webhooks
 * (`webhook.received`). Each slot holds `null` in the package, listed in
 * `detached` with its path and the name it had.
 */
export const BASE_PACKAGE_DETACHED_KINDS = [
  'secret',
  'email_identity',
  'group',
  'incoming_webhook',
] as const;
export type BasePackageDetachedKind = (typeof BASE_PACKAGE_DETACHED_KINDS)[number];

// --- Job results ----------------------------------------------------------------------

const count = z.int().min(0);

export const basePackageCountsSchema = z
  .strictObject({
    tables: count,
    fields: count,
    records: count,
    links: count,
    attachments: count,
    views: count,
    dashboards: count,
    widgets: count,
    automations: count,
    roles: count,
  })
  .meta({
    id: 'BasePackageCounts',
    description:
      'What a package holds: shared views only, custom roles only, attachments of cells, form ' +
      'covers and email images; `links` = rows of the junctions',
  });
export type BasePackageCounts = z.infer<typeof basePackageCountsSchema>;

export const baseExportRequestSchema = z.strictObject({}).meta({
  id: 'BaseExportRequest',
  description: 'No options in format version 1: send no body or `{}`',
});
export type BaseExportRequest = z.infer<typeof baseExportRequestSchema>;

export const baseExportResultSchema = z
  .strictObject({
    download_url: z
      .string()
      .optional()
      .meta({
        description:
          '`/api/v1/files/exports/{jobId}`: `302` to the package (`<base name>.chbase`); left out ' +
          'once the file is deleted',
      }),
    expires_at: isoDateTimeSchema.optional().meta({
      description: 'One hour after the job finished; the package is deleted then',
    }),
    file_deleted: z.literal(true).optional().meta({
      description: 'The package was deleted (expired); export again',
    }),
    size: count.meta({ description: 'Bytes of the package' }),
    counts: basePackageCountsSchema,
    skipped_personal_views: count.meta({
      description: 'Personal views of the base, never exported',
    }),
  })
  .meta({ id: 'BaseExportResult', description: '`result` of a succeeded `base.export` job' });
export type BaseExportResult = z.infer<typeof baseExportResultSchema>;

const automationRefSchema = z.strictObject({ id: idOf('aut'), name: z.string() });

export const baseImportDetachedItemSchema = z
  .strictObject({
    kind: z.enum(BASE_PACKAGE_DETACHED_KINDS),
    name: z.string().meta({ description: 'Name it had in the source organization' }),
    automations: z.array(automationRefSchema).max(BASE_IMPORT_REPORT_MAX_ITEMS),
  })
  .meta({
    id: 'BaseImportDetachedItem',
    description: 'A secret, sending identity, group or incoming webhook to set up again',
  });
export type BaseImportDetachedItem = z.infer<typeof baseImportDetachedItemSchema>;

export const BASE_IMPORT_SKIPPED_FILE_REASONS = [
  'blocked_file_type',
  'file_too_large',
  'content_mismatch',
] as const;
export type BaseImportSkippedFileReason = (typeof BASE_IMPORT_SKIPPED_FILE_REASONS)[number];

const list = <T extends z.ZodType>(item: T) => z.array(item).max(BASE_IMPORT_REPORT_MAX_ITEMS);

export const baseImportReportSchema = z
  .strictObject({
    ...basePackageCountsSchema.shape,
    unmatched_user_emails: list(z.string()).meta({
      description:
        'Emails of the package with no member in the target organization (sorted, at most ' +
        `${String(BASE_IMPORT_REPORT_MAX_ITEMS)}; never an email the package does not hold)`,
    }),
    unmatched_users: count.meta({ description: 'How many emails did not match, in all' }),
    automations_disabled: count.meta({ description: 'Imported automations: all are off' }),
    secrets_to_reconnect: list(baseImportDetachedItemSchema).meta({
      description: 'Secrets, sending identities and groups the automations named, by name',
    }),
    webhooks_to_recreate: list(baseImportDetachedItemSchema).meta({
      description: 'Incoming webhooks the `webhook.received` triggers named',
    }),
    ai_fields: list(
      z.strictObject({ table_id: idOf('tbl'), field_id: idOf('fld'), name: z.string() }),
    ).meta({
      description:
        'AI fields of the new base: their values were imported, nothing is generated until ' +
        'AI is available in the organization and a row changes or is generated again',
    }),
    skipped_personal_views: count,
    files_skipped: list(
      z.strictObject({
        filename: z.string(),
        reason: z.enum(BASE_IMPORT_SKIPPED_FILE_REASONS),
      }),
    ).meta({
      description:
        'Files of the package not imported (the cell keeps its other files): a type the default ' +
        'block list refuses, over `ATTACHMENT_MAX_FILE_BYTES`, or a content that is not its type',
    }),
  })
  .meta({ id: 'BaseImportReport', description: 'What an import created and what it left out' });
export type BaseImportReport = z.infer<typeof baseImportReportSchema>;

export const baseImportResultSchema = z
  .strictObject({ base_id: idOf('bse'), report: baseImportReportSchema })
  .meta({ id: 'BaseImportResult', description: '`result` of a succeeded `base.import` job' });
export type BaseImportResult = z.infer<typeof baseImportResultSchema>;

// --- Progress (`job.progress`, CONTRACTS §7) -------------------------------------------

/** Phases of an export, in order, with the progress each one ends at. */
export const BASE_EXPORT_PHASES = [
  ['schema', 0.05],
  ['records', 0.8],
  ['links', 0.85],
  ['files', 0.97],
  ['upload', 1],
] as const;
export type BaseExportPhase = (typeof BASE_EXPORT_PHASES)[number][0];

/** Phases of an import, in order, with the progress each one ends at. */
export const BASE_IMPORT_PHASES = [
  ['check', 0.1],
  ['schema', 0.15],
  ['files', 0.4],
  ['records', 0.8],
  ['links', 0.85],
  ['computed', 0.95],
  ['finish', 1],
] as const;
export type BaseImportPhase = (typeof BASE_IMPORT_PHASES)[number][0];

type PhaseTable = readonly (readonly [string, number])[];

function phaseIn<T extends PhaseTable>(table: T, progress: number): T[number][0] {
  let phase: T[number][0] = '';
  for (const [name, end] of table) {
    phase = name;
    if (progress < end) break;
  }
  return phase;
}

/** The phase a `base.export` job is in at `progress` (0…1). */
export function baseExportPhaseOf(progress: number): BaseExportPhase {
  return phaseIn(BASE_EXPORT_PHASES, progress);
}

/** The phase a `base.import` job is in at `progress` (0…1). */
export function baseImportPhaseOf(progress: number): BaseImportPhase {
  return phaseIn(BASE_IMPORT_PHASES, progress);
}

/**
 * Progress of `done` out of `total` units inside `phase` (between the end
 * of the phase before and its own end), for the job to report.
 */
export function basePackageProgress(
  phases: PhaseTable,
  phase: string,
  done: number,
  total: number,
): number {
  const index = phases.findIndex(([name]) => name === phase);
  if (index === -1) return 0;
  const start = index === 0 ? 0 : (phases[index - 1]?.[1] ?? 0);
  const end = phases[index]?.[1] ?? start;
  const share = total <= 0 ? 1 : Math.min(1, Math.max(0, done / total));
  return start + (end - start) * share;
}
