import {
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
  SHARE_FORM_MAX_FILES_PER_QUESTION,
  SHARE_FORM_MAX_UPLOAD_BYTES,
} from '@cellhive/contracts';
import { LINK_MAX_PER_CELL } from '@cellhive/field-types';
import { Filter, Link2, Paperclip } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { acceptLabels } from '../../../lib/attachments/checks';
import { formatBytes } from '../../../lib/attachments/format';

import type { FormQuestion } from '../model/questions';

export interface QuestionSettingsProps {
  readonly question: FormQuestion;
  /** Name of the table a link field points to (`null` when the user cannot read it). */
  readonly linkTableName?: string | null | undefined;
}

/** Whether a link field's `record_filter` has any condition. */
export function hasRecordFilter(options: Readonly<Record<string, unknown>>): boolean {
  const filter = options['record_filter'];
  if (typeof filter !== 'object' || filter === null) return false;
  const items = (filter as { items?: unknown }).items;
  return !Array.isArray(items) || items.length > 0;
}

/**
 * What a link or file question takes (T419), under its card in the builder:
 * the field's own settings (a question has no settings of its own: they are
 * edited with the field, so the form and the grid always agree) and the
 * limits of form links (CONTRACTS §17: at most 10 files per question and
 * 100 MB per submission; link questions hidden from people outside the
 * organization).
 */
export function QuestionSettings({ question, linkTableName }: QuestionSettingsProps) {
  const { t, i18n } = useTranslation('form');
  const id = useId();
  const config = question.config;
  if (config === null || (config.type !== 'attachment' && config.type !== 'link')) return null;
  const rows: { key: string; label: string; value: string }[] = [];
  if (config.type === 'attachment') {
    const options = config.options;
    const types =
      options.accept === null || options.accept.length === 0
        ? t('builder.settings.anyType')
        : acceptLabels(options.accept)
            .map((label) =>
              'name' in label
                ? label.name
                : t(`fill.files.families.${label.family}`, { defaultValue: `${label.family}/*` }),
            )
            .join(', ');
    rows.push(
      { key: 'types', label: t('builder.settings.types'), value: types },
      {
        key: 'files',
        label: t('builder.settings.maxFiles'),
        value: t('builder.settings.maxFilesValue', {
          count: options.max_files,
          link: Math.min(options.max_files, SHARE_FORM_MAX_FILES_PER_QUESTION),
        }),
      },
      {
        key: 'size',
        label: t('builder.settings.size'),
        value: t('builder.settings.sizeValue', {
          file: formatBytes(DEFAULT_ATTACHMENT_MAX_FILE_BYTES, i18n.language),
          total: formatBytes(SHARE_FORM_MAX_UPLOAD_BYTES, i18n.language),
        }),
      },
    );
  } else {
    const options = question.field.options as Readonly<Record<string, unknown>>;
    rows.push(
      {
        key: 'table',
        label: t('builder.settings.linkTable'),
        value: linkTableName ?? t('builder.settings.linkTableUnknown'),
      },
      {
        key: 'multiple',
        label: t('builder.settings.linkCount'),
        value: config.options.allow_multiple
          ? t('builder.settings.linkMany', { count: LINK_MAX_PER_CELL })
          : t('builder.settings.linkOne'),
      },
    );
    if (hasRecordFilter(options)) {
      rows.push({
        key: 'filter',
        label: t('builder.settings.linkFilter'),
        value: t('builder.settings.linkFilterValue'),
      });
    }
  }
  const Icon = config.type === 'attachment' ? Paperclip : Link2;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-2 rounded-md bg-surface-sunken px-3 py-2"
      data-testid="form-question-settings"
    >
      <h4 id={`${id}-title`} className="flex items-center gap-1.5 text-label font-medium text-fg">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        {t('builder.settings.title')}
      </h4>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-label font-normal sm:grid-cols-[max-content_1fr]">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="text-fg-muted">
              {row.key === 'filter' ? (
                <span className="inline-flex items-center gap-1">
                  <Filter aria-hidden="true" className="size-3" />
                  {row.label}
                </span>
              ) : (
                row.label
              )}
            </dt>
            <dd className="text-fg max-sm:mb-1">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-label font-normal text-fg-muted">
        {t('builder.settings.fromField', { name: question.field.name })}
      </p>
    </section>
  );
}
