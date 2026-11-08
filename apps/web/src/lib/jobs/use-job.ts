import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { keys } from '../query/keys';
import { jobQuery } from '../query/queries';
import { JOB_POLL_MS, subscribeJobProgress } from '../realtime/jobs';

import type { JobDto, JobStatusName } from '@cellhive/contracts';

const TERMINAL: ReadonlySet<JobStatusName> = new Set(['succeeded', 'failed', 'cancelled']);

/** Whether a job status is final. */
export function isJobFinished(status: JobStatusName | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}

export interface JobState {
  readonly status: JobStatusName;
  /** 0–1, never going back. */
  readonly progress: number;
  /** The job once it ended (result or error inside). */
  readonly job: JobDto | undefined;
  /** `GET /jobs/:id` failed (e.g. `404`: no longer allowed to read it). */
  readonly error: unknown;
}

/**
 * A job shown on its own screen (FRONTEND §5, §17.5): `job.progress` on
 * `user:{me}`, with `GET /jobs/:id` every 5 s as the fallback when messages
 * are missed (reconnect, Valkey down) and to read the result once it ended.
 * Used by the `.chbase` export page and import dialog, loaded with them;
 * `null` follows no job.
 */
export function useJob(jobId: string | null, poll: number = JOB_POLL_MS): JobState {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<{
    jobId: string;
    status: JobStatusName;
    progress: number;
  } | null>(null);
  const query = useQuery({
    ...jobQuery(jobId ?? ''),
    enabled: jobId !== null,
    refetchInterval: (current) => (isJobFinished(current.state.data?.status) ? false : poll),
  });

  useEffect(
    () =>
      subscribeJobProgress((message) => {
        if (jobId === null || message.job_id !== jobId) return;
        setLive((previous) => ({
          jobId,
          status: message.status,
          progress: Math.max(previous?.jobId === jobId ? previous.progress : 0, message.progress),
        }));
        if (isJobFinished(message.status)) {
          void queryClient.invalidateQueries({ queryKey: keys.job(jobId) });
        }
      }),
    [jobId, queryClient],
  );

  // A message of the job shown before (the id changed) no longer counts.
  const current = live?.jobId === jobId ? live : null;
  const data = jobId === null ? undefined : query.data;
  const ended = data !== undefined && isJobFinished(data.status);
  const status: JobStatusName = ended
    ? data.status
    : current !== null && !isJobFinished(current.status)
      ? current.status
      : (data?.status ?? 'queued');
  const progress =
    ended && data.status === 'succeeded'
      ? 1
      : Math.max(current?.progress ?? 0, data?.progress ?? 0);
  return {
    status,
    progress,
    job: ended ? data : undefined,
    error: jobId === null ? null : query.error,
  };
}
