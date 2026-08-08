import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import {
  type InboxNotification,
  type InboxQueryParams,
  type NotificationPreference as WirePreference,
  type NotificationTypeDescriptor,
  type QuietHours as WireQuietHours,
  type SavePreferenceBody,
  type SaveQuietHoursBody,
  inboxQuerySchema,
  savePreferenceSchema,
  saveQuietHoursSchema,
} from '@edms/contracts';
import { type NotificationMessageId, type UserId, Permission, asId } from '@edms/domain';
import { normalizePageRequest } from '@edms/utils';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { UnauthenticatedError } from '../../../core/errors/application-errors';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { NOTIFICATION_SERVICE, type NotificationService } from '../application/notification.ports';
import { NotificationAdminService } from '../application/notification-admin.service';

interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * The notification centre, on the API.
 *
 * **Every route here is about the caller's own notifications, and none takes a user identifier.**
 * That absence is the authorisation: there is no subject on the wire for a client to substitute,
 * so "read somebody else's inbox" is not a request this API can express. It is the same
 * enforcement-by-absence the delegation controller uses for its delegator.
 *
 * `notification:manage` gates the controller anyway, and is seeded to **every** role including
 * `GUEST` — which looks like a permission that permits nothing and is not. 15 §5 asserts at boot
 * that every mutating route declares a permission or a stated reason for being public, and these
 * routes are neither public nor gateable on anything that existed: `document:view` was the near
 * miss, and it is wrong, because a person with no document permission still receives the security
 * notifications 18 §4 says they must and would then be unable to read them. The permission's
 * scope is the caller's own inbox, and the absence above is what enforces it.
 *
 * Template editing is deliberately **not** here. It is tenant configuration that changes what
 * everybody is told, so it lives on an administration controller behind `settings:manage`.
 */
@Controller({ path: 'notifications', version: '1' })
@RequirePermission(Permission.NOTIFICATION_MANAGE)
export class NotificationController {
  constructor(
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    private readonly admin: NotificationAdminService,
  ) {}

  @Get()
  async inbox(
    @Query(new ZodValidationPipe(inboxQuerySchema)) query: InboxQueryParams,
  ): Promise<{ data: readonly InboxNotification[]; meta: PageMeta }> {
    const page = await this.unitOfWork.run(() =>
      this.notifications.inbox(this.caller(), {
        ...normalizePageRequest(query),
        unreadOnly: query.unread === 'true',
      }),
    );
    return { data: page.data.map(toInboxNotification), meta: page.meta };
  }

  /**
   * How many are unread.
   *
   * Its own route rather than a field on the list, because it is asked far more often than the
   * list is — every page load — and answering it by fetching a page of notifications would make
   * a count cost a paginated read. What renders it is Phase 13's; this is the endpoint it will
   * call.
   */
  @Get('unread-count')
  async unreadCount(): Promise<{ count: number }> {
    const count = await this.unitOfWork.run(() => this.notifications.unreadCount(this.caller()));
    return { count };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(@Param('id') id: string): Promise<void> {
    await this.unitOfWork.run(() =>
      this.notifications.markRead(asId<NotificationMessageId>(id), this.caller()),
    );
  }

  /**
   * Marks everything read.
   *
   * Scoped to the caller by the same absence as everything else here: the repository's predicate
   * carries the recipient, so there is no request a client can make that clears somebody else's.
   */
  @Post('read-all')
  async markAllRead(): Promise<{ marked: number }> {
    const marked = await this.unitOfWork.run(() => this.notifications.markAllRead(this.caller()));
    return { marked };
  }

  // --- Preferences (18 §5) ---------------------------------------------------------------------

  /**
   * The catalogue and what this person has chosen from it, in one response.
   *
   * One call rather than two, because a preference screen cannot render either half alone: a
   * stored channel list means nothing without the type it belongs to, and a type means nothing
   * without knowing whether it may be silenced.
   */
  @Get('preferences')
  async preferences(): Promise<{
    readonly types: readonly NotificationTypeDescriptor[];
    readonly preferences: readonly WirePreference[];
    readonly quietHours: WireQuietHours | null;
  }> {
    const caller = this.caller();
    const [types, stored, quietHours] = await Promise.all([
      this.admin.describeTypes(),
      this.admin.listPreferences(caller),
      this.admin.findQuietHours(caller),
    ]);

    return {
      types: types.map((descriptor) => ({
        key: descriptor.definition.key,
        mandatory: descriptor.definition.mandatory,
        digestible: descriptor.definition.digestible,
        urgency: descriptor.definition.urgency,
        defaultChannels: [...descriptor.definition.defaultChannels],
        availableChannels: [...descriptor.availableChannels],
      })),
      preferences: stored.map((preference) => ({
        typeKey: preference.typeKey,
        channels: [...preference.channels],
        digest: preference.digest,
      })),
      quietHours,
    };
  }

  @Put('preferences/:typeKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  async savePreference(
    @Param('typeKey') typeKey: string,
    @Body(new ZodValidationPipe(savePreferenceSchema)) body: SavePreferenceBody,
  ): Promise<void> {
    await this.admin.savePreference(this.caller(), typeKey, {
      channels: body.channels,
      digest: body.digest,
    });
  }

  /** Returns a type to its defaults by removing the row, rather than storing "the defaults". */
  @Delete('preferences/:typeKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearPreference(@Param('typeKey') typeKey: string): Promise<void> {
    await this.admin.clearPreference(this.caller(), typeKey);
  }

  @Put('quiet-hours')
  @HttpCode(HttpStatus.NO_CONTENT)
  async saveQuietHours(
    @Body(new ZodValidationPipe(saveQuietHoursSchema)) body: SaveQuietHoursBody,
  ): Promise<void> {
    await this.admin.saveQuietHours(this.caller(), body);
  }

  @Delete('quiet-hours')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearQuietHours(): Promise<void> {
    await this.admin.saveQuietHours(this.caller(), null);
  }

  /**
   * Who is asking.
   *
   * From the request context, never from the wire. A route that accepted a user identifier here
   * would be a route by which anybody could read anybody's inbox, and no permission check would
   * make that safe — which is why the identifier is absent rather than guarded.
   */
  private caller(): UserId {
    const { userId } = requireContext();
    if (userId === null) {
      throw new UnauthenticatedError('This request has no user behind it.');
    }
    return userId;
  }
}

function toInboxNotification(record: {
  id: string;
  typeKey: string;
  subject: string;
  bodyText: string;
  createdAt: Date;
  readAt: Date | null;
}): InboxNotification {
  return {
    id: record.id,
    typeKey: record.typeKey,
    subject: record.subject,
    // The text body, never the HTML one. An in-app notification is rendered inside the product's
    // own shell, and handing a client a blob of provider-shaped HTML to inject would be handing
    // it an XSS vector for the sake of a paragraph tag.
    body: record.bodyText,
    createdAt: record.createdAt.toISOString(),
    readAt: record.readAt?.toISOString() ?? null,
  };
}
