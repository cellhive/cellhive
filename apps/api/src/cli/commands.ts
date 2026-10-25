import {
  AuditWriter,
  JOB_QUEUE_SCHEMA,
  systemAuditContext,
  type Tx,
  type User,
} from '@cellhive/server-core';
import { sql } from 'kysely';

import { runMigrations } from '../migrate.js';
import { revokeUserApiTokens } from '../modules/api-token/revoke-user-tokens.js';
import { PasswordResetLinks, type ResetLink } from '../modules/auth/password-reset-links.js';
import {
  lockSetup,
  OrganizationProvisioner,
  organizationDefaults,
} from '../modules/setup/org-provisioning.js';

import { CliError, type CliContext } from './context.js';

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
