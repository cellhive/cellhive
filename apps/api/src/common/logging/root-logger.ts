import { withoutPgErrorData, type LogLevel } from '@cellhive/server-core';
import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

/**
 * Header values that must never reach the logs, wherever a serializer puts
 * them. Request and response bodies are never logged at all.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["proxy-authorization"]',
  'headers["x-csrf-token"]',
  'headers["set-cookie"]',
] as const;

export function rootLoggerOptions(level: LogLevel): LoggerOptions {
  return {
    level,
    base: { service: 'cellhive-api' },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // `"level":"info"` instead of numbers: readable without pino-pretty.
      level: (label) => ({ level: label }),
    },
    redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
    // A `pg` error's detail/hint/where can quote row values (QA S5c): never logged.
    serializers: { err: (error: Error) => withoutPgErrorData(stdSerializers.err(error)) },
  };
}

/** JSON logger on stdout (or `destination`, used by tests). */
export function createRootLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = rootLoggerOptions(level);
  return destination === undefined ? pino(options) : pino(options, destination);
}
