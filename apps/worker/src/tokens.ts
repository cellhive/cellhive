/**
 * Injection tokens of the worker. Every constructor dependency is injected
 * with an explicit `@Inject(token)` because decorator metadata is not emitted.
 */

/** `AppConfig` from `@cellhive/server-core`. */
export const APP_CONFIG = Symbol('WORKER_APP_CONFIG');
/** Root pino logger. */
export const ROOT_LOGGER = Symbol('WORKER_ROOT_LOGGER');
/** `Db` (Kysely + `withTx`) with the job `statement_timeout`. */
export const DB = Symbol('WORKER_DB');
/** `WorkerRuntimeOptions`. */
export const WORKER_OPTIONS = Symbol('WORKER_OPTIONS');
/** ioredis client for Valkey (realtime publishing). */
export const CACHE_CLIENT = Symbol('WORKER_CACHE_CLIENT');
/** `RealtimePublisher` attached to `DB` (SPEC §15). */
export const REALTIME_BUS = Symbol('WORKER_REALTIME_BUS');
