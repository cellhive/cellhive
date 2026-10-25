import { Inject, Injectable, type LoggerService } from '@nestjs/common';

import { ROOT_LOGGER } from '../tokens.js';

import { requestContext } from './request-context.js';

import type { Bindings, Logger } from 'pino';

type LogFields = Record<string, unknown>;

/**
 * The logger application code injects (AGENTS.md). Writes JSON through pino;
 * inside a request it uses the request's child logger, so every line carries
 * `request_id`. Never pass record values, secrets, tokens or passwords.
 */
@Injectable()
export class AppLogger {
  constructor(@Inject(ROOT_LOGGER) private readonly root: Logger) {}

  /** Logger of the current request, or the root logger outside requests. */
  get pino(): Logger {
    return requestContext.getStore()?.logger ?? this.root;
  }

  child(bindings: Bindings): Logger {
    return this.pino.child(bindings);
  }

  fatal(fields: LogFields, msg: string): void {
    this.pino.fatal(fields, msg);
  }
  error(fields: LogFields, msg: string): void {
    this.pino.error(fields, msg);
  }
  warn(fields: LogFields, msg: string): void {
    this.pino.warn(fields, msg);
  }
  info(fields: LogFields, msg: string): void {
    this.pino.info(fields, msg);
  }
  debug(fields: LogFields, msg: string): void {
    this.pino.debug(fields, msg);
  }
}

/** Routes NestJS framework logs (bootstrap, route mapping) to pino. */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly root: Logger) {}

  log(message: unknown, ...optional: unknown[]): void {
    this.write('info', message, optional);
  }
  error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, optional);
  }
  warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, optional);
  }
  debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }
  verbose(message: unknown, ...optional: unknown[]): void {
    this.write('trace', message, optional);
  }
  fatal(message: unknown, ...optional: unknown[]): void {
    this.write('fatal', message, optional);
  }

  private write(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    optional: unknown[],
  ): void {
    // Nest passes the context (class name) as the last string argument.
    const last = optional.at(-1);
    const context = typeof last === 'string' ? last : undefined;
    const fields: LogFields = context === undefined ? {} : { context };
    // `error(message, stack, context)`.
    if (optional.length >= 2 && typeof optional[0] === 'string') fields.stack = optional[0];
    if (message instanceof Error) {
      this.root[level]({ ...fields, err: message }, message.message);
    } else {
      this.root[level](fields, typeof message === 'string' ? message : JSON.stringify(message));
    }
  }
}
