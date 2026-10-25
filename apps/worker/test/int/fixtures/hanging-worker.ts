/**
 * Child process for the crash test: runs `test.slow` jobs that record their
 * start and then never finish, so the test can SIGKILL this process while a
 * job is locked by it.
 */
import process from 'node:process';

import { pino } from 'pino';

import { startJobRunner } from '../../../src/job-runner.js';

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined) throw new Error('DATABASE_URL is required');
// Host part of the worker id (T702): the test decides which host this process is on.
const hostname = process.env.WORKER_HOSTNAME;
// Pid part of the worker id: simulates another PID namespace (e.g. PID 1 of a container).
const pid = process.env.WORKER_PID === undefined ? undefined : Number(process.env.WORKER_PID);

await startJobRunner({
  connectionString,
  concurrency: 1,
  pollIntervalMs: 200,
  logger: pino({ level: 'silent' }),
  ...(hostname === undefined ? {} : { hostname }),
  ...(pid === undefined ? {} : { pid }),
  taskList: {
    'test.slow': async (_payload, helpers) => {
      await helpers.query('INSERT INTO public.test_started (job_id) VALUES ($1)', [helpers.job.id]);
      await new Promise<never>(() => {
        // Hangs until the process is killed.
      });
    },
  },
});
process.stdout.write('ready\n');
