import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { DeliveryService } from './application/delivery.service';
import {
  NOTIFICATION_MESSAGE_REPOSITORY,
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_SERVICE,
  NOTIFICATION_TEMPLATE_REPOSITORY,
} from './application/notification.ports';
import { DefaultNotificationService } from './application/notification.service';
import {
  PrismaNotificationMessageRepository,
  PrismaNotificationPreferenceRepository,
  PrismaNotificationTemplateRepository,
} from './infrastructure/prisma-notification.repositories';

/**
 * Notification — Who needs to be told, and how?
 *
 * **Owns:** templates, messages, delivery state, preferences
 * **Depends on:** Identity — for who to write to, through `USER_DIRECTORY` and nothing else
 *
 * Phase 1 implements the framework: the type catalogue, the logic-free renderer, preference
 * resolution, message persistence and the sender. There are no producers yet — the events that
 * raise notifications belong to the phases that raise them — so what exists is the machinery
 * and its tests, in the same way Phase 0.5 shipped ports before their consumers.
 *
 * Email is not a separate framework. It is the `EMAIL` channel of this one: the same catalogue,
 * the same templates, the same preferences, the same delivery record. A parallel mail subsystem
 * would need its own copy of all four and would drift from them.
 */
@Module({
  imports: [IdentityModule],
  providers: [
    { provide: NOTIFICATION_SERVICE, useClass: DefaultNotificationService },
    { provide: NOTIFICATION_TEMPLATE_REPOSITORY, useClass: PrismaNotificationTemplateRepository },
    { provide: NOTIFICATION_MESSAGE_REPOSITORY, useClass: PrismaNotificationMessageRepository },
    {
      provide: NOTIFICATION_PREFERENCE_REPOSITORY,
      useClass: PrismaNotificationPreferenceRepository,
    },
    DeliveryService,
  ],
  exports: [NOTIFICATION_SERVICE, DeliveryService],
})
export class NotificationModule {}
