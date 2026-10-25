import {
  idOf,
  markNotificationsReadSchema,
  notificationListQuerySchema,
  updateNotificationPreferencesSchema,
  updateNotificationSettingsSchema,
  type Id,
  type MarkNotificationsReadInput,
  type MarkNotificationsReadResult,
  type NotificationListDto,
  type NotificationListQuery,
  type NotificationPreferencesDto,
  type NotificationSettingsDto,
  type NotificationUnreadCountDto,
  type UpdateNotificationPreferencesInput,
  type UpdateNotificationSettingsInput,
} from '@cellhive/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { NotificationService } from './notification.service.js';

const orgIdPipe = new ZodValidationPipe(idOf('org'));
const baseIdPipe = new ZodValidationPipe(idOf('bse'));

/** `/orgs/:orgId/me/notification…` (CONTRACTS §22, BACKLOG T511). */
@Controller('orgs/:orgId/me')
export class NotificationController {
  constructor(@Inject(NotificationService) private readonly service: NotificationService) {}

  @Get('notifications')
  list(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Query(new ZodValidationPipe(notificationListQuerySchema)) query: NotificationListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationListDto> {
    return this.service.list(principal, orgId, query);
  }

  @Get('notifications/unread-count')
  unreadCount(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationUnreadCountDto> {
    return this.service.unreadCount(principal, orgId);
  }

  @Post('notifications/read')
  @HttpCode(200)
  markRead(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(markNotificationsReadSchema)) body: MarkNotificationsReadInput,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MarkNotificationsReadResult> {
    return this.service.markRead(principal, orgId, body);
  }

  @Get('notification-preferences')
  getPreferences(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationPreferencesDto> {
    return this.service.getPreferences(principal, orgId);
  }

  @Put('notification-preferences')
  updatePreferences(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(updateNotificationPreferencesSchema))
    body: UpdateNotificationPreferencesInput,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationPreferencesDto> {
    return this.service.updatePreferences(principal, orgId, body);
  }

  @Get('notification-settings')
  getSettings(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationSettingsDto> {
    return this.service.getSettings(principal, orgId);
  }

  @Put('notification-settings')
  updateSettings(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(updateNotificationSettingsSchema))
    body: UpdateNotificationSettingsInput,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationSettingsDto> {
    return this.service.updateSettings(principal, orgId, body);
  }

  @Put('notification-mutes/bases/:baseId')
  @HttpCode(204)
  mute(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    return this.service.muteBase(principal, orgId, baseId);
  }

  @Delete('notification-mutes/bases/:baseId')
  @HttpCode(204)
  unmute(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    return this.service.unmuteBase(principal, orgId, baseId);
  }
}
