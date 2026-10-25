import { api } from '../api';
import { devWarn } from '../dev-log';
import { dismissToast, showToast, updateToast } from '../toast/toast';

import type { JobDto, JobStatusName } from '@cellhive/contracts';

/**
 * Background jobs started from this tab (FRONTEND §4.3, §5): a toast shows
 * their progress from `job.progress` on `user:{me}` and, as a fallback when
 * messages are missed (reconnect, Valkey down), from `GET /jobs/:id`.
 */

/** `GET /jobs/:id` is polled this often while a job runs (the WS messages are faster). */
export const JOB_POLL_MS = 5000;

const TERMINAL: ReadonlySet<JobStatusName> = new Set(['succeeded', 'failed', 'cancelled']);

export interface JobMessages {
  /** Translated text while the job runs. */
  readonly running: string;
  readonly succeeded: string;
  readonly failed: string;
}

export interface TrackJobOptions {
  readonly messages: JobMessages;
  /** Once, when the job ended (e.g. invalidate the queries it changed). */
  readonly onSettled?: (status: JobStatusName) => void;
  /** Replaces `GET /jobs/:id` (tests). */
  readonly fetchJob?: (jobId: string, signal: AbortSignal) => Promise<JobDto>;
}

interface Tracked {
  readonly options: TrackJobOptions;
  readonly toastId: number;
  readonly abort: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  progress: number;
}

const tracked = new Map<string, Tracked>();

/** Jobs being followed (tests). */
export function trackedJobs(): string[] {
  return [...tracked.keys()];
}

/** Stops following every job (sign-out, tests). */
export function untrackAllJobs(): void {
  for (const job of tracked.values()) {
    clearTimeout(job.timer);
    job.abort.abort();
  }
  tracked.clear();
}

function settle(jobId: string, status: JobStatusName): void {
  const job = tracked.get(jobId);
  if (job === undefined) return;
  tracked.delete(jobId);
  clearTimeout(job.timer);
  job.abort.abort();
  const { messages } = job.options;
  const input =
    status === 'succeeded'
      ? { variant: 'success' as const, message: messages.succeeded }
      : { variant: 'error' as const, message: messages.failed };
  if (!updateToast(job.toastId, input)) showToast(input);
  job.options.onSettled?.(status);
}

function report(jobId: string, status: JobStatusName, progress: number): void {
  const job = tracked.get(jobId);
  if (job === undefined) return;
  if (TERMINAL.has(status)) {
    settle(jobId, status);
    return;
  }
  // Progress never goes back (a poll answer may be older than a message).
  job.progress = Math.max(job.progress, progress);
  updateToast(job.toastId, {
    variant: 'info',
    message: job.options.messages.running,
    progress: job.progress,
    durationMs: null,
  });
}

function poll(jobId: string): void {
  const job = tracked.get(jobId);
  if (job === undefined) return;
  const fetchJob =
    job.options.fetchJob ?? ((id: string, signal: AbortSignal) => api.jobs.get(id, signal));
  fetchJob(jobId, job.abort.signal).then(
    (dto) => {
      report(jobId, dto.status, dto.progress);
      schedule(jobId);
    },
    (error: unknown) => {
      if (job.abort.signal.aborted) return;
      devWarn('jobs: cannot read the job', error);
      schedule(jobId);
    },
  );
}

function schedule(jobId: string): void {
  const job = tracked.get(jobId);
  if (job === undefined) return;
  clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    poll(jobId);
  }, JOB_POLL_MS);
}

/**
 * Follows a job this tab started: a toast with its progress until it ends,
 * then its outcome. Returns a function that stops following (and removes
 * the toast).
 */
export function trackJob(jobId: string, options: TrackJobOptions): () => void {
  const existing = tracked.get(jobId);
  if (existing !== undefined) return () => undefined;
  const toastId = showToast({
    variant: 'info',
    message: options.messages.running,
    progress: 0,
    durationMs: null,
  });
  tracked.set(jobId, {
    options,
    toastId,
    abort: new AbortController(),
    timer: undefined,
    progress: 0,
  });
  // The job may be done before any message arrives.
  poll(jobId);
  return () => {
    const job = tracked.get(jobId);
    if (job === undefined) return;
    tracked.delete(jobId);
    clearTimeout(job.timer);
    job.abort.abort();
    dismissToast(job.toastId);
  };
}

/** A `job.progress` message of `user:{me}`. */
export interface JobProgressMessage {
  readonly job_id: string;
  readonly status: JobStatusName;
  readonly progress: number;
}

const progressListeners = new Set<(message: JobProgressMessage) => void>();

/**
 * Every `job.progress` message of this tab, for screens that show a job's
 * progress themselves (the import wizard, T318) rather than in a toast.
 * Returns the unsubscribe function.
 */
export function subscribeJobProgress(listener: (message: JobProgressMessage) => void): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

/** `job.progress` from `user:{me}`; jobs this tab does not follow are ignored. */
export function onJobProgress(message: JobProgressMessage): void {
  report(message.job_id, message.status, message.progress);
  for (const listener of progressListeners) listener(message);
}
