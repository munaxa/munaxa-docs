import { Inject, Injectable } from '@nestjs/common';

import type { UserId } from '@edms/domain';

import type { DashboardNotificationMetrics } from '../../dashboard/application/ports';
import { NOTIFICATION_SERVICE, type NotificationService } from '../application/notification.ports';

/**
 * Phase 12's badge, answered by the module that owns the inbox.
 *
 * Phase 12 recorded "no unread badge anywhere but the notification screen" as a limit and noted
 * that `GET /notifications/unread-count` exists precisely so a badge has something to call. This
 * discharges it, through the same service that endpoint calls rather than through the endpoint:
 * the dashboard composes server-side, and reaching its own API over HTTP to render one number would
 * be a round trip through the whole guard chain to arrive at a provider already in this container.
 *
 * The recipient is a parameter here because the composing service names whose dashboard it is
 * building — but nothing upstream can name anybody else: the controller reads the caller from the
 * request context, and there is no dashboard route that takes a user identifier, which is the same
 * enforcement-by-absence `/notifications` itself uses.
 */
@Injectable()
export class NotificationDashboardMetrics implements DashboardNotificationMetrics {
  constructor(@Inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationService) {}

  async unreadCount(userId: UserId): Promise<number> {
    return this.notifications.unreadCount(userId);
  }
}
