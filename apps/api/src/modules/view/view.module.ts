import { Module } from '@nestjs/common';

import { ViewController } from './view.controller.js';
import { ViewService } from './view.service.js';

/** Saved views (SPEC §8, CONTRACTS §15; BACKLOG T301). */
@Module({
  controllers: [ViewController],
  providers: [ViewService],
  exports: [ViewService],
})
export class ViewModule {}
