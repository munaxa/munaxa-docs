import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuditSinkService } from './application/audit-sink.service';
import { DefaultWebhookDeliveryService } from './application/webhook-delivery.service';
import { WebhookAdminService } from './application/webhook-admin.service';
import {
  AUDIT_SINK_REPOSITORY,
  AUDIT_SINK_SERVICE,
  WEBHOOK_DELIVERY_SERVICE,
  WEBHOOK_REPOSITORY,
  WEBHOOK_SERVICE,
} from './application/ports';
import { PrismaAuditSinkRepository } from './infrastructure/prisma-audit-sink.repository';
import { PrismaWebhookRepository } from './infrastructure/prisma-webhook.repository';
import { WebhookLaneConsumer } from './infrastructure/webhook-lane.consumer';
import {
  AuditSinkController,
  AuditStreamController,
  WebhookController,
} from './presentation/integration.controller';

/**
 * Integration — How does this tenant connect to other systems?
 *
 * **Owns:** WebhookEndpoint, WebhookDelivery, AuditSink
 * **Depends on:** Audit (for `AUDIT_STREAM_SOURCE`, which Audit implements)
 *
 * ## What this module deliberately does not own
 *
 * **API clients and the identity provider are Identity's.** They look like integration and they
 * are *authentication* — "who is this and what may they do anywhere", which is Identity's own
 * question. An API client resolves to a person and needs `CredentialRepository`; a federated
 * sign-in mints a session and needs `SessionRepository` and the token issuer. Putting them here
 * would mean this module reaching into Identity's tables, which is the sideways call
 * `modules/README.md` exists to prevent, or Identity exporting its credential repository to a
 * module that has no business with it.
 *
 * What is here is what a *system on the other end* needs: outbound events and an audit stream.
 * The permission is shared — `integration:manage` gates all four resources — because they are one
 * administrative surface even though they are two modules' data, and 08 §2's test for a
 * permission is whether it is a decision somebody can be trusted with separately. It is not: whoever
 * may mint a key may mint one bound to an auditor, and whoever may point a webhook at a URL can
 * exfiltrate the same events a sink would carry.
 *
 * ## Why it imports Audit
 *
 * For `AUDIT_STREAM_SOURCE` — declared in this module's `ports.ts`, implemented in Audit, which is
 * Phase 13's shape and for its reason: this module must not hold a handle able to `append` to the
 * hash chain. `AuditModule` exports `AUDIT_REPOSITORY`, so injecting it directly would compile.
 * That is precisely why the port exists rather than a comment saying not to.
 */
@Module({
  imports: [AuditModule],
  controllers: [WebhookController, AuditSinkController, AuditStreamController],
  providers: [
    { provide: WEBHOOK_REPOSITORY, useClass: PrismaWebhookRepository },
    { provide: AUDIT_SINK_REPOSITORY, useClass: PrismaAuditSinkRepository },
    WebhookAdminService,
    { provide: WEBHOOK_SERVICE, useExisting: WebhookAdminService },
    DefaultWebhookDeliveryService,
    { provide: WEBHOOK_DELIVERY_SERVICE, useExisting: DefaultWebhookDeliveryService },
    AuditSinkService,
    { provide: AUDIT_SINK_SERVICE, useExisting: AuditSinkService },
    // The lanes' consumer, declared here rather than in a worker for the reason every consumer
    // since Phase 4 is: `apps/worker` composes none of the domain modules.
    WebhookLaneConsumer,
  ],
  // Nothing is exported. No other module has any business fanning out a webhook or moving an audit
  // cursor, and the two things that reach this module — the outbox dispatcher and the schedule —
  // reach it through the queue rather than through the container.
  exports: [],
})
export class IntegrationModule {}
