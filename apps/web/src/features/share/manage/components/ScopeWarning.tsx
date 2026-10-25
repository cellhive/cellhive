import { Checkbox, Skeleton } from '@cellhive/ui';
import { Download, Eye, FileDown } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';

import type { LinkFileFields } from '../draft';
import type { ShareLinkPreview } from '@cellhive/contracts';

export interface ScopeWarningProps {
  readonly preview: ShareLinkPreview | undefined;
  readonly error: unknown;
  /**
   * Fields the user reads that the link does not show (hidden in the view,
   * or beyond the link's access), listed struck through; view links only.
   */
  readonly hiddenFields?: readonly { readonly id: string; readonly name: string }[] | undefined;
  /**
   * Attachment fields of a view link and whether downloads are on (T419):
   * the files people with the link could download are listed here, so the
   * acknowledgement covers them.
   */
  readonly files?: (LinkFileFields & { readonly allowDownload: boolean }) | undefined;
  /**
   * (T814) A view link that lets people download the whole view as CSV/XLSX
   * (`allow_export`): said with the number of records, so the
   * acknowledgement covers it.
   */
  readonly allowExport?: boolean | undefined;
  /**
   * Who the link is for: a `public` form link hides its `link` and `user`
   * questions (CONTRACTS §17), so they are not listed (T421a).
   */
  readonly audience?: 'org' | 'public' | undefined;
  readonly acknowledged: boolean;
  readonly onAcknowledge: (value: boolean) => void;
}

/** Question types a public form link never asks (CONTRACTS §17, T321/T410). */
const HIDDEN_ON_PUBLIC_FORMS: ReadonlySet<string> = new Set(['link', 'user']);

/**
 * The mandatory warning of SPEC §15A.1, as an amber box (design "Link chia
 * sẻ"): how many records and which fields people with the link will see
 * (or fill in, for a form), which of the fields the user sees they will
 * not ("Not visible:"), from `GET /views/:id/share-links/preview` (the
 * caller's current rights). It must be acknowledged before a link is
 * created or turned on.
 */
export function ScopeWarning({
  preview,
  error,
  hiddenFields = [],
  files,
  allowExport = false,
  audience,
  acknowledged,
  onAcknowledge,
}: ScopeWarningProps) {
  const { t } = useTranslation('share');
  const format = useFormatters();
  const titleId = useId();
  if (error !== null && error !== undefined) return <ErrorAlert error={error} />;
  if (preview === undefined) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('scope.loading')}</span>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-12" />
      </div>
    );
  }
  const isForm = preview.target_type === 'form' || preview.record_count === null;
  const fields =
    isForm && audience === 'public'
      ? preview.fields.filter((field) => !HIDDEN_ON_PUBLIC_FORMS.has(field.type))
      : preview.fields;
  const count = fields.length;
  // Link fields show titles of records of another table (T421a).
  const linkFields = fields.filter((field) => field.type === 'link').map((field) => field.name);
  let summary: string;
  let records = '';
  if (isForm) {
    summary = t('scope.form', { count });
  } else {
    records = t(preview.record_count_estimated ? 'scope.recordsEstimated' : 'scope.records', {
      count: preview.record_count ?? 0,
      formattedCount: format.number(preview.record_count ?? 0),
    });
    summary = t('scope.view', { count, records });
  }
  const shown = new Set<string>(fields.map((field) => field.id));
  const hidden = isForm ? [] : hiddenFields.filter((field) => !shown.has(field.id));
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-option-3 px-4 py-3 leading-snug text-fg"
      data-testid="share-scope-warning"
    >
      <h3 id={titleId} className="flex items-center gap-2 text-body font-semibold">
        <Eye aria-hidden="true" className="size-4 shrink-0 text-on-option-3" />
        {summary}
      </h3>
      {count === 0 ? (
        <p className="text-body">{t('scope.noFields')}</p>
      ) : (
        <ul
          aria-label={t('scope.title')}
          className="flex max-h-32 flex-wrap gap-2 overflow-y-auto"
          data-testid="share-scope-fields"
        >
          {fields.map((field) => (
            <li
              key={field.id}
              className="rounded-sm border border-line bg-surface px-2 py-0.5 text-label font-normal text-fg"
            >
              {field.name}
            </li>
          ))}
        </ul>
      )}
      {hidden.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2 text-label font-normal">
          <span className="text-on-option-3" id={`${titleId}-hidden`}>
            {t('scope.hidden')}
          </span>
          <ul
            aria-labelledby={`${titleId}-hidden`}
            className="flex flex-wrap gap-2"
            data-testid="share-scope-hidden"
          >
            {hidden.map((field) => (
              <li
                key={field.id}
                className="rounded-sm bg-surface-sunken px-2 py-0.5 text-fg-muted line-through"
              >
                {field.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {linkFields.length === 0 ? null : (
        <p className="text-label font-normal text-fg" data-testid="share-scope-links">
          {t('scope.linkTitles', { fields: linkFields.join(', ') })}
        </p>
      )}
      {isForm || files === undefined ? null : <FileScope files={files} />}
      {isForm || !allowExport ? null : (
        <p
          className="flex items-start gap-1 text-label font-medium text-fg"
          data-testid="share-scope-export"
        >
          <FileDown aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t('scope.exportRows', { records })}
        </p>
      )}
      <p className="text-label font-normal text-on-option-3">
        {t(isForm ? 'scope.noteForm' : 'scope.note')}
      </p>
      <Checkbox
        label={t(isForm ? 'scope.acknowledgeForm' : 'scope.acknowledge')}
        checked={acknowledged}
        onChange={(event) => {
          onAcknowledge(event.target.checked);
        }}
      />
    </section>
  );
}

/**
 * (T814) The warning of a dashboard link (SPEC §15A.2): its numbers are
 * computed with the creator's current permissions on every data widget of
 * the dashboard (no preview route: the widgets on screen are counted), and
 * with `allow_export` each widget's numbers can be downloaded as CSV. It
 * must be acknowledged before the link is created or turned on.
 */
export function DashboardScopeWarning({
  widgets,
  allowExport,
  acknowledged,
  onAcknowledge,
}: {
  /** Widgets showing numbers (not text or filter controls). */
  readonly widgets: number;
  readonly allowExport: boolean;
  readonly acknowledged: boolean;
  readonly onAcknowledge: (value: boolean) => void;
}) {
  const { t } = useTranslation('share');
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-option-3 px-4 py-3 leading-snug text-fg"
      data-testid="share-scope-warning"
    >
      <h3 id={titleId} className="flex items-center gap-2 text-body font-semibold">
        <Eye aria-hidden="true" className="size-4 shrink-0 text-on-option-3" />
        {t('scope.dashboard', { count: widgets })}
      </h3>
      {allowExport ? (
        <p
          className="flex items-start gap-1 text-label font-medium text-fg"
          data-testid="share-scope-export"
        >
          <FileDown aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t('scope.exportWidgets')}
        </p>
      ) : null}
      <p className="text-label font-normal text-on-option-3">{t('scope.noteDashboard')}</p>
      <Checkbox
        label={t('scope.acknowledge')}
        checked={acknowledged}
        onChange={(event) => {
          onAcknowledge(event.target.checked);
        }}
      />
    </section>
  );
}

/**
 * What happens to files through the link (T419, CONTRACTS §16A): with
 * `allow_download`, the attachment fields whose original files people with
 * the link can download (the creator's `file_download_fields`) and those
 * that stay thumbnails only; without it, thumbnails only.
 */
function FileScope({ files }: { files: LinkFileFields & { readonly allowDownload: boolean } }) {
  const { t } = useTranslation('share');
  const id = useId();
  const count = files.downloadable.length + files.viewOnly.length;
  if (count === 0) {
    return files.allowDownload ? (
      <p className="text-label font-normal text-fg" data-testid="share-scope-downloads">
        {t('scope.files.none')}
      </p>
    ) : null;
  }
  if (!files.allowDownload) {
    return (
      <p className="text-label font-normal text-fg" data-testid="share-scope-downloads">
        {t('scope.files.thumbnailsOnly', { count })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-label font-normal" data-testid="share-scope-downloads">
      {files.downloadable.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <span id={`${id}-down`} className="flex items-center gap-1 font-medium text-fg">
            <Download aria-hidden="true" className="size-3.5 shrink-0" />
            {t('scope.files.downloadable')}
          </span>
          <ul aria-labelledby={`${id}-down`} className="flex flex-wrap gap-2">
            {files.downloadable.map((name) => (
              <li
                key={name}
                className="rounded-sm border border-warning/60 bg-surface px-2 py-0.5 font-medium text-fg"
              >
                {name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {files.viewOnly.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <span id={`${id}-view`} className="text-on-option-3">
            {t('scope.files.viewOnly')}
          </span>
          <ul aria-labelledby={`${id}-view`} className="flex flex-wrap gap-2">
            {files.viewOnly.map((name) => (
              <li key={name} className="rounded-sm bg-surface-sunken px-2 py-0.5 text-fg-muted">
                {name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
