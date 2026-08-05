import { Module } from '@nestjs/common';

import { DocumentModule } from '../document/document.module';
import { IdentityModule } from '../identity/identity.module';
import { LibraryModule } from '../library/library.module';
import { DeliveryService } from './application/delivery.service';
import { DigestService } from './application/digest.service';
import { NotificationAdminService } from './application/notification-admin.service';
import { NotificationEventService } from './application/notification-event.service';
import {
  NOTIFICATION_BATCH_REPOSITORY,
  NOTIFICATION_MESSAGE_REPOSITORY,
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_SERVICE,
  NOTIFICATION_SUPPRESSION_REPOSITORY,
  NOTIFICATION_TEMPLATE_REPOSITORY,
} from './application/notification.ports';
import { DefaultNotificationService } from './application/notification.service';
import { RecipientVisibilityService } from './application/recipient-visibility.service';
import { NotificationLaneConsumer } from './infrastructure/notification-lane.consumer';
import {
  PrismaNotificationBatchRepository,
  PrismaNotificationMessageRepository,
  PrismaNotificationPreferenceRepository,
  PrismaNotificationSuppressionRepository,
  PrismaNotificationTemplateRepository,
} from './infrastructure/prisma-notification.repositories';
import { NotificationAdminController } from './presentation/notification-admin.controller';
import { NotificationController } from './presentation/notification.controller';

/**
 * Notification — Who needs to be told, and how?
 *
 * **Owns:** templates, messages, delivery state, preferences, quiet hours, digests, suppressions
 * **Depends on:** Identity (who to write to and who holds a permission), Document (what a
 * document is called), Library (the ACL resolver's binding)
 *
 * Phase 1 implemented the framework and had no producers — "what exists is the pipeline and its
 * tests". Phase 12 is the phase that calls it: the `notifications.deliver` lane finally has a
 * consumer, the fourteen rows of 18 §4 have catalogue entries, and the four phases that deferred
 * delivery here with the words "the outbox row is the record until a consumer exists" have one.
 *
 * ## What it depends on now, and why each is the narrowest thing that works
 *
 * **Identity** was the only dependency and is still the important one: `USER_DIRECTORY` for an
 * address and a name, and — added by this phase — `holdersOfPermission`, because two of §4's rows
 * are addressed to a *capability* rather than to a person. `USER_SERVICE.subjectsFor` supplies
 * the recipient's own authorisation subject.
 *
 * **Document** supplies a title and a number, through `DOCUMENT_SERVICE` and nothing else. A
 * notification that said "a document changed" without naming it would violate §4's fourth
 * principle, and re-deriving a title from a search index would be reading somebody else's
 * projection.
 *
 * **Library** is imported for its `ACL_RESOLVER` binding, and it is the dependency worth
 * noticing. It is here because a recipient list computed from an event is a set of claims about
 * who may *see* a document, and the resolver is the only thing entitled to check them
 * (`application/recipient-visibility.service.ts` states the whole argument). Nothing in this
 * module touches Library's repositories.
 *
 * Email is not a separate framework. It is the `EMAIL` channel of this one: the same catalogue,
 * the same templates, the same preferences, the same delivery record. A parallel mail subsystem
 * would need its own copy of all four and would drift from them.
 */
@Module({
  imports: [IdentityModule, DocumentModule, LibraryModule],
  controllers: [NotificationController, NotificationAdminController],
  providers: [
    { provide: NOTIFICATION_SERVICE, useClass: DefaultNotificationService },
    { provide: NOTIFICATION_TEMPLATE_REPOSITORY, useClass: PrismaNotificationTemplateRepository },
    { provide: NOTIFICATION_MESSAGE_REPOSITORY, useClass: PrismaNotificationMessageRepository },
    {
      provide: NOTIFICATION_PREFERENCE_REPOSITORY,
      useClass: PrismaNotificationPreferenceRepository,
    },
    {
      provide: NOTIFICATION_SUPPRESSION_REPOSITORY,
      useClass: PrismaNotificationSuppressionRepository,
    },
    { provide: NOTIFICATION_BATCH_REPOSITORY, useClass: PrismaNotificationBatchRepository },
    DeliveryService,
    DigestService,
    NotificationAdminService,
    NotificationEventService,
    RecipientVisibilityService,
    // One consumer per lane. `BullMqAdapter.subscribe` constructs one `Worker` per call, so a
    // second subscriber on `notifications.deliver` would race this one for its jobs — the
    // constraint Phase 11 hit and recorded, which is why all five of this lane's schedules are
    // answered by a single class.
    NotificationLaneConsumer,
  ],
  exports: [NOTIFICATION_SERVICE, DeliveryService, DigestService],
})
export class NotificationModule {}
