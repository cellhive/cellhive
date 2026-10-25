import { Module } from '@nestjs/common';

import { HttpDeliveryController } from './http-delivery.controller.js';
import { HttpDeliveryService } from './http-delivery.service.js';

/** Results of "Send a test" of `http_request` (BACKLOG T606, CONTRACTS §25.5). */
@Module({
  controllers: [HttpDeliveryController],
  providers: [HttpDeliveryService],
})
export class HttpDeliveryModule {}
