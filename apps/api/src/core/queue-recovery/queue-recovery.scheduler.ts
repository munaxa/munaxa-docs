import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { QUEUE_RECOVERY, type QueueRecovery } from '../../ports/queue.port';
import { APP_CONFIG, type AppConfig } from '../config';
import { LOGGER, type Logger } from '../observability/logger';
import { QueueRecoveryRegistry } from './queue-recovery.registry';

/** What one pass did. `ran` is false when the broker was intact and no sweep was due. */
export interface QueueRecoveryOutcome {
  readonly ran: boolean;
  readonly brokerWasIntact: boolean;
  readonly schedulesRedeclared: number;
  readonly rearmed: Readonly<Record<string, number>>;
}

/**
 * Puts back what Redis lost, from what PostgreSQL and the schedule catalogue hold — RC validation,
 * D-13.
 *
 * `docs/operations/backup-and-restore.md` §1 says Redis is not backed up "because nothing in it is a
 * record", and two things in it were: every lane's cron schedule, declared once at boot, and the
 * delayed job behind every workflow timer. Flush Redis, or fail over to an empty replica, and the
 * schedules stayed gone until somebody restarted the API — while a timer's row sat `SCHEDULED` past
 * its `fire_at` for ever, restart or not, and the escalation it stood for never happened.
 *
 * ## A loop in the process, not a job in the broker
 *
 * For the reason `OutboxDispatchScheduler` gives: the thing that notices the broker lost its jobs
 * cannot itself be a job in that broker. It runs where the lanes are consumed, measured from the end
 * of each pass so passes never overlap, and a failed pass never stops it.
 *
 * ## What triggers a rebuild
 *
 * - **Boot.** The first pass always rebuilds, so a process started against an empty Redis re-arms
 *   everything without waiting.
 * - **A missing marker.** The broker holds one key that says it has been rebuilt; a flush or an
 *   empty replica takes it with everything else, and its absence is how a loss is noticed without a
 *   restart — one `EXISTS` per interval.
 * - **The sweep.** Unconditionally, every `QUEUE_RECOVERY_SWEEP_INTERVAL_MS`, for the loss the
 *   marker cannot see: one evicted job rather than a flushed database.
 *
 * ## Why two processes doing it at once is safe
 *
 * Nothing here is a lock, and nothing needs one. A schedule is upserted by name, so two processes
 * re-declaring it leave one. A timer is re-armed under its row's own `job_id`, which the broker
 * de-duplicates while the job exists; and if two jobs for one timer ever did exist, firing is a
 * conditional `SCHEDULED → FIRED` claim under the instance lock, so the second finds nothing to do.
 * The marker is written only after every participant succeeded, so a pass that failed half-way is
 * repeated rather than believed.
 */
@Injectable()
export class QueueRecoveryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastSweepAt: number | null = null;

  constructor(
    @Inject(QUEUE_RECOVERY) private readonly recovery: QueueRecovery,
    private readonly registry: QueueRecoveryRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.queue.consumersEnabled) {
      // The process that consumes the lanes is the one that keeps them fed, exactly as the outbox
      // is dispatched only where it is consumed.
      this.logger.info('Queue state is not rebuilt by this process');
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  onApplicationShutdown(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One pass, exposed so a test — or an operator's console — can drive it without an interval. */
  async pass(options: { force?: boolean } = {}): Promise<QueueRecoveryOutcome> {
    const now = Date.now();
    const sweepDue =
      this.lastSweepAt === null ||
      now - this.lastSweepAt >= this.config.queue.recoverySweepIntervalMs;
    const brokerWasIntact = await this.recovery.brokerIntact();
    if (brokerWasIntact && !sweepDue && options.force !== true) {
      return { ran: false, brokerWasIntact, schedulesRedeclared: 0, rearmed: {} };
    }

    const schedulesRedeclared = await this.recovery.redeclareSchedules();
    const rearmed: Record<string, number> = {};
    for (const participant of this.registry.participants()) {
      rearmed[participant.name] = await participant.recover();
    }
    await this.recovery.markBrokerIntact();
    this.lastSweepAt = now;

    const facts = { schedulesRedeclared, ...rearmed };
    if (brokerWasIntact) {
      this.logger.debug('Queue state re-asserted', facts);
    } else {
      // Worth an operator's attention: something emptied Redis, and this is what was put back.
      this.logger.warn('Queue state rebuilt from durable state after the broker lost it', facts);
    }
    return { ran: true, brokerWasIntact, schedulesRedeclared, rearmed };
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.pass()
        .catch((error: unknown) => {
          this.logger.error('A queue recovery pass failed; it will be retried', {
            reason: error instanceof Error ? error.message : 'unknown',
          });
        })
        .finally(() => {
          this.schedule(this.config.queue.recoveryIntervalMs);
        });
    }, delayMs);
    // Like the outbox loop: a timer that keeps the process alive is a pod that will not stop.
    this.timer.unref();
  }
}
