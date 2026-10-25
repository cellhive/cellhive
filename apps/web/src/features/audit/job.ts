import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { keys } from '../../lib/query/keys';
import { jobQuery } from '../../lib/query/queries';
import { JOB_POLL_MS, subscribeJobProgress } from '../../lib/realtime/jobs';

import type { JobDto, JobStatusName } from '@cellhive/contracts';

const TERMINAL: ReadonlySet<JobStatusName> = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminal(status: JobStatusName | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}

export interface ExportJobState {
  readonly status: JobStatusName;
  /** 0–1, never going back. */
  readonly progress: number;
  /** The job once it ended (result or error inside). */
  readonly job: JobDto | undefined;
  readonly error: unknown;
}

/**
 * Progress of an audit export job (CONTRACTS §12.2, FRONTEND §5):
 * `job.progress` on `user:{me}`, with `GET /jobs/:id` every 5 s as the
 * fallback and to read the download link once it ended.
 */
export function useExportJob(jobId: string, poll: number = JOB_POLL_MS): ExportJobState {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<{ status: JobStatusName; progress: number } | null>(null);
  const query = useQuery({
    ...jobQuery(jobId),
    refetchInterval: (current) => (isTerminal(current.state.data?.status) ? false : poll),
  });

  useEffect(
    () =>
      subscribeJobProgress((message) => {
        if (message.job_id !== jobId) return;
        setLive((previous) => ({
          status: message.status,
          progress: Math.max(previous?.progress ?? 0, message.progress),
        }));
        if (isTerminal(message.status)) {
          void queryClient.invalidateQueries({ queryKey: keys.job(jobId) });
        }
      }),
    [jobId, queryClient],
  );

  const data = query.data;
  const ended = data !== undefined && isTerminal(data.status);
  const status: JobStatusName = ended
    ? data.status
    : live !== null && !isTerminal(live.status)
      ? live.status
      : (data?.status ?? 'queued');
  const progress =
    ended && data.status === 'succeeded' ? 1 : Math.max(live?.progress ?? 0, data?.progress ?? 0);
  return { status, progress, job: ended ? data : undefined, error: query.error };
}
