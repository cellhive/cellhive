import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { startFileDownload } from '../../../../lib/files/download';
import { useFormatters } from '../../../../lib/i18n/format';
import { showToast } from '../../../../lib/toast/toast';

import type { ShareApi } from '../api';

/**
 * (T814) "Download" of a shared view whose link allows exports
 * (`allow_export`, T810, CONTRACTS §16A **Export**): the whole saved view
 * as CSV or XLSX — the view's filter and columns, not the viewer's own
 * filter, sort or search — with values in the viewer's language and time
 * zone. The file streams through the hidden download frame
 * (`lib/files/download.ts`); a refusal (`403` once the creator lost the
 * right, `429` while another export of the link runs, too many rows)
 * becomes a toast.
 */
export function ShareExportMenu({ api }: { readonly api: ShareApi }) {
  const { t } = useTranslation('sharePage');
  const format = useFormatters();
  const download = (kind: 'csv' | 'xlsx') => {
    startFileDownload(api.exportUrl(kind, format.timeZone), {
      title: t('export.frame'),
      onError: (error) => {
        showToast({ variant: 'error', error });
      },
    });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" data-testid="share-export">
          <Download aria-hidden="true" />
          {t('export.button')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            download('csv');
          }}
        >
          <FileText aria-hidden="true" />
          {t('export.csv')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            download('xlsx');
          }}
        >
          <FileSpreadsheet aria-hidden="true" />
          {t('export.xlsx')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ShareExportMenu;
