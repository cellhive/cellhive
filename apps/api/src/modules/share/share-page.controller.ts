import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';

import { Public } from '../../common/auth/principal.js';

import { SharePageService } from './share-page.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * `GET /shares/:token/page` (BACKLOG T809): asked by nginx (and `vite
 * preview`) for `/s/{token}?embed=1`. An empty `text/html` answer whose
 * headers are those of the page, with `X-Accel-Redirect` to the internal
 * location serving `share.html` (`infra/docker/web/default.conf.template`).
 */
@Controller('shares/:token')
@Public()
export class SharePageController {
  constructor(@Inject(SharePageService) private readonly pages: SharePageService) {}

  @Get('page')
  async page(
    @Param('token') token: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const headers = await this.pages.headers(token, request);
    // helmet's defaults are replaced, not merged.
    reply.removeHeader('x-frame-options');
    await reply
      .headers({ ...headers, 'content-type': 'text/html; charset=utf-8' })
      .status(200)
      .send('');
  }
}
