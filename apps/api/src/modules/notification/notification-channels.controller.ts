import {
  idOf,
  updateOrgNotificationChannelsSchema,
  type Id,
  type OrgNotificationChannelsDto,
  type TelegramLinkDto,
  type UpdateOrgNotificationChannelsInput,
  type UserChannelListDto,
} from '@cellhive/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { NotificationChannelsService } from './notification-channels.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));

/**
 * Notification channels (CONTRACTS §22.7, BACKLOG T549): the organization's
 * notification bot (owner/admin) and the caller's own personal channels.
 */
@Controller('orgs/:orgId')
export class NotificationChannelsController {
  constructor(
    @Inject(NotificationChannelsService) private readonly service: NotificationChannelsService,
  ) {}

  @Get('notification-channels')
  getOrgChannels(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrgNotificationChannelsDto> {
    return this.service.getOrgChannels(principal, orgId);
  }

  @Patch('notification-channels')
  updateOrgChannels(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(updateOrgNotificationChannelsSchema))
    body: UpdateOrgNotificationChannelsInput,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<OrgNotificationChannelsDto> {
    return this.service.updateOrgChannels(principal, orgId, body, requestMetaOf(request));
  }

  @Get('me/channels')
  listMine(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<UserChannelListDto> {
    return this.service.listMine(principal, orgId);
  }

  @Post('me/channels/telegram')
  @HttpCode(201)
  createTelegramLink(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TelegramLinkDto> {
    return this.service.createTelegramLink(principal, orgId);
  }

  @Delete('me/channels/telegram')
  @HttpCode(204)
  async unlinkTelegram(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.service.unlinkTelegram(principal, orgId, requestMetaOf(request));
  }
}
