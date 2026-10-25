import {
  ApiTokensRepository,
  loadConfig,
  OrganizationsRepository,
  OrgMembersRepository,
  PasswordResetsRepository,
  UsersRepository,
  type AppConfig,
  type Db,
  type Env,
} from '@cellhive/server-core';
import { destination, pino, type Logger } from 'pino';

import { createApiDb } from '../common/infra/connections.js';
import { rootLoggerOptions } from '../common/logging/root-logger.js';

/** Where a command writes: `out` for results (links, ids), `err` for messages. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** Thrown by commands for expected failures: printed without a stack, exit code 1. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Everything a command needs, built from the environment like the server. */
export interface CliContext {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Db;
  readonly users: UsersRepository;
  readonly organizations: OrganizationsRepository;
  readonly orgMembers: OrgMembersRepository;
  readonly passwordResets: PasswordResetsRepository;
  readonly apiTokens: ApiTokensRepository;
  readonly io: CliIo;
}

/**
 * Loads the configuration (same variables as the server, SPEC §20) and
 * opens a small pool. Logs go to stderr so stdout carries only results.
 */
export function createCliContext(env: Env, io: CliIo): CliContext {
  const config = loadConfig(env);
  const logger = pino(
    { ...rootLoggerOptions(config.logLevel), base: { service: 'cellhive-cli' } },
    destination(2),
  );
  const db = createApiDb(config, logger, { poolMax: 2, applicationName: 'cellhive-cli' });
  return {
    config,
    logger,
    db,
    users: new UsersRepository(db),
    organizations: new OrganizationsRepository(db),
    orgMembers: new OrgMembersRepository(db),
    passwordResets: new PasswordResetsRepository(db),
    apiTokens: new ApiTokensRepository(db),
    io,
  };
}
