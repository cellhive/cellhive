import { httpDeliveryIdSchema, type HttpDeliveryResult, type Id } from '@cellhive/contracts';
import { Controller, Get, Inject, Param } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { HttpDeliveryService } from './http-delivery.service.js';

/** Result of "Send a test" of `http_request` (CONTRACTS §25.5; BACKLOG T606). */
@Controller()
export class HttpDeliveryController {
  constructor(@Inject(HttpDeliveryService) private readonly deliveries: HttpDeliveryService) {}

  @Get('http-deliveries/:deliveryId')
  get(
    @Param('deliveryId', new ZodValidationPipe(httpDeliveryIdSchema)) deliveryId: Id<'hdl'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<HttpDeliveryResult> {
    return this.deliveries.get(principal, deliveryId);
  }
}
