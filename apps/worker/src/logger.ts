import { withoutPgErrorData, type LogLevel } from '@cellhive/server-core';
import { pino, stdSerializers, type DestinationStream, type Logger } from 'pino';

/**
 * JSON logger of the standalone worker process. Jobs log identifiers only:
 * never record values, event payloads, secrets or tokens.
 */
export function createWorkerLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'cellhive-worker' },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    // A `pg` error's detail/hint/where can quote row values (QA S5c): never logged.
    serializers: { err: (error: Error) => withoutPgErrorData(stdSerializers.err(error)) },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
