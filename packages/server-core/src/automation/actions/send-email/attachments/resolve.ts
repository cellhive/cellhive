import { AttachmentsRepository } from '../../../../records/attachments/attachments.repository.js';

import {
  planEmailAttachments,
  type AttachmentFieldSource,
  type AttachmentFileRow,
  type AttachmentPlan,
} from './plan.js';

import type { Db } from '../../../../db/create-db.js';
import type { OrgScope } from '../../../../db/repository.js';
import type { EmailAttachmentLimits } from '../../../../mail/settings/org-email-settings.js';
import type { AutomationValidationContext } from '../../../definition/validate.js';
import type { AutomationValueEvaluator } from '../../../values/evaluator.js';
import type { Id, SendEmailConfig } from '@cellhive/contracts';

/** The field type whose files a `send_email` step attaches. */
export const ATTACHMENT_FIELD_TYPE = 'attachment';

export interface ResolveEmailAttachmentsInput {
  readonly scope: OrgScope;
  readonly config: Pick<SendEmailConfig, 'attachments' | 'on_missing_attachment'>;
  /** Schema and access of the person the email is rendered as (`run_as`, or the editor). */
  readonly schema: AutomationValidationContext;
  /** Trigger table and record (`null` without record). */
  readonly tableId: Id<'tbl'> | null;
  readonly recordId: string | null;
  /** Reads the trigger record as that person (`triggerRecordCells`). */
  readonly values: Pick<AutomationValueEvaluator, 'triggerRecordCells'>;
  readonly limits: EmailAttachmentLimits;
  /** Largest encoded message (`messageByteLimit`). */
  readonly messageLimit: number;
  /** UTF-8 bytes of the HTML and text parts. */
  readonly bodyBytes: number;
  /** Inline images of the same email (BACKLOG T534): same byte budget. */
  readonly inlineBytes?: number;
}

/** Attachment ids of a JSON attachment cell (`[{ id, name, … }]`). */
function fileIdsOf(cell: unknown): string[] {
  if (!Array.isArray(cell)) return [];
  return cell.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const id = (item as { id?: unknown }).id;
    return typeof id === 'string' ? [id] : [];
  });
}

/**
 * The files of a `send_email` step (BACKLOG T532): for each attachment
 * field of the configuration, the person must read the record and the
 * field (still an attachment field of the trigger table) and download its
 * files (`file_download_fields`, SPEC §14.1) — else
 * `attachment_access_denied`, whatever `on_missing_attachment` says. The
 * cells are read through the single read path (`RecordQueryService`, read
 * rule and trash applied) and the files looked up in `meta.attachments` of
 * the organization; `planEmailAttachments` decides. No file is read here.
 */
export class EmailAttachmentResolver {
  private readonly attachments: AttachmentsRepository;

  constructor(db: Db) {
    this.attachments = new AttachmentsRepository(db);
  }

  async resolve(input: ResolveEmailAttachmentsInput): Promise<AttachmentPlan> {
    const { config, schema, tableId, recordId } = input;
    if (config.attachments.length === 0) {
      // No file, but the inline images (T534) still have the byte limits to respect.
      return planEmailAttachments({
        recordId: recordId ?? '',
        sources: [],
        rows: new Map(),
        onMissing: config.on_missing_attachment,
        limits: input.limits,
        ...(input.inlineBytes === undefined ? {} : { inlineBytes: input.inlineBytes }),
        bodyBytes: input.bodyBytes,
        messageLimit: input.messageLimit,
      });
    }
    const firstField = config.attachments[0]?.field ?? null;
    if (tableId === null || recordId === null) {
      return { ok: false, code: 'attachment_access_denied', params: { field_id: firstField } };
    }
    const table = schema.access.tables[tableId];
    const allowed = (fieldId: string): boolean => {
      const field = schema.fields.find((item) => item.id === fieldId);
      return (
        table !== undefined &&
        field !== undefined &&
        field.table_id === tableId &&
        field.type === ATTACHMENT_FIELD_TYPE &&
        table.fields[field.id] !== undefined &&
        table.file_download_fields.includes(field.id)
      );
    };
    const fieldIds = [...new Set(config.attachments.map((item) => item.field))];
    const denied = fieldIds.find((fieldId) => !allowed(fieldId));
    if (denied !== undefined) {
      return { ok: false, code: 'attachment_access_denied', params: { field_id: denied } };
    }
    const cells = await input.values.triggerRecordCells(fieldIds);
    if (cells === null) {
      return {
        ok: false,
        code: 'attachment_access_denied',
        params: { field_id: firstField, reason: 'record' },
      };
    }
    const sources: AttachmentFieldSource[] = fieldIds.map((fieldId) => ({
      fieldId,
      // Readable and downloadable (checked above); an empty cell may be absent.
      allowed: true,
      fileIds: fileIdsOf(cells[fieldId]),
    }));
    const rows = await this.attachments.getByIds(
      input.scope,
      sources.flatMap((source) => source.fileIds),
    );
    return planEmailAttachments({
      recordId,
      sources,
      rows: new Map(
        rows.map((row): [string, AttachmentFileRow] => [
          row.id,
          {
            id: row.id,
            field_id: row.field_id,
            record_id: row.record_id,
            object_key: row.object_key,
            filename: row.filename,
            mime: row.mime,
            size: Number(row.size),
            status: row.status,
            detached_at: row.detached_at,
            record_purged_at: row.record_purged_at,
          },
        ]),
      ),
      onMissing: config.on_missing_attachment,
      limits: input.limits,
      ...(input.inlineBytes === undefined ? {} : { inlineBytes: input.inlineBytes }),
      bodyBytes: input.bodyBytes,
      messageLimit: input.messageLimit,
    });
  }
}
