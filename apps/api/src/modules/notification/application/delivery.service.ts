import { Inject, Injectable } from '@nestjs/common';

import { type NotificationChannelKey, DeliveryState, NotificationChannel } from '@edms/domain';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { NOTIFICATION_PORT, type NotificationPort } from '../../../ports/notification.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import {
  NOTIFICATION_MESSAGE_REPOSITORY,
  type NotificationMessageRecord,
  type NotificationMessageRepository,
} from './notification.ports';

/** How many a single pass takes. Small enough that a failure loses little, large enough to matter. */
const BATCH_SIZE = 50;

export interface DeliveryOutcome {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
}

/**
 * Sending what `NotificationService` queued.
 *
 * The split is the point: rendering is this module's job and delivery is the adapter's, which
 * is what lets a tenant change mail providers without re-testing a single template
 * (`docs/architecture/18-notification-architecture.md` §1).
 *
 * Each message is its own transaction. One address that hard-bounces must not roll back the
 * forty-nine that went out, and a batch that fails halfway must not resend the first half.
 *
 * With `MAIL_DRIVER=NONE` the bound adapter refuses every send, naming the variable that would
 * fix it. That is the correct behaviour for an unconfigured deployment and the reason this
 * class needs no special case for one: a refusal is recorded like any other failure, and
 * nothing is silently dropped.
 */
@Injectable()
export class DeliveryService {
  constructor(
    @Inject(NOTIFICATION_MESSAGE_REPOSITORY)
    private readonly messages: NotificationMessageRepository,
    @Inject(NOTIFICATION_PORT) private readonly transport: NotificationPort,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Delivers one batch for a channel.
   *
   * In-app is refused rather than handled: those messages are delivered by being written, and
   * a sender that "delivered" them again would be doing nothing while reporting success.
   */
  async deliverBatch(
    channel: NotificationChannelKey = NotificationChannel.EMAIL,
    limit = BATCH_SIZE,
  ): Promise<DeliveryOutcome> {
    if (channel === NotificationChannel.IN_APP) {
      throw new Error(
        'In-app notifications are delivered when they are written; there is nothing to send.',
      );
    }

    const claimed = await this.unitOfWork.run(() => this.messages.claimQueued(channel, limit));

    let sent = 0;
    let failed = 0;
    for (const message of claimed) {
      const delivered = await this.deliverOne(message);
      if (delivered) {
        sent += 1;
      } else {
        failed += 1;
      }
    }

    return { attempted: claimed.length, sent, failed };
  }

  private async deliverOne(message: NotificationMessageRecord): Promise<boolean> {
    let receipt;
    try {
      receipt = await this.transport.send({
        idempotencyKey: `${message.id}`,
        recipient: { address: message.address, displayName: null, locale: message.locale },
        subject: message.subject,
        bodyText: message.bodyText,
        bodyHtml: message.bodyHtml,
        metadata: { typeKey: message.typeKey },
      });
    } catch (error) {
      // A provider that throws is indistinguishable from one that returns a failure, and both
      // are retryable until the attempt cap. An unconfigured driver lands here.
      receipt = {
        accepted: false,
        providerMessageId: null,
        failureReason: error instanceof Error ? error.message : 'unknown',
        permanentFailure: false,
      };
    }

    const at = this.clock.now();
    const state = receipt.accepted
      ? DeliveryState.SENT
      : receipt.permanentFailure
        ? // A hard bounce is not worth retrying: the address is wrong, and repeating it only
          // damages the sending domain's reputation.
          DeliveryState.SUPPRESSED
        : DeliveryState.FAILED;

    await this.unitOfWork.run(() =>
      this.messages.recordDelivery(message.id, {
        state,
        failureReason: receipt.failureReason,
        at,
      }),
    );

    if (!receipt.accepted) {
      this.logger.warn('Notification delivery failed', {
        messageId: message.id,
        channel: message.channel,
        permanent: receipt.permanentFailure,
        // The reason, never the address: a log is not the place to accumulate a mailing list.
        reason: receipt.failureReason,
      });
    }
    return receipt.accepted;
  }
}
