import { Button } from '@cellhive/ui';
import { useMutation } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../lib/api';
import { isApiError } from '../../../lib/api/client';
import { showErrorToast, showToast } from '../../../lib/toast/toast';
import { reportDownloadUrl } from '../model/report';

/** Starts a download of a same-origin API file (the API answers with a short-lived redirect). */
function download(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * "Download the error report" of an `import.finished` with failed rows
 * (T552, T548): asks `GET /jobs/:id` when pressed (only the person who ran
 * the import may; the report is kept 24 hours) and downloads it, or says
 * it is gone. No request until pressed: the list stays one request.
 */
export function ImportReport({
  jobId,
  onUsed,
}: {
  readonly jobId: string;
  readonly onUsed: () => void;
}) {
  const { t } = useTranslation('notifications');
  const fetchReport = useMutation({
    mutationFn: () => api.jobs.get(jobId),
    onSuccess: (job) => {
      const url = reportDownloadUrl(job, new Date());
      if (url === null) {
        showToast({ variant: 'warning', message: t('item.report.gone') });
        return;
      }
      onUsed();
      download(url);
    },
    onError: (error) => {
      if (isApiError(error) && error.status === 404) {
        showToast({ variant: 'warning', message: t('item.report.gone') });
        return;
      }
      showErrorToast(error);
    },
  });
  return (
    <Button
      variant="secondary"
      size="sm"
      className="mt-1 self-start max-lg:h-control"
      data-testid={`import-report-${jobId}`}
      disabled={fetchReport.isPending}
      aria-busy={fetchReport.isPending}
      onClick={() => {
        fetchReport.mutate();
      }}
    >
      <Download aria-hidden="true" />
      {fetchReport.isPending ? t('item.report.preparing') : t('item.report.download')}
    </Button>
  );
}
