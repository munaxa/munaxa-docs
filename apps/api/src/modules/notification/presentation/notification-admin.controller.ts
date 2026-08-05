import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import {
  type NotificationTemplateOverride,
  type NotificationTypeDescriptor,
  type SaveTemplateBody,
  type SuppressedAddress,
  saveTemplateSchema,
} from '@edms/contracts';
import { type NotificationChannelKey, Permission } from '@edms/domain';
import { normalizePageRequest } from '@edms/utils';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { NotFoundError } from '../../../core/errors/application-errors';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { maskAddress } from '../application/delivery.service';
import { NotificationAdminService } from '../application/notification-admin.service';

interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * Notification configuration, on the API — the half of this module that is *not* the caller's own.
 *
 * Gated on `settings:manage`, and on a separate controller from the notification centre for a
 * reason stronger than tidiness: everything here changes what **everybody in the tenant** is
 * told. A template edit reaches every recipient of that type; lifting a suppression resumes mail
 * to an address the product decided to stop writing to. Putting either beside "mark my
 * notification read" would have made the permission the only thing distinguishing them, and a
 * permission is a check somebody can forget to add.
 *
 * Template editing is what the brief calls "configurable templates", and the shipped template is
 * served beside the override so an editor starts from the product's own words rather than from an
 * empty box — which is what makes an override a *change* rather than a rewrite.
 */
@Controller({ path: 'admin/notifications', version: '1' })
@RequirePermission(Permission.SETTINGS_MANAGE)
export class NotificationAdminController {
  constructor(private readonly admin: NotificationAdminService) {}

  /** The catalogue, so an editor can only name a type and channel that exist. */
  @Get('types')
  async types(): Promise<{ data: readonly NotificationTypeDescriptor[] }> {
    const types = await this.admin.describeTypes();
    return {
      data: types.map((descriptor) => ({
        key: descriptor.definition.key,
        mandatory: descriptor.definition.mandatory,
        digestible: descriptor.definition.digestible,
        urgency: descriptor.definition.urgency,
        defaultChannels: [...descriptor.definition.defaultChannels],
        availableChannels: [...descriptor.availableChannels],
      })),
    };
  }

  @Get('templates')
  async templates(): Promise<{ data: readonly NotificationTemplateOverride[] }> {
    const overrides = await this.admin.listTemplates();
    return {
      data: overrides.map((override) => ({
        typeKey: override.typeKey,
        channel: override.channel,
        locale: override.locale,
        subject: override.subject,
        bodyText: override.bodyText,
        bodyHtml: override.bodyHtml,
        updatedAt: override.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * The template the product ships for one `(type, channel, locale)`.
   *
   * Not an override, and deliberately not merged with one: an editor needs to see what it would
   * be replacing, and a response that silently returned the override where one exists would make
   * "reset to the shipped wording" impossible to render.
   */
  @Get('templates/:typeKey/:channel/:locale')
  shipped(
    @Param('typeKey') typeKey: string,
    @Param('channel') channel: string,
    @Param('locale') locale: string,
  ): { subject: string; bodyText: string; bodyHtml: string | null } {
    const template = this.admin.shipped(typeKey, channel as NotificationChannelKey, locale);
    if (template === null) {
      throw new NotFoundError('That notification template');
    }
    return template;
  }

  @Put('templates/:typeKey/:channel/:locale')
  @HttpCode(HttpStatus.NO_CONTENT)
  async saveTemplate(
    @Param('typeKey') typeKey: string,
    @Param('channel') channel: string,
    @Param('locale') locale: string,
    @Body(new ZodValidationPipe(saveTemplateSchema)) body: SaveTemplateBody,
  ): Promise<void> {
    await this.admin.saveTemplate(typeKey, channel as NotificationChannelKey, locale, body);
  }

  /** Removing the override *is* the reset: the shipped template applies again. */
  @Delete('templates/:typeKey/:channel/:locale')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTemplate(
    @Param('typeKey') typeKey: string,
    @Param('channel') channel: string,
    @Param('locale') locale: string,
  ): Promise<void> {
    const removed = await this.admin.deleteTemplate(
      typeKey,
      channel as NotificationChannelKey,
      locale,
    );
    if (!removed) {
      throw new NotFoundError('That notification template override');
    }
  }

  // --- Suppressed addresses (18 §7) --------------------------------------------------------------

  /**
   * The addresses this tenant has stopped writing to.
   *
   * Masked on the wire for the same reason they are masked in the trail: an administrator needs
   * to recognise which mailbox stopped working, and a list of whole addresses served over an API
   * is a copy of the directory with an easier query.
   */
  @Get('suppressions')
  async suppressions(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<{ data: readonly SuppressedAddress[]; meta: PageMeta }> {
    const result = await this.admin.listSuppressed(
      normalizePageRequest({ page: Number(page), pageSize: Number(pageSize) }),
    );
    return {
      data: result.data.map((record) => ({
        address: maskAddress(record.address),
        bounceCount: record.bounceCount,
        suppressedAt: record.suppressedAt?.toISOString() ?? null,
        lastReason: record.lastReason,
      })),
      meta: result.meta,
    };
  }

  /**
   * Lifts a suppression.
   *
   * The whole address, not the masked one: this is the one operation that has to name a specific
   * mailbox, and it comes from an administrator who already knows which one they corrected. The
   * list above deliberately cannot supply it, so lifting a suppression is an act somebody
   * performs knowingly rather than by clicking the row.
   */
  @Post('suppressions/release')
  @HttpCode(HttpStatus.NO_CONTENT)
  async release(@Body('address') address: string): Promise<void> {
    const released = await this.admin.releaseSuppression(address ?? '');
    if (!released) {
      throw new NotFoundError('That suppressed address');
    }
  }
}
