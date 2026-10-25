import {
  MAX_EMAIL_ATTACHMENT_FIELDS,
  type AutomationEmailPreview,
  type SendEmailConfig,
} from '@cellhive/contracts';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { Paperclip, Plus, X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { formatBytes } from '../../../../../lib/attachments/format';
import { canDownloadFile } from '../../../../../lib/permissions/access';
import { useBuilderEnv, useFields } from '../../components/env';
import { IssueText, Note, Segmented } from '../../components/panels/common';
import { CHIP_CLASS, CHIP_TONE_CLASS } from '../../components/values/chips';
import { issuesOf, type StepKey } from '../../model/issues';

import { attachmentBytes, type EmailLimits } from './model';

const TEST_ATTACHMENTS_NOTE = 'attachments-note';

export interface AttachmentsSectionProps {
  readonly step: StepKey;
  readonly config: SendEmailConfig;
  readonly onChange: (
    patch: Pick<Partial<SendEmailConfig>, 'attachments' | 'on_missing_attachment'>,
  ) => void;
  /** Table of the trigger record (`null`: the trigger has no record). */
  readonly tableId: string | null;
  readonly preview: AutomationEmailPreview | undefined;
  /** Title of the preview record, for the estimate. */
  readonly recordTitle: string | null;
  readonly limits: EmailLimits;
}

/**
 * Attachments (T532; board: "Đính kèm từ trường tệp của bản ghi kích
 * hoạt"): up to five attachment fields of the trigger record whose files
 * the editor may download (as `run_as` will need to), what a file that is
 * not ready does, and an estimate with the preview record against the
 * organization's limits. The files leave Cellhive: the note says so.
 */
export function AttachmentsSection({
  step,
  config,
  onChange,
  tableId,
  preview,
  recordTitle,
  limits,
}: AttachmentsSectionProps) {
  const { t, i18n } = useTranslation('automationEmail');
  const env = useBuilderEnv();
  const id = useId();
  const fields = useFields(tableId);
  const attachmentFields = fields.filter((field) => field.type === 'attachment');
  const chosen = config.attachments.map((item) => item.field);
  const issues = issuesOf(env.issues, step).filter(
    (issue) =>
      issue.path.startsWith('config.attachments') || issue.path === 'config.on_missing_attachment',
  );
  const full = chosen.length >= MAX_EMAIL_ATTACHMENT_FIELDS;
  const bytes = (value: number) => formatBytes(value, i18n.language);

  if (tableId === null) {
    return (
      <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
        <h3 id={`${id}-title`} className="text-label text-fg">
          {t('attachments.title')}
        </h3>
        <Note>{t('attachments.noRecord')}</Note>
      </section>
    );
  }
  const estimate =
    preview === undefined || config.attachments.length === 0
      ? null
      : {
          count: preview.attachments.length,
          bytes: attachmentBytes(preview),
        };
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h3 id={`${id}-title`} className="text-label text-fg">
        {t('attachments.title')}
      </h3>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="email-attachments">
        <ul className="contents" aria-label={t('attachments.list')}>
          {chosen.map((fieldId) => {
            const field = attachmentFields.find((item) => item.id === fieldId);
            const name = field?.name ?? t('attachments.missingField');
            return (
              <li key={fieldId} className="flex">
                <span
                  className={cn(
                    CHIP_CLASS,
                    field === undefined ? CHIP_TONE_CLASS.error : CHIP_TONE_CLASS.field,
                  )}
                >
                  <Paperclip aria-hidden="true" className="size-3 shrink-0" />
                  <span className="truncate">{name}</span>
                  <button
                    type="button"
                    className="-mr-0.5 ml-0.5 inline-flex size-4 items-center justify-center rounded-full hover:bg-surface/60"
                    aria-label={t('attachments.remove', { name })}
                    onClick={() => {
                      onChange({
                        attachments: config.attachments.filter((item) => item.field !== fieldId),
                      });
                    }}
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              className="border-dashed max-lg:h-control"
              disabled={full || attachmentFields.length === chosen.length}
              data-testid="attachments-add"
            >
              <Plus aria-hidden="true" />
              {t('attachments.add', {
                chosen: chosen.length,
                max: MAX_EMAIL_ATTACHMENT_FIELDS,
              })}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            {attachmentFields
              .filter((field) => !chosen.includes(field.id))
              .map((field) => {
                const allowed = canDownloadFile(env.base.access, tableId, field.id);
                return (
                  <DropdownMenuItem
                    key={field.id}
                    disabled={!allowed}
                    onSelect={() => {
                      onChange({ attachments: [...config.attachments, { field: field.id }] });
                    }}
                  >
                    <Paperclip aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{field.name}</span>
                      {allowed ? null : (
                        <span className="text-label font-normal text-fg-muted">
                          {t('attachments.notDownloadable')}
                        </span>
                      )}
                    </span>
                  </DropdownMenuItem>
                );
              })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {attachmentFields.length === 0 ? (
        <p className="text-label font-normal text-fg-muted">{t('attachments.none')}</p>
      ) : null}
      {config.attachments.length === 0 ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label font-normal text-fg-muted">
              {t('attachments.onMissing')}
            </span>
            <Segmented
              label={t('attachments.onMissing')}
              value={config.on_missing_attachment}
              options={[
                { value: 'fail', label: t('attachments.fail') },
                { value: 'skip', label: t('attachments.skip') },
              ]}
              onChange={(on_missing_attachment) => {
                onChange({ on_missing_attachment });
              }}
            />
          </div>
          <Note tone="warning" testId={TEST_ATTACHMENTS_NOTE}>
            {t('attachments.leaves')}{' '}
            {estimate === null || recordTitle === null
              ? null
              : limits.maxAttachmentBytes === null
                ? t('attachments.estimate', {
                    record: recordTitle,
                    count: estimate.count,
                    size: bytes(estimate.bytes),
                  })
                : t('attachments.estimateMax', {
                    record: recordTitle,
                    count: estimate.count,
                    size: bytes(estimate.bytes),
                    max: bytes(limits.maxAttachmentBytes),
                  })}{' '}
            {t('attachments.blocked')}
          </Note>
        </>
      )}
      <IssueText id={`${id}-issues`} issues={issues} />
    </section>
  );
}
