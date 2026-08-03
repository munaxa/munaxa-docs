import type {
  ActorChannelKey,
  AnyId,
  AuditOutcomeKey,
  AuditSubjectTypeKey,
  TenantId,
  UserId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Append-only and hash-chained.
 *
 * There is no update and no delete on this interface, and the application database role has
 * no `UPDATE` or `DELETE` grant on the table either. Audit outlives its subject: it is never
 * soft-deleted and never purged with the document
 * (`docs/architecture/13-audit-architecture.md`).
 */
export const AUDIT_REPOSITORY = Symbol('AuditRepository');

export interface AuditEventRecord {
  readonly id: AnyId;
  readonly tenantId: TenantId;
  /** Per-tenant, monotonic, gap-free. A hole is a deletion. */
  readonly sequence: bigint;
  readonly occurredAt: Date;
  readonly actorId: UserId | null;
  readonly onBehalfOfId: UserId | null;
  readonly channel: ActorChannelKey;
  readonly action: string;
  readonly subjectType: AuditSubjectTypeKey;
  readonly subjectId: AnyId;
  readonly outcome: AuditOutcomeKey;
  /**
   * Carried on the record because verification recomputes the digest from it. A shape that
   * omitted the payload could store a chain nobody could ever check.
   */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly reason: string | null;
  readonly correlationId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly hash: string;
  readonly previousHash: string;
}

/** Where the chain currently ends, and therefore what the next append must link to. */
export interface ChainTail {
  readonly sequence: bigint;
  readonly hash: string;
}

export interface AuditRepository {
  append(event: AuditEventRecord): Promise<void>;
  /**
   * Takes the per-tenant advisory lock and returns the chain's tail.
   *
   * Locking and reading are one operation because they are one decision: two writers that
   * read the same tail would compute the same `previousHash` and the same sequence, and the
   * unique constraint would turn a silent fork into a failed transaction. The lock is
   * transaction-scoped, so it releases on commit or rollback without anything to remember
   * (`docs/architecture/13-audit-architecture.md` §4).
   */
  lockAndReadTail(): Promise<ChainTail>;
  listForSubject(subjectId: AnyId, page: PageRequest): Promise<Page<AuditEventRecord>>;
  /** Ordered by sequence, so verification sees the chain in the order it was written. */
  listForVerification(from: Date, to: Date): Promise<readonly AuditEventRecord[]>;
}

export const AUDIT_SERVICE = Symbol('AuditService');

export interface AuditService {
  timelineFor(subjectId: AnyId, page: PageRequest): Promise<Page<AuditEventRecord>>;
  /** Daily verification plus external checkpoints; a break is the highest-severity alert. */
  verifyChain(from: Date, to: Date): Promise<{ intact: boolean; brokenAt: string | null }>;
  /** Evidence bundles are large: they stream to storage rather than through a response. */
  requestExport(from: Date, to: Date): Promise<{ jobId: string }>;
}
