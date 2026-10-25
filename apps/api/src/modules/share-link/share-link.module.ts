import { Module } from '@nestjs/common';

import { ShareLinkResolver } from './share-link-resolver.service.js';
import { ShareLinkController } from './share-link.controller.js';
import { ShareLinkService } from './share-link.service.js';

/**
 * Share links (SPEC §15A, CONTRACTS §16; BACKLOG T304): management API and
 * `ShareLinkResolver`, which the public share endpoints (T305/T306) use to
 * turn a token into the link's effective access.
 */
@Module({
  controllers: [ShareLinkController],
  providers: [ShareLinkService, ShareLinkResolver],
  exports: [ShareLinkResolver],
})
export class ShareLinkModule {}
