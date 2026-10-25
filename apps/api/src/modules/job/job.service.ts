import { IMPORT_JOB_TYPE } from '@cellhive/contracts';
import {
  AUDIT_BASE_EXPORT_JOB_TYPE,
  AUDIT_EXPORT_JOB_TYPE,
  AUDIT_EXPORT_JOB_TYPES,
  AuditLogsRepository,
  auditExportKey,
  importReportKey,
  JobsRepository,
  type JobRecord,
  type JsonValue,
  type OrgScope,
  type StorageDriver,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound } from '../../common/access/access.service.js';
import { STORAGE_DRIVER } from '../../common/tokens.js';

import type { ApiTokenPrincipal, Principal } from '../../common/auth/principal.js';
import type { Id, JobDto } from '@cellhive/contracts';

/** Lifetime of the storage URL a download redirects to (SPEC §16: 60 seconds). */
export const EXPORT_REDIRECT_SECONDS = 60;

/** Jobs whose result links a file: its storage key and download name. */
const DOWNLOADS: Readonly<
  Record<string, { key: (org: Id<'org'>, job: Id<'job'>) => string; name: string }>
> = {
  [AUDIT_EXPORT_JOB_TYPE]: { key: auditExportKey, name: 'audit-log' },
  [AUDIT_BASE_EXPORT_JOB_TYPE]: { key: auditExportKey, name: 'audit-log' },
  [IMPORT_JOB_TYPE]: { key: importReportKey, name: 'import-errors' },
};

function objectOf(value: JsonValue | null): Record<string, JsonValue> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

export function jobDtoOf(job: JobRecord): JobDto {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    result: objectOf(job.result),
    error: objectOf(job.error),
    created_at: job.created_at.toISOString(),
    started_at: job.started_at?.toISOString() ?? null,
    finished_at: job.finished_at?.toISOString() ?? null,
  };
}

/**
 * Whether the caller may see `job` of an organization they belong to.
 * Audit exports hold the organization's audit log: only current
 * owners/admins see them, the creator included only while still one.
 * Other jobs: their creator and the organization's owners/admins — for a
 * base's audit export (`audit.base_export`), `JobService` also requires
 * the creator to still be an admin of that base.
 */
export function jobVisibleTo(
  job: Pick<JobRecord, 'type' | 'created_by'>,
  userId: Id<'usr'>,
  isOrgAdmin: boolean,
): boolean {
  if (isOrgAdmin) return true;
  if (job.type === AUDIT_EXPORT_JOB_TYPE) return false;
  return job.created_by === userId;
}

/** Whether `type` is an audit log export (organization or base): never for API tokens. */
function isAuditExport(type: string): boolean {
  return AUDIT_EXPORT_JOB_TYPES.includes(type);
}

/**
 * `GET /jobs/:id` and export downloads (CONTRACTS §12.2). A job is visible
 * as `jobVisibleTo` says; anyone else gets `404`, exactly like for a job
 * that does not exist.
 */
@Injectable()
export class JobService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(AuditLogsRepository) private readonly logs: AuditLogsRepository,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  async get(principal: Principal, jobId: Id<'job'>): Promise<JobDto> {
    return jobDtoOf((await this.visibleJob(principal, jobId)).job);
  }

  /**
   * A short-lived signed URL of the file of a succeeded export job (or the
   * error report of an import, CONTRACTS §19), while `result.expires_at`
   * has not passed; `404` otherwise.
   */
  async downloadUrl(principal: Principal, jobId: Id<'job'>, now = new Date()): Promise<string> {
    const { job, organizationId } = await this.visibleJob(principal, jobId);
    // The error report of an import holds values of the file: its importer only (T320).
    if (job.type === IMPORT_JOB_TYPE && job.created_by !== principal.userId) throw notFound();
    const result = objectOf(job.result);
    const expiresAt = typeof result?.expires_at === 'string' ? Date.parse(result.expires_at) : NaN;
    const file = DOWNLOADS[job.type];
    if (
      file === undefined ||
      typeof result?.download_url !== 'string' ||
      job.status !== 'succeeded' ||
      Number.isNaN(expiresAt) ||
      expiresAt <= now.getTime()
    ) {
      throw notFound();
    }
    const signed = await this.storage.presignGet(file.key(organizationId, job.id), {
      filename: `${file.name}-${job.created_at.toISOString().slice(0, 10)}.csv`,
      expiresIn: EXPORT_REDIRECT_SECONDS,
    });
    return signed.url;
  }

  /**
   * An API token (ADR-36 §1, BACKLOG T704) sees only its own user's jobs
   * ("`GET /jobs/:id` of mine", whatever the user's organization role),
   * never an audit export (the audit routes are session only), and only
   * jobs of a base it can reach: a job tied to a base outside `base_ids`
   * (or one the user cannot open) is `404`, and so is a job tied to no
   * base when the token is limited to bases.
   */
  private async requireTokenReach(
    principal: ApiTokenPrincipal,
    scope: OrgScope,
    job: JobRecord,
  ): Promise<void> {
    if (job.created_by !== principal.userId || isAuditExport(job.type)) {
      throw notFound();
    }
    const baseId = await this.jobs.baseIdOf(scope, job.id);
    if (baseId === null) {
      if (principal.baseIds !== null) throw notFound();
      return;
    }
    if ((await this.access.findBase(principal, baseId)) === undefined) throw notFound();
  }

  /**
   * A base's audit export (T709) holds that base's audit log: besides
   * organization owners/admins, only its creator while still an admin of
   * the base sees it (like an organization export and org admins).
   */
  private async requireExportedBaseAdmin(
    principal: Principal,
    scope: OrgScope,
    job: JobRecord,
  ): Promise<void> {
    const baseId = await this.logs.exportedBaseOf(scope, job.id);
    const base = baseId === null ? undefined : await this.access.findBase(principal, baseId);
    if (base?.access.is_admin !== true) throw notFound();
  }

  private async visibleJob(
    principal: Principal,
    jobId: Id<'job'>,
  ): Promise<{ job: JobRecord; organizationId: Id<'org'> }> {
    for (const membership of await this.access.memberships(principal)) {
      const org = await this.access.findOrg(principal, membership.organizationId);
      if (org === undefined) continue;
      const job = await this.jobs.getById(org.scope, jobId);
      if (job === undefined) continue;
      if (!jobVisibleTo(job, principal.userId, org.isAdmin)) throw notFound();
      if (principal.kind === 'api_token') await this.requireTokenReach(principal, org.scope, job);
      if (job.type === AUDIT_BASE_EXPORT_JOB_TYPE && !org.isAdmin) {
        await this.requireExportedBaseAdmin(principal, org.scope, job);
      }
      return { job, organizationId: org.organizationId };
    }
    throw notFound();
  }
}
