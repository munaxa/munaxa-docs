import type {
  DispositionKey,
  DocumentId,
  LegalHoldId,
  RetentionPolicyId,
  RetentionScheduleStateKey,
  RetentionTriggerKey,
  UserId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Nothing is destroyed by a user action.
 *
 * Purge is the only path that removes data, it runs only from a policy, only when no legal
 * hold exists, and it never removes the audit trail or the document number
 * (`docs/architecture/adr/0010-soft-delete-and-retention.md`).
 *
 * Phase 0.5 declared the four symbols below and the two service interfaces. Phase 10 binds every
 * one of them and adds the three the capability turned out to need: somewhere to write a
 * tombstone, somewhere to read the recycle bin from, and a way to reach the two modules that own
 * the rows a disposition acts on. Those three are ports rather than direct calls for the usual
 * reason — retention decides *whether* and *when*; Document owns its rows and Storage owns its
 * bytes, and neither of them takes instructions about the other.
 */
export const RETENTION_SCHEDULE_REPOSITORY = Symbol('RetentionScheduleRepository');
export const LEGAL_HOLD_REPOSITORY = Symbol('LegalHoldRepository');
export const TOMBSTONE_REPOSITORY = Symbol('TombstoneRepository');
export const RECYCLE_BIN_REPOSITORY = Symbol('RecycleBinRepository');
export const DOCUMENT_DISPOSITION = Symbol('DocumentDisposition');
export const BLOB_REAPER = Symbol('BlobReaper');

export interface RetentionScheduleRecord {
  readonly id: string;
  readonly documentId: DocumentId;
  readonly policyId: RetentionPolicyId | null;
  readonly trigger: RetentionTriggerKey;
  readonly triggerAt: Date;
  readonly dueAt: Date;
  readonly disposition: DispositionKey;
  readonly state: RetentionScheduleStateKey;
  readonly reviewRequired: boolean;
  readonly reviewedById: UserId | null;
  readonly reviewedAt: Date | null;
  readonly reviewNote: string | null;
  readonly executedAt: Date | null;
  readonly version: number;
}

export interface NewRetentionSchedule {
  readonly documentId: string;
  readonly policyId: string | null;
  readonly trigger: RetentionTriggerKey;
  readonly triggerAt: Date;
  readonly dueAt: Date;
  readonly disposition: DispositionKey;
  readonly reviewRequired: boolean;
}

export interface RetentionScheduleRepository {
  findForDocument(documentId: DocumentId): Promise<readonly RetentionScheduleRecord[]>;
  /**
   * The live schedule this trigger owns, if any.
   *
   * One per `(document, trigger)` while it is live, enforced by `uq_retention_schedule_live`. That
   * partial unique index is what makes a redelivered trigger update a row rather than write a
   * second schedule for the same fact.
   */
  findLive(
    documentId: DocumentId,
    trigger: RetentionTriggerKey,
  ): Promise<RetentionScheduleRecord | null>;
  findById(id: string): Promise<RetentionScheduleRecord | null>;
  /** Served by a partial index on pending rows; the run is tenant-partitioned. */
  listDue(at: Date, limit: number): Promise<readonly RetentionScheduleRecord[]>;
  /** Upserts on `(document, trigger)`, which is what makes re-triggering idempotent. */
  save(schedule: NewRetentionSchedule): Promise<RetentionScheduleRecord>;
  moveState(input: {
    readonly id: string;
    readonly state: RetentionScheduleStateKey;
    readonly reviewedById?: string | null;
    readonly reviewedAt?: Date | null;
    readonly reviewNote?: string | null;
    readonly executedAt?: Date | null;
  }): Promise<void>;
  /** Withdraws every live schedule a delete created. Answers how many it withdrew. */
  cancelForTrigger(documentId: DocumentId, trigger: RetentionTriggerKey): Promise<number>;
  /** Suspends or resumes every live schedule of a document, as a hold is placed or released. */
  setSuspended(documentId: DocumentId, suspended: boolean): Promise<number>;
  /**
   * Removes every schedule of a purged document.
   *
   * The one hard delete in this module's own tables, performed only inside a purge: the evidence
   * moves to the tombstone and the `PURGE_EXECUTED` event, and a surviving row would block the
   * document row's removal at its foreign key.
   */
  deleteForDocument(documentId: DocumentId): Promise<number>;
}

export interface LegalHoldRecord {
  readonly id: LegalHoldId;
  readonly documentId: DocumentId;
  readonly reason: string;
  readonly placedBy: UserId;
  readonly placedAt: Date;
  readonly releasedAt: Date | null;
  readonly releasedById: UserId | null;
  readonly releaseReason: string | null;
  readonly version: number;
}

export interface LegalHoldRepository {
  /** Any live hold blocks disposition, whatever the policy says. */
  listLiveFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]>;
  listFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]>;
  findById(id: LegalHoldId): Promise<LegalHoldRecord | null>;
  /** Which of these documents are held. One statement for a page, never one per row. */
  heldAmong(documentIds: readonly string[]): Promise<ReadonlySet<string>>;
  place(hold: {
    readonly id: string;
    readonly documentId: string;
    readonly reason: string;
    readonly placedById: string;
    readonly placedAt: Date;
  }): Promise<void>;
  release(id: LegalHoldId, releasedBy: string, reason: string, at: Date): Promise<boolean>;
  /** Removes a purged document's (released) holds. A live one has already refused the purge. */
  deleteForDocument(documentId: DocumentId): Promise<number>;
}

/**
 * What a purged document leaves behind.
 *
 * The one row a purge writes rather than removes, and the reason it exists is the constraint
 * Phase 9 made enforceable: `audit_event` refuses `DELETE` to every role, so the trail outlives
 * the document — and the payloads already written cannot be rewritten to carry the number the row
 * used to hold.
 */
export interface TombstoneRepository {
  write(tombstone: {
    readonly documentId: string;
    readonly documentNumber: string | null;
    readonly title: string;
    readonly documentTypeId: string | null;
    readonly documentTypeName: string | null;
    readonly folderPath: string | null;
    readonly deletedAt: Date | null;
    readonly purgedAt: Date;
    readonly purgedById: string | null;
    readonly scheduleId: string | null;
    readonly policyId: string | null;
    readonly approvedById: string | null;
    readonly revisionsRemoved: number;
    readonly blobsDereferenced: number;
  }): Promise<void>;
  findByDocument(documentId: DocumentId): Promise<TombstoneRecord | null>;
  list(request: PageRequest): Promise<Page<TombstoneRecord>>;
}

export interface TombstoneRecord {
  readonly documentId: DocumentId;
  readonly documentNumber: string | null;
  readonly title: string;
  readonly documentTypeName: string | null;
  readonly folderPath: string | null;
  readonly deletedAt: Date | null;
  readonly purgedAt: Date;
  readonly purgedById: UserId | null;
  readonly revisionsRemoved: number;
  readonly blobsDereferenced: number;
}

/**
 * The recycle bin, as a query.
 *
 * It reads `document` and `folder` rows that another module owns, and that is the one place this
 * module does so. The alternative — paging two modules' list endpoints and merging in memory —
 * would make `total` a lie, which is exactly what `common/query.ts` refuses for every other list
 * in the product. So the read is here, it is a read *only*, and every write it offers goes back
 * through the owning module's application service via `RESTORE_GATEWAY`.
 */
export interface RecycleBinRepository {
  list(request: RecycleBinRequest): Promise<Page<DeletedItem>>;
}

export interface RecycleBinRequest extends PageRequest {
  readonly search?: string | undefined;
  readonly kind?: 'DOCUMENT' | 'FOLDER' | undefined;
  readonly sortBy?: string | undefined;
  readonly sortDirection: 'asc' | 'desc';
}

export interface DeletedItem {
  readonly id: string;
  readonly kind: 'DOCUMENT' | 'FOLDER';
  readonly name: string;
  /** Null for a folder, and for a document that was never numbered. */
  readonly documentNumber: string | null;
  readonly path: string | null;
  readonly deletedAt: Date;
  readonly deletedBy: string | null;
  readonly deletedByName: string | null;
  readonly deleteReason: string | null;
  /** Set when this row was taken by a cascade rather than deleted on its own. */
  readonly cascadeId: string | null;
  readonly version: number;
}

/**
 * What Retention needs from Document, in Retention's own words.
 *
 * Retention decides *whether* a document is destroyed and *when*; Document owns the rows and
 * removes them. The split is the same one `DOCUMENT_CONTENT_GATE` makes between Document and
 * Storage, and it matters for the same reason: a purge that reached into another module's tables
 * would be a second place the cascade is written down, and the two would drift the first time a
 * relation was added.
 */
export interface DocumentDisposition {
  /** Everything a tombstone and a purge audit event need, read before anything is removed. */
  describe(documentId: DocumentId): Promise<DispositionSubject | null>;
  /**
   * Removes the document and everything `DOCUMENT_DELETION_RULES` says a purge removes, gives
   * back every reference it held, and answers what it did. Joins the caller's transaction.
   */
  purge(documentId: DocumentId): Promise<PurgeOutcome>;
  /**
   * Moves a document to `ARCHIVED` — the non-destructive disposition. False when the lifecycle
   * refuses (a record mid-approval reached its date); the schedule stays live and the next sweep
   * asks again.
   */
  archive(documentId: DocumentId): Promise<boolean>;
}

export interface DispositionSubject {
  readonly documentId: DocumentId;
  readonly title: string;
  readonly documentNumber: string | null;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly folderPath: string;
  readonly status: string;
  readonly deletedAt: Date | null;
  readonly retentionPolicyId: string | null;
}

export interface PurgeOutcome {
  readonly revisionsRemoved: number;
  readonly blobsDereferenced: number;
}

/**
 * What Retention needs from Storage: the bytes nothing references any more.
 *
 * `StorageService.listUnreferenced` has carried the comment "only retention calls this, and only
 * at a reference count of zero" since Phase 3 and had never been called. This is the caller.
 */
export interface BlobReaper {
  /** Blobs at a reference count of zero, older than the grace period. */
  listReclaimable(before: Date, limit: number): Promise<readonly ReclaimableBlob[]>;
  /** Deletes the object and soft-deletes its row. Refuses if the count is no longer zero. */
  reclaim(fileObjectId: string): Promise<boolean>;
  /** Expires abandoned upload sessions — `storage.sweep-upload-sessions`' whole job. */
  expireUploadSessions(before: Date): Promise<number>;
  /**
   * One pass of the rolling integrity verifier — `storage.verify-integrity`, Phase 18.
   *
   * Here rather than in a consumer of its own, and the reason is the lane. `retention.run` has one
   * subscriber; a second `Worker` on the same queue would take jobs from it at random, so the
   * third schedule on this lane has to be answered by the class that already answers the other
   * two. This port is how it reaches Storage without Retention importing Storage's service —
   * the same seam `listReclaimable` and `expireUploadSessions` already use, and the same shape
   * Phase 13's dashboard ports have.
   *
   * The work itself is entirely Storage's: what a checksum is, what quarantine means, and which
   * finding is an incident are that module's questions. Retention only knows that a schedule
   * fired.
   */
  verifyStoredIntegrity(): Promise<IntegritySweep>;
}

/** What one pass of the integrity verifier found. */
export interface IntegritySweep {
  readonly checked: number;
  readonly verified: number;
  readonly mismatched: number;
  readonly unreadable: number;
}

export interface ReclaimableBlob {
  readonly id: string;
  readonly sizeBytes: number;
  readonly derived: boolean;
}

export const RETENTION_SERVICE = Symbol('RetentionService');
export const LEGAL_HOLD_SERVICE = Symbol('LegalHoldService');
export const RETENTION_SCHEDULER = Symbol('RetentionScheduler');
export const RECYCLE_BIN_SERVICE = Symbol('RecycleBinService');

export interface SweepOutcome {
  readonly reviewed: number;
  readonly purged: number;
  readonly archived: number;
  readonly blocked: number;
  readonly blobsReclaimed: number;
}

export interface RetentionService {
  scheduleFor(documentId: DocumentId): Promise<readonly RetentionScheduleRecord[]>;
  /** The dispositions somebody has to look at: due now, or waiting on a reviewer. */
  listDue(limit: number): Promise<readonly RetentionScheduleRecord[]>;
  /** Refuses while a hold exists, and audits both the refusal and the execution. */
  executeDue(limit: number): Promise<SweepOutcome>;
  /** A person confirms a disposition the policy already scheduled (ADR-0010's only manual step). */
  approveDisposition(scheduleId: string, note: string): Promise<void>;
  /** The disposition register: what this tenant has destroyed, and when. */
  listTombstones(request: PageRequest): Promise<Page<TombstoneRecord>>;
  /** Reclaims blobs whose last reference went, past the tenant's grace period. */
  reclaimBlobs(limit: number): Promise<number>;
  /** Expires abandoned upload sessions. The second schedule on this lane. */
  expireUploadSessions(): Promise<number>;
  /** `storage.verify-integrity`, the lane's third schedule — Phase 18. */
  verifyStoredIntegrity(): Promise<IntegritySweep>;
}

/**
 * The seam Document writes a schedule through, without knowing what a schedule is.
 *
 * Declared here and injected there, which is the direction that has no cycle in it: Retention
 * knows about documents, and nothing about retention belongs in the document use case beyond
 * "this happened, at this time, under this policy". The call joins the caller's transaction, so a
 * publication that rolls back leaves no schedule behind.
 */
export interface RetentionScheduler {
  onTrigger(input: {
    readonly documentId: DocumentId;
    readonly trigger: RetentionTriggerKey;
    readonly at: Date;
    /** The policy the document froze at creation. Null when its type named none. */
    readonly policyId: string | null;
    readonly documentNumber: string | null;
  }): Promise<void>;
  /** A restore withdraws what its delete created, and only that. */
  onRestored(documentId: DocumentId): Promise<void>;
}

/**
 * Reading a policy's terms, by the identifier a document froze.
 *
 * Retention's own read of `retention_policy` — the row Administration administers and this module
 * consumes. Reading it at *trigger* time and copying the terms onto the schedule row is the
 * accepted half of ADR-0010's alternative 3: what was rejected is computing them at *disposition*
 * time, where a policy edit would silently re-date history.
 */
export const RETENTION_POLICY_READER = Symbol('RetentionPolicyReader');

export interface RetentionPolicyReader {
  read(policyId: string): Promise<{
    readonly id: string;
    readonly trigger: RetentionTriggerKey;
    readonly periodMonths: number;
    readonly disposition: DispositionKey;
    readonly reviewRequired: boolean;
  } | null>;
}

export interface LegalHoldService {
  isHeld(documentId: DocumentId): Promise<boolean>;
  /** Which of these documents are held. One statement for a subtree, never one per row. */
  heldAmong(documentIds: readonly string[]): Promise<ReadonlySet<string>>;
  listFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]>;
  place(documentId: string, reason: string): Promise<LegalHoldRecord>;
  release(id: string, reason: string): Promise<void>;
}

/**
 * The bin is a read surface. There is deliberately no restore here: putting something back is
 * Document's and Library's own use case — each revalidates its own uniqueness, checks its own
 * parent is live, and writes its own audit event — and the endpoints for both have existed since
 * the phases that built them. The bin links to them rather than reimplementing either.
 */
export interface RecycleBinService {
  list(request: RecycleBinRequest): Promise<Page<DeletedItem>>;
}
