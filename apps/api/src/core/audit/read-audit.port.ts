import type { AuditActor, AuditEntry } from './audit-writer.port';

/**
 * Read auditing — the one exception to synchronous writing.
 *
 * `13-audit-architecture.md` §5 states it plainly: `VIEWED` "is buffered and flushed in
 * batches, because it must not cost a transaction per page view". Until Phase 9 it was not —
 * every audited view took `pg_advisory_xact_lock(hashtext(tenant))` inline, which meant page
 * views serialised that tenant's audit writes behind them, and `audit.readEventsAboveRank`
 * defaults to `0`, so *every* view was audited. A trail that costs a lock per page turn is a
 * trail somebody eventually turns off.
 *
 * Buffered events are still hash-chained — the flush computes the digests in order under one
 * lock — and §5's other two requirements are what shape this port:
 *
 * **A flush failure raises an alert.** It never disappears. The batch is retained and retried,
 * and `audit.chain-broken`'s sibling event carries the count of what is waiting.
 *
 * **A dropped event is an unnoticed gap in evidence** (§7). So there is no drop: when the
 * buffer is past its hard bound — a store that has been refusing writes for long enough —
 * `record` writes synchronously instead, which is Phase 1's behaviour and is slower rather
 * than lossy. Degrading to correct-and-slow is the only degradation an audit trail may have.
 *
 * `record` is awaited by its caller for exactly that reason: in the normal case it enqueues
 * and returns, and in the degraded case the caller's transaction is still open to write into.
 */
export const READ_AUDIT_BUFFER = Symbol('ReadAuditBuffer');

export interface ReadAuditBuffer {
  /**
   * Buffers one read event. Resolves as soon as it is held, not when it is durable.
   *
   * The instant is captured here rather than at flush: `occurredAt` is when somebody looked,
   * and a flush interval later is a different fact.
   */
  record(actor: AuditActor, entry: AuditEntry): Promise<void>;
  /** Writes everything held, chained, one transaction per tenant. Returns what it managed. */
  flush(): Promise<ReadAuditFlushResult>;
  /** How many events are waiting. Read by the health surface and by the flush's own alert. */
  readonly pending: number;
}

export interface ReadAuditFlushResult {
  readonly written: number;
  /** Retained for the next attempt — never discarded. */
  readonly retained: number;
  readonly failedTenants: readonly string[];
}
