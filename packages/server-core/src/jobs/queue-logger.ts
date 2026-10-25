import { Logger, type LogFunctionFactory } from 'graphile-worker';

/** The part of a pino logger used here (structural, so server-core needs no pino). */
export interface LogSink {
  error(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

/** Scope keys graphile-worker attaches to a logger, renamed to our log fields. */
const SCOPE_FIELDS = {
  label: 'queue_component',
  workerId: 'worker_id',
  taskIdentifier: 'task',
  jobId: 'job_id',
} as const;

/**
 * Picks what may be logged from graphile-worker's metadata. Its `job` object
 * carries the payload (record values, event data), so only identifiers and
 * counters are kept; errors are logged as `err`.
 */
export function sanitizeQueueLogMeta(
  scope: Readonly<Record<string, unknown>>,
  meta: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(SCOPE_FIELDS)) {
    const value = scope[key];
    if (typeof value === 'string' || typeof value === 'number') fields[field] = value;
  }
  const job = meta.job;
  if (typeof job === 'object' && job !== null) {
    const {
      id,
      task_identifier: task,
      attempts,
      max_attempts: maxAttempts,
    } = job as Record<string, unknown>;
    if (typeof id === 'string' || typeof id === 'number') fields.job_id = id;
    if (typeof task === 'string') fields.task = task;
    if (typeof attempts === 'number') fields.attempts = attempts;
    if (typeof maxAttempts === 'number') fields.max_attempts = maxAttempts;
  }
  if (meta.error !== undefined) fields.err = meta.error;
  if (typeof meta.duration === 'number') fields.duration_ms = meta.duration;
  return fields;
}

/** graphile-worker `Logger` writing to pino (or any `LogSink`). */
export function createQueueLogger(sink: LogSink): Logger {
  const factory: LogFunctionFactory = (scope) => (level, message, meta) => {
    const fields = sanitizeQueueLogMeta(scope, meta);
    switch (level) {
      case 'error':
        sink.error(fields, message);
        return;
      case 'warning':
        sink.warn(fields, message);
        return;
      case 'info':
        sink.info(fields, message);
        return;
      default:
        sink.debug(fields, message);
    }
  };
  return new Logger(factory);
}
