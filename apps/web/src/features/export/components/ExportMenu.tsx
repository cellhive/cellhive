import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Tooltip,
} from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, FileText, Info } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '../../../lib/i18n/format';
import { canDownload } from '../../../lib/permissions/access';
import { baseQuery } from '../../../lib/query/queries';
import { dismissToast, showErrorToast, showToast } from '../../../lib/toast/toast';
import { useViewConfig } from '../../../lib/views/use-view-config';
import { exportUrl, startFileDownload } from '../download';

import type { ApiError } from '../../../lib/api/client';
import type { TableExportFormat, ViewDto } from '@cellhive/contracts';

/** After a click the menu waits this long before another export (one export per user, CONTRACTS §18). */
export const EXPORT_COOLDOWN_MS = 3000;

const FORMATS: readonly { format: TableExportFormat; icon: typeof FileText }[] = [
  { format: 'csv', icon: FileText },
  { format: 'xlsx', icon: FileSpreadsheet },
];

export interface ExportMenuProps {
  readonly baseId: string;
  /** The open view: its saved filter, sort, hidden fields and column order shape the file. */
  readonly view: ViewDto;
  /** Replaces the hidden-frame download (tests). */
  readonly startDownload?: typeof startFileDownload;
}

/**
 * "Export" of the view bar (T318, CONTRACTS §18): the rows and columns of
 * the **saved** view as CSV or XLSX. Temporary changes (unsaved filter,
 * sort, hidden columns) are not part of the file — the server exports only
 * saved views — and the menu says so. Without `base_rule.download` the
 * button stays visible but disabled, with the reason (FRONTEND §7). Form
 * views have no export.
 */
export function ExportMenu({ baseId, view, startDownload = startFileDownload }: ExportMenuProps) {
  const { t } = useTranslation('export');
  const reasonId = useId();
  const { data: base } = useQuery(baseQuery(baseId));
  const { unsaved } = useViewConfig(view, false);
  const format = useFormatters();
  // Values are written as text in the account's language and time zone (CONTRACTS §18).
  const localeNote = t('localeNote', { locale: format.locale, timeZone: format.timeZone });
  const [busy, setBusy] = useState(false);
  const cooldown = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(cooldown.current);
    },
    [],
  );

  if (view.type === 'form') return null;
  const allowed = canDownload(base?.access);

  if (!allowed) {
    // Focusable, so that keyboard and screen reader users reach the reason.
    return (
      <>
        <Tooltip content={t('denied')}>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            aria-disabled="true"
            aria-describedby={reasonId}
            onClick={() => {
              showToast({ message: t('denied') });
            }}
          >
            <Download aria-hidden="true" />
            {t('button')}
          </Button>
        </Tooltip>
        <span id={reasonId} className="sr-only">
          {t('denied')}
        </span>
      </>
    );
  }

  const start = (format: TableExportFormat) => {
    setBusy(true);
    clearTimeout(cooldown.current);
    cooldown.current = setTimeout(() => {
      setBusy(false);
    }, EXPORT_COOLDOWN_MS);
    const started = showToast({
      message: t('started', { name: view.name, format: t(`formats.${format}`) }),
    });
    const onError = (error: ApiError) => {
      dismissToast(started);
      if (error.code === 'RATE_LIMITED') {
        showToast({ variant: 'error', message: t('busy') });
      } else {
        showErrorToast(error, { title: t('failed') });
      }
    };
    startDownload(exportUrl(view.table_id, view.id, format), {
      title: t('frame'),
      onError,
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="shrink-0" disabled={busy}>
          <Download aria-hidden="true" />
          {t('button')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('menu', { name: view.name })}</DropdownMenuLabel>
        {FORMATS.map(({ format: fileFormat, icon: Icon }) => (
          <DropdownMenuItem
            key={fileFormat}
            title={localeNote}
            onSelect={() => {
              start(fileFormat);
            }}
          >
            <Icon aria-hidden="true" />
            {t(`formats.${fileFormat}`)}
          </DropdownMenuItem>
        ))}
        <p
          className="flex max-w-72 items-start gap-1.5 px-2 pt-1.5 text-label font-normal text-fg-muted"
          title={localeNote}
          data-testid="export-locale-note"
        >
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {localeNote}
        </p>
        <p
          className="max-w-72 px-2 pt-1.5 text-label font-normal text-fg-muted"
          data-testid="export-relations-note"
        >
          {t('relationsNote')}
        </p>
        <p className="max-w-72 px-2 py-1.5 text-label font-normal text-fg-muted">
          {unsaved.length > 0 ? t('unsavedNote') : t('savedNote')}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ExportMenu;
