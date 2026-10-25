import {
  AuditWriter,
  OrganizationsRepository,
  OrgMembersRepository,
  UsersRepository,
  type AppConfig,
  type Db,
  type Organization,
  type User,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { PasswordHasher } from '../../common/auth/password/password-hasher.js';
import { assertPasswordPolicy } from '../../common/auth/password/password-policy.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import {
  lockSetup,
  OrganizationProvisioner,
  organizationDefaults,
  setupCompleted,
} from './org-provisioning.js';

import type { SetupRequest, SetupResponse, SetupStatus } from '@cellhive/contracts';

/** `POST /setup` attempts per IP (SPEC §14.1A: rate limited). */
export const SETUP_RATE_LIMIT = { limit: 10, windowSeconds: 10 * 60 } as const;

export function toSetupResponse(user: User, organization: Organization): SetupResponse {
  return {
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
    },
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
  };
}

/**
 * First-time setup (SPEC §14.1A): while the instance has no user, creates
 * the first user, an organization and the owner membership in one
 * transaction. Afterwards `409 SETUP_COMPLETED`.
 */
@Injectable()
export class SetupService {
  private readonly provisioner: OrganizationProvisioner;
  private readonly audit = new AuditWriter();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(OrganizationsRepository) organizations: OrganizationsRepository,
    @Inject(OrgMembersRepository) orgMembers: OrgMembersRepository,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
  ) {
    this.provisioner = new OrganizationProvisioner(organizations, orgMembers, this.audit);
  }

  async status(): Promise<SetupStatus> {
    return {
      setup_required: !(await this.users.hasAny()),
      auth_config: {
        smtp_enabled: this.config.mail !== null,
        providers: this.config.oidc.providers.map(({ slug, name }) => ({ slug, name })),
      },
    };
  }

  async complete(input: SetupRequest, meta: RequestMeta): Promise<SetupResponse> {
    await this.rateLimiter.hit(`setup:ip:${meta.ip ?? 'unknown'}`, SETUP_RATE_LIMIT);
    // Cheap rejection before hashing; re-checked under the lock below.
    if (await this.users.hasAny()) throw setupCompleted();
    assertPasswordPolicy(input.password);
    const passwordHash = await this.hasher.hash(input.password);

    return this.db.withTx(async (tx) => {
      await lockSetup(tx);
      if (await this.users.hasAny(tx)) throw setupCompleted();
      const user = await this.users.create(
        { email: input.email, displayName: input.display_name, passwordHash },
        tx,
      );
      const context = auditContextOf(meta, { type: 'user', id: user.id });
      const organization = await this.provisioner.create(tx, {
        name: input.org_name,
        ownerId: user.id,
        settings: organizationDefaults(this.config, input),
        context,
      });
      await this.audit.write(tx, {
        action: 'setup.completed',
        organizationId: organization.id,
        entityType: 'org',
        entityId: organization.id,
        after: { user_id: user.id, email: user.email, org_name: organization.name },
        context,
      });
      return toSetupResponse(user, organization);
    });
  }
}
