import {
  importJobResultSchema,
  type ImportJobResult,
  type JobDto,
  type JobStatusName,
} from '@cellhive/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { keys } from '../../lib/query/keys';
import { jobQuery } from '../../lib/query/queries';
import { JOB_POLL_MS, subscribeJobProgress } from '../../lib/realtime/jobs';

const TERMINAL: ReadonlySet<JobStatusName> = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminal(status: JobStatusName | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}

export interface ImportJobState {
  readonly status: JobStatusName;
  /** 0–1, never going back. */
  readonly progress: number;
  /** The job once it ended (result or error inside). */
  readonly job: JobDto | undefined;
}

/**
 * Progress of an import job (FRONTEND §5): `job.progress` on `user:{me}`,
 * with `GET /jobs/:id` every 5 s as the fallback when messages are missed
 * (reconnect, Valkey down) and to read the result once it ended.
 */
export function useImportJob(jobId: string, poll: number = JOB_POLL_MS): ImportJobState {
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
  return { status, progress, job: ended ? data : undefined };
}

/** `result` of a finished import, when it has the documented shape. */
export function importResultOf(job: JobDto | undefined): ImportJobResult | undefined {
  if (job?.result === null || job?.result === undefined) return undefined;
  const parsed = importJobResultSchema.safeParse(job.result);
  return parsed.success ? parsed.data : undefined;
}
