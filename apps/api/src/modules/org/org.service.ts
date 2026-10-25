import {
  apiTokenPolicyOf,
  automationMaxDepthOf,
  ComputedRecomputeService,
  OrganizationsRepository,
  OrgMembersRepository,
  publishApiTokensRevoked,
  type AppConfig,
  type Db,
  type JsonObject,
  type JsonValue,
  type Organization,
  type OrgRole,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, permissionDenied } from '../../common/access/access.service.js';
import { diffOf, mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { publicSharingPolicyOf } from '../../common/access/public-sharing.js';
import { iso } from '../../common/dto.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { OrganizationProvisioner, organizationDefaults } from '../setup/org-provisioning.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
  CreateOrganizationRequest,
  Id,
  OffsetQuery,
  OrganizationDto,
  OrganizationList,
  OrganizationSettings,
  UpdateOrganizationRequest,
} from '@cellhive/contracts';

function stringSetting(settings: JsonValue, key: string): string | undefined {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return undefined;
  }
  const value = settings[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** `/orgs` and `/orgs/:orgId` (SPEC §13.1, §14.1A). */
@Injectable()
export class OrgService {
  private readonly provisioner: OrganizationProvisioner;
  private readonly recompute: ComputedRecomputeService;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(OrgMembersRepository) orgMembers: OrgMembersRepository,
    @Inject(AccessService) private readonly access: AccessService,
  ) {
    this.provisioner = new OrganizationProvisioner(organizations, orgMembers);
    this.recompute = new ComputedRecomputeService(db, {
      defaultTimeZone: config.defaults.timezone,
    });
  }

  /** Stored settings completed with the instance defaults. */
  settingsOf(settings: JsonValue): OrganizationSettings {
    return {
      locale: stringSetting(settings, 'locale') ?? this.config.defaults.locale,
      timezone: stringSetting(settings, 'timezone') ?? this.config.defaults.timezone,
      currency: stringSetting(settings, 'currency') ?? this.config.defaults.currency,
      public_sharing: publicSharingPolicyOf(settings),
      automation_max_depth: automationMaxDepthOf(settings),
      api_tokens: apiTokenPolicyOf(settings),
    };
  }

  private toDto(organization: Organization, role: OrgRole): OrganizationDto {
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      settings: this.settingsOf(organization.settings),
      role,
      created_at: iso(organization.created_at),
      updated_at: iso(organization.updated_at),
    };
  }

  async list(principal: Principal, query: OffsetQuery): Promise<OrganizationList> {
    const memberships = await this.access.memberships(principal);
    const items = memberships.slice(query.offset, query.offset + query.limit).map((membership) => ({
      id: membership.organizationId,
      name: membership.name,
      slug: membership.slug,
      settings: this.settingsOf(membership.settings),
      role: membership.role,
      created_at: iso(membership.createdAt),
      updated_at: iso(membership.updatedAt),
    }));
    return { items, total: memberships.length, offset: query.offset, limit: query.limit };
  }

  /**
   * `POST /orgs`: only with `ALLOW_ORG_CREATION=true` (SPEC §14.1A); the
   * caller becomes the owner.
   */
  async create(
    principal: Principal,
    input: CreateOrganizationRequest,
    meta: RequestMeta,
  ): Promise<OrganizationDto> {
    if (!this.config.allowOrgCreation) {
      throw permissionDenied(
        'Creating organizations is disabled on this server (ALLOW_ORG_CREATION); use the CLI.',
      );
    }
    const organization = await this.db.withTx((tx) =>
      this.provisioner.create(tx, {
        name: input.name,
        ownerId: principal.userId,
        settings: organizationDefaults(this.config, input),
        context: mutationContextOf(meta, principal.userId),
      }),
    );
    this.access.invalidate(principal);
    return this.toDto(organization, 'owner');
  }

  async get(principal: Principal, organizationId: Id<'org'>): Promise<OrganizationDto> {
    const org = await this.access.requireOrg(principal, organizationId);
    const organization = await this.organizations.findById(organizationId);
    if (organization === undefined) throw notFound();
    return this.toDto(organization, org.role);
  }

  async update(
    principal: Principal,
    organizationId: Id<'org'>,
    input: UpdateOrganizationRequest,
    meta: RequestMeta,
  ): Promise<OrganizationDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const updated = await this.db.withTx(async (tx) => {
      const current = await this.organizations.findById(organizationId, tx);
      if (current === undefined) throw notFound();
      const currentSettings =
        typeof current.settings === 'object' &&
        current.settings !== null &&
        !Array.isArray(current.settings)
          ? current.settings
          : {};
      const definedOf = (value: object) =>
        Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
      const policyBefore = apiTokenPolicyOf(currentSettings);
      const settings: JsonObject | undefined =
        input.settings === undefined
          ? undefined
          : {
              ...currentSettings,
              ...definedOf(input.settings),
              // `api_tokens` keys left out keep their value (CONTRACTS §26.4).
              ...(input.settings.api_tokens === undefined
                ? {}
                : {
                    api_tokens: {
                      ...policyBefore,
                      ...definedOf(input.settings.api_tokens),
                    },
                  }),
            };
      const before: JsonObject = { name: current.name, settings: currentSettings };
      const after: JsonObject = {
        name: input.name ?? current.name,
        settings: settings ?? currentSettings,
      };
      const changes = diffOf(before, after);
      if (Object.keys(changes).length === 0) return current;
      const row = await this.organizations.update(
        organizationId,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(settings === undefined ? {} : { settings }),
        },
        tx,
      );
      if (row === undefined) throw notFound();
      // Formulas compute dates in the organization's zone (ADR-21): stored
      // computed fields using dates are recomputed (T458, job).
      const zone = (value: JsonValue) =>
        stringSetting(value, 'timezone') ?? this.config.defaults.timezone;
      if (zone(current.settings) !== zone(row.settings)) {
        await this.recompute.enqueueTimeZoneChange(tx, organizationId);
      }
      await recordChange(tx, {
        type: 'org.updated',
        organizationId,
        entityType: 'org',
        entityId: organizationId,
        context: mutationContextOf(meta, principal.userId),
        before,
        after,
        changes,
      });
      // Turning tokens off makes every token of the organization `401` (T704):
      // their WebSocket connections close too (T706).
      if (policyBefore.enabled && !apiTokenPolicyOf(row.settings).enabled) {
        await publishApiTokensRevoked(this.db, tx, organizationId);
      }
      return row;
    });
    this.access.invalidate(principal);
    return this.toDto(updated, org.role);
  }
}
