import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { BASE_PACKAGE_MEDIA_TYPE, newId } from '@cellhive/contracts';
import {
  AuditWriter,
  basePackageImportKey,
  basePackageKey,
  createStorageDriver,
  findBaseOrganization,
  JOB_QUEUE_SCHEMA,
  JobsRepository,
  listMembershipsOfUser,
  mayCreateBaseIn,
  orgScope,
  systemAuditContext,
  WorkspacesRepository,
  type JobRecord,
  type OrgScope,
  type Tx,
  type User,
} from '@cellhive/server-core';
import { sql } from 'kysely';

import { runMigrations } from '../migrate.js';
import { revokeUserApiTokens } from '../modules/api-token/revoke-user-tokens.js';
import { PasswordResetLinks, type ResetLink } from '../modules/auth/password-reset-links.js';
import { startBaseExport } from '../modules/base-package/base-export.service.js';
import { startBaseImport } from '../modules/base-package/base-import.service.js';
import {
  lockSetup,
  OrganizationProvisioner,
  organizationDefaults,
} from '../modules/setup/org-provisioning.js';

import { CliError, type CliContext } from './context.js';

import type { Id } from '@cellhive/contracts';

/**
 * CLI commands (SPEC §14.1A, §14.2). They run with server access, act as
 * `system` and write audit entries with `actor_type = system`; entries not
 * tied to an organization have `organization_id = NULL` (CONTRACTS §8).
 * Links are printed on stdout only, never logged.
 */

const audit = new AuditWriter();

function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local === '' ? email : local;
}

function provisioner(ctx: CliContext): OrganizationProvisioner {
  return new OrganizationProvisioner(ctx.organizations, ctx.orgMembers, audit);
}

/**
 * Creates a one-time set/reset password link and audits the request;
 * `revokedTokens` (`cellhive user reset-password` only) is recorded with it.
 */
async function createResetLink(
  ctx: CliContext,
  tx: Tx,
  user: User,
  revokedTokens?: number,
): Promise<ResetLink> {
  const link = await new PasswordResetLinks(ctx.passwordResets, ctx.config.publicUrl).create(
    tx,
    user.id,
    { source: 'cli' },
  );
  await audit.write(tx, {
    action: 'auth.password_reset_requested',
    organizationId: null,
    entityType: 'user',
    entityId: user.id,
    after: {
      method: 'cli',
      reset_id: link.resetId,
      ...(revokedTokens === undefined ? {} : { revoked_tokens: revokedTokens }),
    },
    context: systemAuditContext(),
  });
  return link;
}

function printLink(ctx: CliContext, what: string, email: string, link: ResetLink): void {
  ctx.io.err(`${what} for ${email} (one use, valid until ${link.expiresAt.toISOString()}):`);
  ctx.io.out(link.url);
}

/** `cellhive migrate`: same as `MODE=migrate`. */
export async function migrateCommand(ctx: CliContext): Promise<void> {
  const applied = await runMigrations(ctx.config, ctx.logger);
  ctx.io.err(`Database is up to date (${String(applied.length)} migration(s) applied).`);
}

export interface SetupCommandInput {
  readonly email: string;
  readonly org: string;
  readonly name?: string | undefined;
  readonly locale?: string | undefined;
  readonly timezone?: string | undefined;
}

/**
 * `cellhive setup --email … --org …`: the CLI equivalent of `POST /setup`
 * (SPEC §14.1A). Never takes a password on the command line: prints a
 * set-password link instead.
 */
export async function setupCommand(ctx: CliContext, input: SetupCommandInput): Promise<void> {
  const { user, organization, link } = await ctx.db.withTx(async (tx) => {
    await lockSetup(tx);
    if (await ctx.users.hasAny(tx)) {
      throw new CliError('This instance is already set up (a user exists).');
    }
    const created = await ctx.users.create(
      {
        email: input.email,
        displayName: input.name ?? displayNameFromEmail(input.email),
        passwordHash: null,
      },
      tx,
    );
    const context = systemAuditContext();
    const org = await provisioner(ctx).create(tx, {
      name: input.org,
      ownerId: created.id,
      settings: organizationDefaults(ctx.config, input),
      context,
    });
    await audit.write(tx, {
      action: 'setup.completed',
      organizationId: org.id,
      entityType: 'org',
      entityId: org.id,
      after: { user_id: created.id, email: created.email, org_name: org.name, via: 'cli' },
      context,
    });
    return { user: created, organization: org, link: await createResetLink(ctx, tx, created) };
  });
  ctx.io.err(`Created user ${user.id} and organization ${organization.id} (${organization.slug}).`);
  printLink(ctx, 'Set-password link', user.email, link);
}

export interface OrgCreateCommandInput {
  readonly name: string;
  readonly ownerEmail: string;
}

/**
 * `cellhive org create --name … --owner-email …` (SPEC §14.1A). A missing
 * owner is created without a password and gets a set-password link.
 */
export async function orgCreateCommand(
  ctx: CliContext,
  input: OrgCreateCommandInput,
): Promise<void> {
  const { organization, newOwner, link } = await ctx.db.withTx(async (tx) => {
    const existing = await ctx.users.findByEmail(input.ownerEmail, tx);
    const owner =
      existing ??
      (await ctx.users.create(
        {
          email: input.ownerEmail,
          displayName: displayNameFromEmail(input.ownerEmail),
          passwordHash: null,
        },
        tx,
      ));
    const org = await provisioner(ctx).create(tx, {
      name: input.name,
      ownerId: owner.id,
      settings: organizationDefaults(ctx.config),
      context: systemAuditContext(),
    });
    return {
      organization: org,
      newOwner: existing === undefined ? owner : undefined,
      link: existing === undefined ? await createResetLink(ctx, tx, owner) : undefined,
    };
  });
  ctx.io.err(`Created organization ${organization.id} (${organization.slug}).`);
  ctx.io.out(organization.id);
  if (newOwner !== undefined && link !== undefined) {
    printLink(ctx, 'New owner account; set-password link', newOwner.email, link);
  }
}

/**
 * `cellhive user reset-password --email …` (SPEC §14.2): for owners,
 * members of several organizations and lone admins, who cannot get a link
 * from an organization admin. Also the break-glass of accounts that sign in
 * with OIDC only (CONTRACTS §12.1, T708): the link sets a first password,
 * e.g. when the provider is gone; the identities stay connected.
 *
 * Unless `--keep-tokens`, every API token of the user, in every
 * organization, is revoked in the same transaction as the link (T802): an
 * account taken over is the main reason to reset, and its tokens should
 * stop now, not when the link is used.
 */
export async function userResetPasswordCommand(
  ctx: CliContext,
  input: { readonly email: string; readonly revokeTokens: boolean },
): Promise<void> {
  const { user, link, revokedTokens } = await ctx.db.withTx(async (tx) => {
    const found = await ctx.users.findByEmail(input.email, tx);
    if (found === undefined) throw new CliError('No user has this email.');
    const revoked = input.revokeTokens
      ? await revokeUserApiTokens(ctx, tx, {
          userId: found.id,
          reason: 'password_reset',
          context: systemAuditContext(),
        })
      : 0;
    return {
      user: found,
      link: await createResetLink(ctx, tx, found, revoked),
      revokedTokens: revoked,
    };
  });
  ctx.io.err(
    input.revokeTokens
      ? `Revoked ${String(revokedTokens)} API token(s) of ${user.email}.`
      : `API tokens of ${user.email} kept (--keep-tokens).`,
  );
  printLink(ctx, 'Password reset link', user.email, link);
}

/** Default age of a lock after which its worker is considered dead. */
export const DEFAULT_STALE_LOCK_MINUTES = 30;

/**
 * `cellhive jobs unlock-stale`: releases the job locks held by workers that
 * died (graphile-worker itself only reclaims them after 4 hours) through
 * `graphile_worker.force_unlock_workers`. A worker is taken as dead when it
 * holds a lock older than `--older-than` minutes: only use a value longer
 * than the longest job, or run it when no worker is alive.
 */
export async function jobsUnlockStaleCommand(
  ctx: CliContext,
  input: { readonly olderThanMinutes: number; readonly dryRun: boolean },
): Promise<void> {
  const interval = `${String(input.olderThanMinutes)} minutes`;
  const { rows } = await sql<{ worker_id: string }>`
    SELECT locked_by AS worker_id FROM ${sql.id(JOB_QUEUE_SCHEMA, '_private_jobs')}
     WHERE locked_by IS NOT NULL AND locked_at < now() - ${interval}::interval
    UNION
    SELECT locked_by FROM ${sql.id(JOB_QUEUE_SCHEMA, '_private_job_queues')}
     WHERE locked_by IS NOT NULL AND locked_at < now() - ${interval}::interval
    ORDER BY 1`.execute(ctx.db.kysely);
  const workerIds = rows.map((row) => row.worker_id);
  if (workerIds.length === 0) {
    ctx.io.err(`No job locks older than ${interval}.`);
    return;
  }
  if (!input.dryRun) {
    await sql`SELECT ${sql.id(JOB_QUEUE_SCHEMA, 'force_unlock_workers')}(${workerIds}::text[])`.execute(
      ctx.db.kysely,
    );
  }
  ctx.io.err(
    `${input.dryRun ? 'Would unlock' : 'Unlocked'} jobs of ${String(workerIds.length)} worker(s):`,
  );
  for (const id of workerIds) ctx.io.out(id);
}

/** How often `cellhive base export` reads the state of its job. */
export const BASE_EXPORT_POLL_MS = 1_000;
/** After this long in `queued`, the CLI says the worker may not be running. */
const BASE_EXPORT_QUEUED_HINT_MS = 30_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `cellhive base export --base <bse_…> --out <file.chbase>` (CONTRACTS
 * §12.2): starts the same `base.export` job as `POST /bases/:id/export`
 * (system actor, `base.exported` audited) and waits for the worker to
 * finish it, then copies the package from object storage into `--out` (a
 * new file, never overwritten) and removes the stored copy. Prints the job
 * id, then the result as JSON with `path` instead of `download_url`. The
 * caps of `BASE_PACKAGE_MAX_BYTES` apply as to any export.
 */
export async function baseExportCommand(
  ctx: CliContext,
  input: { readonly baseId: Id<'bse'>; readonly out: string },
  options: { readonly pollMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  if (await exists(input.out)) throw new CliError(`${input.out} already exists.`);
  const organizationId = await findBaseOrganization(ctx.db.kysely, input.baseId);
  if (organizationId === undefined)
    throw new CliError('No base has this id (or it is in the trash).');
  const scope = orgScope(organizationId);
  const jobId = await startBaseExport(ctx.db, {
    scope,
    baseId: input.baseId,
    createdBy: null,
    context: systemAuditContext(),
  });
  ctx.io.err(`Export started (job ${jobId}); the worker writes the package.`);
  ctx.io.out(jobId);

  await waitForJob(ctx, scope, jobId, 'export', options);
  const jobs = new JobsRepository(ctx.db);
  const storage = createStorageDriver(ctx.config);
  const key = basePackageKey(organizationId, jobId);
  try {
    const body = await storage.getStream(key);
    if (body === null) throw new CliError('The package is no longer stored; export again.');
    try {
      // `wx`: a file created meanwhile is never overwritten.
      await pipeline(body, createWriteStream(input.out, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await rm(input.out, { force: true });
      }
      throw error;
    }
    await storage.delete(key);
    await jobs.clearDownload(scope, jobId);
  } finally {
    await storage.close();
  }
  const job = await jobs.getById(scope, jobId);
  const result = { ...((job?.result ?? {}) as Record<string, unknown>) };
  delete result['download_url'];
  delete result['expires_at'];
  delete result['file_deleted'];
  ctx.io.err(`Package written to ${input.out}.`);
  ctx.io.out(JSON.stringify({ path: input.out, ...result }));
}

/**
 * Waits for a `base.export`/`base.import` job to end (the worker runs it):
 * the finished row, or a `CliError` with the job's error code when it did
 * not succeed. Says on stderr when the job is still queued after 30 s.
 */
async function waitForJob(
  ctx: CliContext,
  scope: OrgScope,
  jobId: Id<'job'>,
  what: 'export' | 'import',
  options: { readonly pollMs?: number; readonly sleep?: (ms: number) => Promise<void> },
): Promise<JobRecord> {
  const jobs = new JobsRepository(ctx.db);
  const pollMs = options.pollMs ?? BASE_EXPORT_POLL_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  let hinted = false;
  for (;;) {
    const job = await jobs.getById(scope, jobId);
    if (job === undefined) throw new CliError(`The ${what} job is gone.`);
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      const error = job.error as { code?: unknown; detail?: unknown } | null;
      const code = typeof error?.code === 'string' ? error.code : job.status;
      const detail = typeof error?.detail === 'string' ? ` ${error.detail}` : '';
      throw new CliError(`The ${what} ${job.status} (${code}).${detail}`);
    }
    if (!hinted && job.status === 'queued' && Date.now() - started > BASE_EXPORT_QUEUED_HINT_MS) {
      hinted = true;
      ctx.io.err(
        `Still queued: is the worker running? (another ${what} of the organization waits too)`,
      );
    }
    await sleep(pollMs);
  }
}

/**
 * `cellhive base import --workspace <wsp_…> --file <file.chbase> --as <email>`
 * (CONTRACTS §12.2): stores the file in object storage and starts the same
 * `base.import` job as `POST /workspaces/:id/bases/import`, for the user of
 * `--as` (a member who may create bases in the workspace: the owner of the
 * new base), then waits for the worker to finish it. Prints the job id,
 * then the result (`{ base_id, report }`) as JSON. The caps of
 * `BASE_PACKAGE_MAX_BYTES` apply as to any import.
 */
export async function baseImportCommand(
  ctx: CliContext,
  input: { readonly workspaceId: Id<'wsp'>; readonly file: string; readonly as: string },
  options: { readonly pollMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  let size: number;
  try {
    const info = await stat(input.file);
    if (!info.isFile()) throw new CliError(`${input.file} is not a file.`);
    size = info.size;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${input.file} cannot be read.`);
  }
  const limit = ctx.config.limits.basePackageMaxBytes;
  if (size > limit) {
    throw new CliError(
      `${input.file} is larger than BASE_PACKAGE_MAX_BYTES (${String(limit)} bytes).`,
    );
  }
  const user = await ctx.users.findByEmail(input.as);
  if (user === undefined) throw new CliError('No user has the email of --as.');
  let scope: OrgScope | undefined;
  for (const membership of await listMembershipsOfUser(ctx.db.kysely, user.id)) {
    const candidate = orgScope(membership.organizationId);
    if (
      (await new WorkspacesRepository(ctx.db).getById(candidate, input.workspaceId)) !== undefined
    ) {
      scope = candidate;
      break;
    }
  }
  if (scope === undefined) {
    throw new CliError('No workspace with this id in an organization of the --as user.');
  }
  if (!(await mayCreateBaseIn(ctx.db, scope, user.id, input.workspaceId))) {
    throw new CliError('The --as user may not create bases in this workspace.');
  }

  const jobId = newId('job');
  const key = basePackageImportKey(scope.organizationId, jobId);
  const storage = createStorageDriver(ctx.config);
  try {
    await storage.putStream(key, createReadStream(input.file), {
      contentType: BASE_PACKAGE_MEDIA_TYPE,
      contentLength: size,
    });
    try {
      await startBaseImport(ctx.db, {
        scope,
        jobId,
        workspaceId: input.workspaceId,
        createdBy: user.id,
      });
    } catch (error) {
      await storage.delete(key);
      throw error;
    }
  } finally {
    await storage.close();
  }
  ctx.io.err(`Import started (job ${jobId}); the worker builds the base.`);
  ctx.io.out(jobId);
  const job = await waitForJob(ctx, scope, jobId, 'import', options);
  ctx.io.err('Base imported.');
  ctx.io.out(JSON.stringify(job.result ?? {}));
}
