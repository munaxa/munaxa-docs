import { Module } from '@nestjs/common';

/**
 * Notification — Who needs to be told?
 *
 * **Owns:** Template, NotificationMessage, delivery attempts, preferences, digests
 * **Depends on:** Identity
 *
 * Nothing in core. It is the only module that calls `NOTIFICATION_PORT`.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class NotificationModule {}
