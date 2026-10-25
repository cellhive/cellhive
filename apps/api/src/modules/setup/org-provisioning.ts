import { randomBytes } from 'node:crypto';

import {
  AuditWriter,
  emit,
  orgScope,
  type AppConfig,
  type AuditContext,
  type JsonObject,
  type Organization,
  type OrganizationsRepository,
  type OrgMembersRepository,
  type Tx,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { sql } from 'kysely';

import type { Id } from '@cellhive/contracts';

/**
 * Transaction-level advisory lock key serialising first-time setup, so two
 * concurrent requests cannot both find "no user" and both succeed.
 * ('OBSETUP' as ASCII bytes.)
 */
export const SETUP_LOCK_KEY = 0x4f_42_53_45_54_55_50n;

/** Takes the setup lock for the rest of `tx`. */
export async function lockSetup(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY.toString()}::bigint)`.execute(tx);
}

export function setupCompleted(): AppError {
  return new AppError('SETUP_COMPLETED', { detail: 'This instance is already set up.' });
}

/** Organization defaults stored in `organizations.settings` (SPEC §20). */
export function organizationDefaults(
  config: AppConfig,
  overrides: { locale?: string | undefined; timezone?: string | undefined } = {},
): { locale: string; timezone: string; currency: string } {
  return {
    locale: overrides.locale ?? config.defaults.locale,
    timezone: overrides.timezone ?? config.defaults.timezone,
    currency: config.defaults.currency,
  };
}

/** Longest slug derived from a name (before a uniqueness suffix). */
const MAX_SLUG_LENGTH = 48;
const SLUG_ATTEMPTS = 5;

/**
 * URL-friendly slug of a name: accents removed (`Công ty Đông Á` →
 * `cong-ty-dong-a`), lower-case ASCII letters, digits and single dashes.
 * Falls back to `org` when nothing remains.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug === '' ? 'org' : slug;
}

export interface CreateOrganizationWithOwner {
  readonly name: string;
  readonly ownerId: Id<'usr'>;
  /** Organization defaults: `locale`, `timezone`, `currency` (SPEC §20). */
  readonly settings: JsonObject;
  /** Who is creating it: the new user (setup) or `system` (CLI). */
  readonly context: AuditContext;
}

/**
 * Creates an organization with its owner membership (SPEC §14.1A), used by
 * `POST /setup` and the CLI (`setup`, `org create`). Runs in the caller's
 * transaction and writes the events `org.created` and `org_member.added`,
 * each with its audit entry (CONTRACTS §8: every event is audited).
 */
export class OrganizationProvisioner {
  constructor(
    private readonly organizations: OrganizationsRepository,
    private readonly orgMembers: OrgMembersRepository,
    private readonly audit: AuditWriter = new AuditWriter(),
  ) {}

  /** A slug not used yet: the name's slug, else with a random suffix. */
  async uniqueSlug(name: string, tx: Tx): Promise<string> {
    const base = slugify(name);
    if (!(await this.organizations.slugExists(base, tx))) return base;
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
      const candidate = `${base}-${randomBytes(3).toString('hex')}`;
      if (!(await this.organizations.slugExists(candidate, tx))) return candidate;
    }
    throw new AppError('INTERNAL', { params: { reason: 'no free organization slug' } });
  }

  async create(tx: Tx, input: CreateOrganizationWithOwner): Promise<Organization> {
    const slug = await this.uniqueSlug(input.name, tx);
    const organization = await this.organizations.create(
      { name: input.name, slug, settings: input.settings },
      tx,
    );
    const scope = orgScope(organization.id, tx);
    await this.orgMembers.add(scope, input.ownerId, 'owner');

    const { actor } = input.context;
    await emit(tx, {
      type: 'org.created',
      organizationId: organization.id,
      entityId: organization.id,
      actor,
      data: { name: organization.name, slug: organization.slug },
    });
    await this.audit.write(tx, {
      action: 'org.created',
      organizationId: organization.id,
      entityType: 'org',
      entityId: organization.id,
      after: { name: organization.name, slug: organization.slug, settings: input.settings },
      context: input.context,
    });
    await emit(tx, {
      type: 'org_member.added',
      organizationId: organization.id,
      entityId: input.ownerId,
      actor,
      data: { user_id: input.ownerId, role: 'owner' },
    });
    await this.audit.write(tx, {
      action: 'org_member.added',
      organizationId: organization.id,
      entityType: 'org_member',
      entityId: input.ownerId,
      after: { user_id: input.ownerId, role: 'owner' },
      context: input.context,
    });
    return organization;
  }
}
