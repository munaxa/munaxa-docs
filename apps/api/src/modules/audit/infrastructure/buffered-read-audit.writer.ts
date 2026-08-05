import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { type AnyId, type TenantId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import {
  AUDIT_WRITER,
  type AuditActor,
  type AuditEntry,
  type AuditWriter,
} from '../../../core/audit/audit-writer.port';
import { CURRENT_CHAIN_HASH_VERSION, chainHash } from '../../../core/audit/hash-chain';
import type { ReadAuditBuffer, ReadAuditFlushResult } from '../../../core/audit/read-audit.port';
import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import {
  AUDIT_REPOSITORY,
  type AuditEventRecord,
  type AuditRepository,
} from '../application/ports';

/**
 * Read auditing, buffered — `13-audit-architecture.md` §5, finally true of the code.
 *
 * Until Phase 9 every audited view took `pg_advisory_xact_lock(hashtext(tenant))` inline. With
 * `audit.readEventsAboveRank` defaulting to `0`, that meant *every* view, so page views
 * serialised the tenant's audit writes behind them — a document everybody reads throttles every
 * approval, upload and publication in the same organisation. §5 called for a buffer from the
 * beginning; this is it.
 *
 * Three properties, and each is a rule from §5 or §7 rather than an implementation choice.
 *
 * **Buffered events are still hash-chained.** The flush takes the lock once, reads the tail once,
 * and chains the whole batch in order under it. One hundred views cost one lock rather than a
 * hundred, and the chain cannot tell the difference afterwards.
 *
 * **`occurredAt` is when somebody looked**, captured at `record`, not when the flush ran. The
 * event id is a UUID v7 minted from that instant for the same reason: the trail's ordering must
 * be the reading's ordering, not the buffer's.
 *
 * **Nothing is dropped.** §7 forbids it outright. A failed flush retains its batch and retries;
 * past the hard bound `record` writes synchronously, which is Phase 1's behaviour — slower, never
 * lossy. The only degradation an audit trail may have is to correct-and-slow.
 *
 * The buffer is per process. Two API instances hold two buffers and flush independently, which is
 * safe because the advisory lock is what orders them — the same thing that has ordered every
 * concurrent audit write since Phase 1.
 */
interface BufferedEvent {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly actor: AuditActor;
  readonly entry: AuditEntry;
}

@Injectable()
export class BufferedReadAuditWriter
  implements ReadAuditBuffer, OnApplicationBootstrap, OnApplicationShutdown
{
  /** Keyed by tenant, because a flush is one transaction against one tenant's database. */
  private readonly buffers = new Map<string, BufferedEvent[]>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<ReadAuditFlushResult> | null = null;
  private running = false;

  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository,
    @Inject(AUDIT_WRITER) private readonly writer: AuditWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.schedule();
  }

  /**
   * The last flush, awaited.
   *
   * A shutdown that dropped the buffer would lose exactly the evidence this class exists to
   * keep, and the window is the flush interval — which is precisely the moment a rolling deploy
   * terminates a pod.
   */
  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  get pending(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) {
      total += buffer.length;
    }
    return total;
  }

  async record(actor: AuditActor, entry: AuditEntry): Promise<void> {
    const occurredAt = this.clock.now();
    const buffer = this.buffers.get(actor.tenantId) ?? [];

    if (buffer.length >= this.config.audit.readBufferMax) {
      // The store has been refusing for long enough that holding more would be holding evidence
      // hostage to a memory bound. Back to Phase 1: write it now, inside whatever transaction the
      // caller has, and let the caller wait.
      this.logger.warn('The read-audit buffer is full; writing this view synchronously', {
        tenantId: actor.tenantId,
        pending: buffer.length,
      });
      await this.writer.writeStandalone(actor, entry);
      return;
    }

    buffer.push({
      eventId: uuidv7(occurredAt.getTime()),
      occurredAt,
      actor,
      entry,
    });
    this.buffers.set(actor.tenantId, buffer);

    if (buffer.length >= this.config.audit.readBufferSize) {
      // Fire and forget: the caller asked to have its view recorded, not to wait for the batch
      // its arrival happened to complete. A failure is retained and retried by `flushAll`.
      void this.flush();
    }
  }

  /** One pass over every tenant's buffer. Concurrent calls share the pass rather than racing. */
  async flush(): Promise<ReadAuditFlushResult> {
    this.flushing ??= this.flushAll().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushAll(): Promise<ReadAuditFlushResult> {
    let written = 0;
    const failedTenants: string[] = [];

    for (const [tenantId, buffer] of [...this.buffers.entries()]) {
      if (buffer.length === 0) {
        this.buffers.delete(tenantId);
        continue;
      }
      // Taken, not copied: anything recorded while the flush is in flight lands in a fresh
      // buffer and goes out next time, so a slow flush never re-writes what it already wrote.
      this.buffers.set(tenantId, []);
      try {
        await this.flushTenant(asId<TenantId>(tenantId), buffer);
        written += buffer.length;
      } catch (error) {
        // §5: "a flush failure raises an alert". The batch goes back to the front of the queue,
        // because a read event that was never written is a gap in evidence and §7 forbids one.
        failedTenants.push(tenantId);
        this.buffers.set(tenantId, [...buffer, ...(this.buffers.get(tenantId) ?? [])]);
        this.logger.error('The read-audit buffer could not be flushed', {
          tenantId,
          retained: buffer.length,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    return { written, retained: this.pending, failedTenants };
  }

  /**
   * One tenant's batch: one transaction, one advisory lock, one chained run of appends.
   *
   * The tail is read under the lock exactly as a single write does, so a buffered flush and a
   * synchronous write racing on the same tenant serialise against each other rather than forking
   * the chain.
   */
  private async flushTenant(tenantId: TenantId, batch: readonly BufferedEvent[]): Promise<void> {
    const first = batch[0];
    if (first === undefined) {
      return;
    }
    await runWithContext(contextFor(tenantId, first.actor.correlationId), () =>
      this.unitOfWork.run(async () => {
        const tail = await this.repository.lockAndReadTail();
        let previousHash = tail.hash;
        let sequence = tail.sequence;
        const records: AuditEventRecord[] = [];

        for (const buffered of batch) {
          sequence += 1n;
          const material = {
            eventId: buffered.eventId,
            tenantId,
            sequence,
            occurredAt: buffered.occurredAt,
            actorId: buffered.actor.userId,
            onBehalfOfId: buffered.entry.onBehalfOfId ?? null,
            channel: buffered.actor.channel,
            action: buffered.entry.action,
            subjectType: buffered.entry.subjectType,
            subjectId: buffered.entry.subjectId,
            outcome: buffered.entry.outcome,
            payload: buffered.entry.payload,
            reason: buffered.entry.reason ?? null,
            correlationId: buffered.actor.correlationId,
            ipAddress: buffered.actor.ipAddress,
            userAgent: buffered.actor.userAgent,
          };
          const hash = chainHash(previousHash, material, CURRENT_CHAIN_HASH_VERSION);
          records.push({
            ...material,
            id: asId<AnyId>(buffered.eventId),
            actorId: buffered.actor.userId,
            hash,
            previousHash,
            chainHashVersion: CURRENT_CHAIN_HASH_VERSION,
          });
          previousHash = hash;
        }
        await this.repository.appendMany(records);
      }),
    );
  }

  private schedule(): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.flush()
        .catch(() => undefined)
        .finally(() => {
          this.schedule();
        });
    }, this.config.audit.readFlushIntervalMs);
    // A timer that keeps the process alive is a process an orchestrator reports as hung.
    this.timer.unref();
  }
}

function contextFor(tenantId: TenantId, correlationId: string): RequestContext {
  return {
    tenantId,
    // The flush acts for nobody: each buffered event carries its own actor, and the transaction
    // that writes them is the system's.
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId,
    permissionVersion: 0,
    locale: 'en',
  };
}
