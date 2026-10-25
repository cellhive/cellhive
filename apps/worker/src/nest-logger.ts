import type { LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Routes NestJS framework logs (module init, lifecycle errors) to pino. */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly root: Logger) {}

  log(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
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

  private write(level: Level, message: unknown, optional: unknown[]): void {
    const last = optional.at(-1);
    const fields: Record<string, unknown> = typeof last === 'string' ? { context: last } : {};
    if (message instanceof Error) {
      this.root[level]({ ...fields, err: message }, message.message);
      return;
    }
    this.root[level](fields, typeof message === 'string' ? message : JSON.stringify(message));
  }
}
