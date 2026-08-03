import type {
  DispositionKey,
  DocumentId,
  LegalHoldId,
  RetentionScheduleStateKey,
  UserId,
} from '@edms/domain';

/**
 * Nothing is destroyed by a user action.
 *
 * Purge is the only path that removes data, it runs only from a policy, only when no legal
 * hold exists, and it never removes the audit trail or the document number
 * (`docs/architecture/adr/0010-soft-delete-and-retention.md`).
 */
export const RETENTION_SCHEDULE_REPOSITORY = Symbol('RetentionScheduleRepository');
export const LEGAL_HOLD_REPOSITORY = Symbol('LegalHoldRepository');

export interface RetentionScheduleRecord {
  readonly documentId: DocumentId;
  readonly triggerAt: Date;
  readonly dueAt: Date;
  readonly disposition: DispositionKey;
  readonly state: RetentionScheduleStateKey;
}

export interface RetentionScheduleRepository {
  findForDocument(documentId: DocumentId): Promise<RetentionScheduleRecord | null>;
  /** Served by a partial index on pending rows; the run is tenant-partitioned. */
  listDue(at: Date, limit: number): Promise<readonly RetentionScheduleRecord[]>;
  save(schedule: RetentionScheduleRecord): Promise<void>;
}

export interface LegalHoldRecord {
  readonly id: LegalHoldId;
  readonly documentId: DocumentId;
  readonly reason: string;
  readonly placedBy: UserId;
  readonly placedAt: Date;
  readonly releasedAt: Date | null;
}

export interface LegalHoldRepository {
  /** Any live hold blocks disposition, whatever the policy says. */
  listLiveFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]>;
  place(hold: LegalHoldRecord): Promise<void>;
  release(id: LegalHoldId, releasedBy: UserId, reason: string): Promise<void>;
}

export const RETENTION_SERVICE = Symbol('RetentionService');
export const LEGAL_HOLD_SERVICE = Symbol('LegalHoldService');

export interface RetentionService {
  scheduleFor(documentId: DocumentId): Promise<RetentionScheduleRecord | null>;
  /** Refuses while a hold exists, and audits both the refusal and the execution. */
  executeDue(limit: number): Promise<{ reviewed: number; purged: number; blocked: number }>;
}

export interface LegalHoldService {
  isHeld(documentId: DocumentId): Promise<boolean>;
  listFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]>;
}
