import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearToasts, useToasts } from '../../toast/toast';
import { JOB_POLL_MS, onJobProgress, trackedJobs, trackJob, untrackAllJobs } from '../jobs';

import type { JobDto } from '@cellhive/contracts';

const JOB = 'job_J000000000000001';
const messages = { running: 'Removing', succeeded: 'Removed', failed: 'Failed' };

function job(status: JobDto['status'], progress: number): JobDto {
  return {
    id: JOB,
    type: 'schema.remove_select_options',
    status,
    progress,
    result: null,
    error: null,
    created_at: '2026-09-24T00:00:00.000Z',
    started_at: null,
    finished_at: null,
  };
}

function toasts() {
  return renderHook(() => useToasts()).result.current;
}

beforeEach(() => {
  vi.useFakeTimers();
  clearToasts();
});

afterEach(() => {
  untrackAllJobs();
  vi.useRealTimers();
  clearToasts();
});

describe('trackJob (FRONTEND §4.3, §5)', () => {
  it('shows progress from job.progress, then the outcome, once', async () => {
    const fetchJob = vi.fn(() => Promise.resolve(job('queued', 0)));
    const onSettled = vi.fn();
    trackJob(JOB, { messages, onSettled, fetchJob });
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts()).toMatchObject([{ variant: 'info', message: 'Removing', progress: 0 }]);
    onJobProgress({ job_id: JOB, status: 'running', progress: 0.4 });
    expect(toasts()).toMatchObject([{ message: 'Removing', progress: 0.4, durationMs: null }]);
    // Progress never goes back.
    onJobProgress({ job_id: JOB, status: 'running', progress: 0.2 });
    expect(toasts()[0]?.progress).toBe(0.4);
    onJobProgress({ job_id: JOB, status: 'succeeded', progress: 1 });
    expect(toasts()).toMatchObject([{ variant: 'success', message: 'Removed', progress: null }]);
    expect(onSettled).toHaveBeenCalledWith('succeeded');
    onJobProgress({ job_id: JOB, status: 'succeeded', progress: 1 });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(trackedJobs()).toEqual([]);
  });

  it('falls back to GET /jobs/:id when messages are missed', async () => {
    const answers = [job('running', 0.5), job('failed', 0.5)];
    const fetchJob = vi.fn(() => Promise.resolve(answers.shift() ?? job('failed', 1)));
    const onSettled = vi.fn();
    trackJob(JOB, { messages, onSettled, fetchJob });
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts()[0]?.progress).toBe(0.5);
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    expect(onSettled).toHaveBeenCalledWith('failed');
    expect(toasts()).toMatchObject([{ variant: 'error', message: 'Failed' }]);
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 3);
    expect(fetchJob).toHaveBeenCalledTimes(2);
  });

  it('ignores jobs it does not follow, and stops on request', async () => {
    onJobProgress({ job_id: 'job_Other00000000001', status: 'running', progress: 0.3 });
    expect(toasts()).toEqual([]);
    const fetchJob = vi.fn(() => Promise.resolve(job('running', 0.1)));
    const stop = trackJob(JOB, { messages, fetchJob });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(toasts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2);
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });
});
