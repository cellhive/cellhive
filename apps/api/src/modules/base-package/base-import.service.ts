import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BASE_IMPORT_JOB_TYPE,
  BASE_IMPORT_REQUEST_SCOPES,
  BASE_PACKAGE_EXTENSION,
  BASE_PACKAGE_MEDIA_TYPE,
  BASE_PACKAGE_UPLOAD_FIELD,
  newId,
  PACKAGE_TOO_LARGE,
  type Id,
  type JobAccepted,
} from '@cellhive/contracts';
import {
  AppError,
  basePackageImportKey,
  enqueue,
  JobsRepository,
  withTxScope,
  type AppConfig,
  type Db,
  type OrgScope,
  type StorageDriver,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, permissionDenied } from '../../common/access/access.service.js';
import { requireTokenScopes } from '../../common/auth/scope.guard.js';
import { APP_CONFIG, DB, STORAGE_DRIVER } from '../../common/tokens.js';
import { receiveMultipartFile } from '../import/multipart-upload.js';

import type { Principal } from '../../common/auth/principal.js';
import type { Readable } from 'node:stream';

/** `413` of a package over `BASE_PACKAGE_MAX_BYTES` (CONTRACTS §12.2). */
function packageTooLarge(limit: number): AppError {
  const message = 'The package is larger than the largest package allowed.';
  return new AppError('PAYLOAD_TOO_LARGE', {
    detail: message,
    errors: [
      { path: BASE_PACKAGE_UPLOAD_FIELD, code: PACKAGE_TOO_LARGE, message, params: { limit } },
    ],
  });
}

/** `415` for a file that is not named `*.chbase`, before its content is read. */
function refusedName(filename: string): AppError | null {
  return filename.toLowerCase().endsWith(BASE_PACKAGE_EXTENSION)
    ? null
    : new AppError('UNSUPPORTED_MEDIA_TYPE', {
        detail: `Only ${BASE_PACKAGE_EXTENSION} packages can be imported.`,
      });
}

/**
 * Starts the import of a stored package (CONTRACTS §12.2): its `base.import`
 * job row and the job in one transaction. Shared by the route and the CLI
 * (`cellhive base import`). The package must be stored under
 * `basePackageImportKey(org, jobId)` already; the caller checked the
 * workspace and the permission.
 */
export async function startBaseImport(
  db: Db,
  input: {
    readonly scope: OrgScope;
    readonly jobId: Id<'job'>;
    readonly workspaceId: Id<'wsp'>;
    readonly createdBy: Id<'usr'>;
    readonly apiTokenId?: Id<'tok'>;
  },
): Promise<Id<'job'>> {
  const jobs = new JobsRepository(db);
  return db.withTx(async (tx) => {
    const job = await jobs.create(withTxScope(input.scope, tx), {
      id: input.jobId,
      type: BASE_IMPORT_JOB_TYPE,
      createdBy: input.createdBy,
    });
    await enqueue(tx, 'base.import', {
      organization_id: input.scope.organizationId,
      job_id: job.id,
      workspace_id: input.workspaceId,
      ...(input.apiTokenId === undefined ? {} : { api_token_id: input.apiTokenId }),
    });
    return job.id;
  });
}

/**
 * `POST /workspaces/:id/bases/import` (CONTRACTS §12.2, ADR-24 §3): the
 * right to create a base in the workspace (workspace admin, organization
 * owner/admin). A workspace the caller cannot see is `404` before anything
 * else; an API token also needs `records:write` and `automations:write`
 * besides the route's `schema:write` (`403 INSUFFICIENT_SCOPE` listing those
 * it lacks), and cannot be limited to bases (a new base is outside any
 * `base_ids`); a member who may not create bases gets `403
 * PERMISSION_DENIED`. Only then is the body read: one `file` part named
 * `*.chbase`, at most `BASE_PACKAGE_MAX_BYTES` (`413`), streamed to a
 * temporary file, then to object storage; its content is the job's to
 * check.
 */
@Injectable()
export class BaseImportService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  async start(
    principal: Principal,
    workspaceId: Id<'wsp'>,
    request: { readonly contentType: string | undefined; readonly body: Readable },
  ): Promise<JobAccepted> {
    let scope: OrgScope;
    try {
      const workspace = await this.access.findWorkspace(principal, workspaceId);
      if (workspace === undefined) throw notFound();
      requireTokenScopes(principal, BASE_IMPORT_REQUEST_SCOPES);
      if (!workspace.isAdmin) {
        throw permissionDenied(
          'Only workspace admins and organization owners/admins can import a base.',
        );
      }
      if (principal.kind === 'api_token' && principal.baseIds !== null) {
        throw permissionDenied('An API token limited to some bases cannot import a base.');
      }
      scope = workspace.org.scope;
    } catch (error) {
      request.body.resume();
      throw error;
    }
    const limit = this.config.limits.basePackageMaxBytes;
    const dir = await mkdtemp(join(tmpdir(), 'cellhive-base-upload-'));
    try {
      const file = await receiveMultipartFile(request.body, request.contentType, dir, limit, {
        tooLarge: () => packageTooLarge(limit),
        refuseName: refusedName,
      });
      const jobId = newId('job');
      const key = basePackageImportKey(scope.organizationId, jobId);
      await this.storage.putStream(key, createReadStream(file.path), {
        contentType: BASE_PACKAGE_MEDIA_TYPE,
        contentLength: file.size,
      });
      try {
        await startBaseImport(this.db, {
          scope,
          jobId,
          workspaceId,
          createdBy: principal.userId,
          ...(principal.kind === 'api_token' ? { apiTokenId: principal.tokenId } : {}),
        });
      } catch (error) {
        await this.storage.delete(key);
        throw error;
      }
      return { job_id: jobId };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
