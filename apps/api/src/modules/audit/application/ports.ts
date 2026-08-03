import type { AnyId, AuditSubjectTypeKey, UserId } from '@edms/domain';
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
  readonly occurredAt: Date;
  readonly actorId: UserId | null;
  readonly action: string;
  readonly subjectType: AuditSubjectTypeKey;
  readonly subjectId: AnyId;
  readonly outcome: string;
  readonly correlationId: string;
  readonly hash: string;
  readonly previousHash: string;
}

export interface AuditRepository {
  append(event: AuditEventRecord): Promise<void>;
  /** The chain's tail, which the next append links to. */
  latestHash(): Promise<string>;
  listForSubject(subjectId: AnyId, page: PageRequest): Promise<Page<AuditEventRecord>>;
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
