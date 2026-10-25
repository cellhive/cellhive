import { idOf, type Id, type JobDto } from '@cellhive/contracts';
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { JobService } from './job.service.js';

import type { FastifyReply } from 'fastify';

const jobIdPipe = new ZodValidationPipe(idOf('job'));

/** Background jobs (CONTRACTS §1.1, §12.2). */
@Controller()
export class JobController {
  constructor(@Inject(JobService) private readonly jobs: JobService) {}

  @Get('jobs/:jobId')
  get(
    @Param('jobId', jobIdPipe) jobId: Id<'job'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<JobDto> {
    return this.jobs.get(principal, jobId);
  }

  /** `download_url` of an export job: checks the caller, then redirects to storage. */
  @Get('files/exports/:jobId')
  async download(
    @Param('jobId', jobIdPipe) jobId: Id<'job'>,
    @CurrentPrincipal() principal: Principal,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const url = await this.jobs.downloadUrl(principal, jobId);
    await reply
      .status(302)
      .header('location', url)
      .header('cache-control', 'private, no-store')
      .send();
  }
}
