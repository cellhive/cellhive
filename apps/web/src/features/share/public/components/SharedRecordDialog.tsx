import { cn, Dialog, Spinner } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { cellClipboardText } from '../../../../grid';
import { CellValue } from '../../../../grid/display/CellValue';
import { isApiError } from '../../../../lib/api/client';
import { keys } from '../../../../lib/query/keys';

import type { GridField } from '../../../../grid';
import type { SharePageParts } from '../../../../lib/share/public-page';
import type { ShareApi } from '../api';
import type { LocaleContext } from '@cellhive/field-types';

export interface SharedRecordDialogProps {
  readonly api: ShareApi;
  /** The record shown; `null` = closed. */
  readonly recordId: string | null;
  readonly onClose: () => void;
  /** Fields of the link in display order (the primary field first). */
  readonly columns: readonly GridField[];
  readonly locale: LocaleContext;
  /** `allow_copy = false`: text of the values cannot be selected. */
  readonly allowCopy: boolean;
  /** `download_fields` of the link: their files can be downloaded from the viewer (T409). */
  readonly downloadFields?: readonly string[];
  /** Files of attachment fields with the viewer (from the route, T409); names only without. */
  readonly Files?: SharePageParts['Files'] | undefined;
}

/**
 * Read-only record detail of a shared view (`show_record_detail`,
 * `GET /shares/:token/records/:id`, CONTRACTS §16A): every field of the
 * link, no history, no editing. A record that left the view is `404`.
 * Files show as thumbnails that open the viewer (downloads only with
 * `allow_download`, T409); linked records the link cannot read are locked.
 */
export function SharedRecordDialog({
  api,
  recordId,
  onClose,
  columns,
  locale,
  allowCopy,
  downloadFields = [],
  Files,
}: SharedRecordDialogProps) {
  const { t } = useTranslation('sharePage');
  const record = useQuery({
    queryKey: keys.shareRecord(api.token, recordId ?? ''),
    queryFn: ({ signal }) => api.record(recordId ?? '', signal),
    enabled: recordId !== null,
    retry: false,
  });
  const primary = columns[0];
  const title =
    record.data === undefined || primary === undefined ? (
      t('record.title')
    ) : (
      <CellValue
        field={primary}
        value={record.data.fields[primary.field.id]}
        locale={locale}
        empty={t('cards.untitled')}
      />
    );
  let body;
  if (record.isPending) {
    body = (
      <p role="status" className="flex items-center gap-2 text-fg-muted">
        <Spinner />
        {t('record.loading')}
      </p>
    );
  } else if (record.isError) {
    body = (
      <p role="alert" className="text-fg-muted">
        {isApiError(record.error) && record.error.status === 404
          ? t('record.gone')
          : t('record.failed')}
      </p>
    );
  } else {
    body = (
      <dl
        className={cn(
          'flex max-h-[60dvh] flex-col gap-3 overflow-y-auto',
          !allowCopy && 'select-none',
        )}
        data-testid="share-record-fields"
      >
        {columns.map((field) => (
          <div key={field.field.id} className="flex flex-col gap-0.5">
            <dt className="text-label text-fg-muted">{field.field.name}</dt>
            <dd className="min-h-5 break-words">
              {Files !== undefined &&
              field.config?.type === 'attachment' &&
              Array.isArray(record.data.fields[field.field.id]) ? (
                <Suspense fallback={null}>
                  <Files
                    value={record.data.fields[field.field.id]}
                    fieldName={field.field.name}
                    recordTitle={
                      primary === undefined
                        ? ''
                        : cellClipboardText(primary, record.data.fields[primary.field.id], locale)
                    }
                    canDownload={downloadFields.includes(field.field.id)}
                  />
                </Suspense>
              ) : (
                <CellValue
                  field={field}
                  value={record.data.fields[field.field.id]}
                  locale={locale}
                  empty="—"
                />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <Dialog
      open={recordId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      closeLabel={t('record.close')}
      className="max-w-lg"
    >
      {body}
    </Dialog>
  );
}
