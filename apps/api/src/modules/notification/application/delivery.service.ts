import { Inject, Injectable } from '@nestjs/common';

import {
  type NotificationChannelKey,
  type UserId,
  AuditSubjectType,
  DeliveryState,
  NotificationChannel,
  Permission,
  QueueName,
  Settings,
  asId,
  queueDefinition,
} from '@edms/domain';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import { METRICS, MetricName, type Metrics } from '../../../core/observability/metrics';
import {
  AdministeredWriter,
  AdministrativeOperation,
} from '../../../core/persistence/administered-writer';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { NOTIFICATION_PORT, type NotificationPort } from '../../../ports/notification.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { USER_DIRECTORY, type UserDirectory } from '../../identity/application/ports';
import { NotificationAudit } from '../domain/audit-actions';
import { NotificationType } from '../domain/notification-types';
import {
  NOTIFICATION_MESSAGE_REPOSITORY,
  NOTIFICATION_SUPPRESSION_REPOSITORY,
  NOTIFICATION_SERVICE,
  type NotificationMessageRecord,
  type NotificationMessageRepository,
  type NotificationService,
  type NotificationSuppressionRepository,
} from './notification.ports';

/** How many a single pass takes. Small enough that a failure loses little, large enough to matter. */
const BATCH_SIZE = 50;

/** How many held messages one release pass moves back into the queue. */
const RELEASE_BATCH = 500;

/**
 * How many times one message is attempted before it is left dead — Phase 6.4.
 *
 * 18 §7's provider-outage row asks for "exponential backoff, capped attempts, dead-letter queue
 * with operator visibility", and it was the one row in that table nothing had built: a transient
 * failure wrote `FAILED`, `claimQueued` selects only `QUEUED`, and `DeliveryState.FAILED` was read
 * by no query in the product. A provider unreachable for one minute therefore lost every email
 * queued in that minute, permanently and silently — the in-app copy survived, because that row is
 * its own delivery, which is why the loss was invisible from a screen.
 *
 * A constant rather than a tenant setting, matching the outbox dispatcher's own backoff: how many
 * times to re-dial a mail server is a property of the deployment's plumbing, not a policy a quality
 * manager has an opinion about. The bounce threshold above is a setting because *that* one is a
 * judgement about people's mailboxes.
 *
 * Five attempts over the curve below is a little under half an hour, which outlasts an ordinary
 * provider blip and does not keep a genuinely dead endpoint warm for a working day.
 */
const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Exponential, capped at five minutes — the same shape and the same cap as the outbox dispatcher's,
 * deliberately, so a deployment has one backoff curve to reason about rather than two.
 */
function backoffMs(attempts: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
}

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
 *
 * ## Bounces — §7's row, built here
 *
 * A permanent failure is not merely "do not retry this message". It is evidence about an
 * *address*, and §7 says repeated hard bounces suppress it and alert an administrator. So
 * `deliverOne` records the failure against the address, and the call that crosses the tenant's
 * threshold does three further things in one transaction: it suppresses, it writes
 * `NOTIFICATION_SUPPRESSED` to the trail, and it notifies the administrators.
 *
 * The alert goes out **once**, on the crossing, not on every subsequent bounce — an
 * administrator told forty times about one dead mailbox stops reading the alert, which is the
 * failure §1's fifth principle exists to prevent.
 */
@Injectable()
export class DeliveryService {
  constructor(
    @Inject(NOTIFICATION_MESSAGE_REPOSITORY)
    private readonly messages: NotificationMessageRepository,
    @Inject(NOTIFICATION_SUPPRESSION_REPOSITORY)
    private readonly suppressions: NotificationSuppressionRepository,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationService,
    @Inject(NOTIFICATION_PORT) private readonly transport: NotificationPort,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
    private readonly writer: AdministeredWriter,
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

    const now = this.clock.now();
    // The lane's own job budget as the lease. A pass that dies mid-send — the process killed,
    // the job timed out — leaves its rows held for exactly as long as the job it was running was
    // ever allowed to take, after which they are due again and another pass picks them up.
    const leaseUntil = new Date(
      now.getTime() + queueDefinition(QueueName.NOTIFICATIONS_DELIVER).timeoutMs,
    );
    const claimed = await this.unitOfWork.run(() =>
      this.messages.claimQueued(channel, limit, now, leaseUntil),
    );

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

  /**
   * Moves quiet-hours holds whose window has closed back into the queue.
   *
   * Its own pass rather than a branch of the claim query, because the two are different
   * statements: one selects work and one changes state, and folding the change into the claim
   * would make every delivery pass write to rows it is not going to send.
   */
  releaseHeld(): Promise<number> {
    return this.unitOfWork.run(() => this.messages.releaseHeld(this.clock.now(), RELEASE_BATCH));
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
    // How many attempts this message will have made once this one is recorded. The column has
    // been incremented on every attempt since Phase 12 and, until Phase 6.4, was read by nothing.
    const attempts = message.attempts + 1;
    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
    const retryable = !receipt.accepted && !receipt.permanentFailure && !exhausted;

    const state = receipt.accepted
      ? DeliveryState.SENT
      : receipt.permanentFailure
        ? // A hard bounce is not worth retrying: the address is wrong, and repeating it only
          // damages the sending domain's reputation.
          DeliveryState.SUPPRESSED
        : retryable
          ? // Back into the queue with a future `release_at` — see `retryAt` below.
            DeliveryState.QUEUED
          : DeliveryState.FAILED;

    await this.unitOfWork.run(() =>
      this.messages.recordDelivery(message.id, {
        state,
        failureReason: receipt.failureReason,
        at,
        retryAt: retryable ? new Date(at.getTime() + backoffMs(attempts)) : null,
      }),
    );

    if (!receipt.accepted) {
      this.metrics.increment(MetricName.NOTIFICATION_DELIVERY_FAILURES, {
        channel: message.channel,
        // The label an alert fires on: a transient failure during a provider blip is noise, and a
        // message that has run out of attempts is a notification nobody will ever receive.
        outcome: state === DeliveryState.QUEUED ? 'retrying' : 'terminal',
      });
      // Escalated once the attempts are spent, because the two are different operational facts:
      // one send failed, versus this message is now dead and 18 §8's "never silently dropped" is
      // being honoured only by the row it leaves behind.
      const detail = {
        messageId: message.id,
        channel: message.channel,
        permanent: receipt.permanentFailure,
        attempts,
        willRetry: retryable,
        // The reason, never the address: a log is not the place to accumulate a mailing list.
        reason: receipt.failureReason,
      };
      if (state === DeliveryState.QUEUED) {
        this.logger.warn('Notification delivery failed', detail);
      } else {
        this.logger.error('Notification delivery failed', detail);
      }
    }
    if (receipt.permanentFailure) {
      await this.recordBounce(message.address, receipt.failureReason ?? 'permanent failure', at);
    }
    return receipt.accepted;
  }

  /**
   * One hard bounce, counted against the address — and the suppression when the count crosses.
   *
   * Its own transaction, separate from the one that recorded the delivery, because the two are
   * about different things: what happened to *this message* is a fact whatever the address's
   * history, and a failure to write the suppression must not lose the record of the send.
   */
  private async recordBounce(address: string, reason: string, at: Date): Promise<void> {
    const threshold = await this.settings.get(Settings.NOTIFICATION_BOUNCE_THRESHOLD);

    const outcome = await this.writer.read(() =>
      this.suppressions.recordPermanentFailure(address, reason, threshold, at),
    );
    if (!outcome.crossedThreshold) {
      return;
    }

    const administrators = await this.writer.read(() =>
      this.users.holdersOfPermission(Permission.USER_MANAGE),
    );
    if (administrators.length === 0) {
      // Nobody holds the permission — a tenant mid-provisioning, or one whose only administrator
      // is the address that just bounced. The trail still records it below, which is the point
      // of writing the audit event separately from sending the alert.
      this.logger.warn('An address was suppressed with no administrator to tell', {
        bounceCount: outcome.bounceCount,
      });
    }

    await this.writer.write(async () => {
      await this.notifications.notify({
        // Deterministic, so a redelivered delivery pass that bounces the same address again
        // cannot alert twice for one suppression — and keyed on *this* suppression rather than
        // on the count, which is not an identity. `release` sets the count back to zero, so the
        // next episode crosses the threshold at the same number the last one did: keying on the
        // count made the second suppression of an address collide with the first, and §7's
        // "alert an administrator" was answered by an inbox that already held the old alert.
        // `at` is the instant `recordPermanentFailure` just wrote to `suppressed_at`, and only
        // the caller that crossed the threshold reaches this line, so it names one episode.
        eventId: `suppression:${maskAddress(address)}:${at.toISOString()}`,
        typeKey: NotificationType.SECURITY_ADDRESS_SUPPRESSED.key,
        recipientIds: administrators,
        values: {
          maskedAddress: maskAddress(address),
          bounceCount: String(outcome.bounceCount),
          occurredAt: at.toISOString(),
        },
      });
      return {
        result: undefined,
        change: {
          action: NotificationAudit.SUPPRESSED,
          subjectType: AuditSubjectType.USER,
          // The subject is the *address*, not a user: a mailbox has no identifier of its own in
          // this product, and filing it under whichever person happened to hold it would make
          // "was this address ever suppressed" a question about people instead of about mail.
          subjectId: asId<UserId>(SUPPRESSION_SUBJECT_ID),
          operation: AdministrativeOperation.UPDATED,
          after: {
            address: maskAddress(address),
            bounceCount: outcome.bounceCount,
            threshold,
          },
          reason,
        },
      };
    });
  }
}

/**
 * The subject a suppression is filed against.
 *
 * 13 §2 has no subject type for a mailbox, and adding one for a single action would be a
 * vocabulary change every compliance report has to learn. The nil UUID under `USER` says "a
 * person's contactability, not a particular person" — and the masked address is in the payload,
 * where a filter can find it.
 */
const SUPPRESSION_SUBJECT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * What an alert and a trail entry may say about an address.
 *
 * 13 §3: "personal data in payloads is minimised". An administrator needs to recognise which
 * mailbox stopped working, which the domain and the first character give them; the whole address
 * in an audit payload would make the trail a second copy of the directory.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }
  const local = address.slice(0, at);
  const domain = address.slice(at);
  return `${local.slice(0, 1)}***${domain}`;
}
