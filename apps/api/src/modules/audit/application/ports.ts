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
  /** Which field set this row's digest covers (`core/audit/hash-chain.ts`). */
  readonly chainHashVersion: number;
}

/** Where the chain currently ends, and therefore what the next append must link to. */
export interface ChainTail {
  readonly sequence: bigint;
  readonly hash: string;
}

/**
 * The audit search of `13-audit-architecture.md` §6: "filterable by actor, action, target,
 * date, correlation id".
 *
 * Every field is optional and every one that is given narrows. There is deliberately no free
 * text: the trail is structured, and a search box over `payload` would be a promise the index
 * cannot keep and an invitation to store more in the payload than §3 permits.
 */
export interface AuditSearchCriteria {
  readonly from: Date | null;
  readonly to: Date | null;
  readonly actorId: UserId | null;
  readonly actions: readonly string[];
  readonly subjectType: AuditSubjectTypeKey | null;
  readonly subjectId: AnyId | null;
  readonly outcome: AuditOutcomeKey | null;
  readonly correlationId: string | null;
}

/** One page of the chain, in written order, for the verifier and the exporter alike. */
export interface ChainSlice {
  readonly events: readonly AuditEventRecord[];
  /** The digest the first event chains from — the previous row's, or genesis. */
  readonly from: string;
}

export interface AuditRepository {
  append(event: AuditEventRecord): Promise<void>;
  /** Appends a batch that was chained together, in one round trip. The read buffer's flush. */
  appendMany(events: readonly AuditEventRecord[]): Promise<void>;
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
  /** The tail without taking the lock — for a verifier, which appends nothing. */
  readTail(): Promise<ChainTail>;
  listForSubject(subjectId: AnyId, page: PageRequest): Promise<Page<AuditEventRecord>>;
  /** "What did this person do" — an investigation, and the activity feed. */
  listForActor(actorId: UserId, page: PageRequest): Promise<Page<AuditEventRecord>>;
  /** Ordered by sequence, so verification sees the chain in the order it was written. */
  listForVerification(from: Date, to: Date): Promise<readonly AuditEventRecord[]>;
  /**
   * A window of the chain by sequence, and the digest it must chain from.
   *
   * Keyset rather than offset, because both callers walk the whole range: a verification pass
   * and an evidence export each read millions of rows in order, and an offset scan would
   * re-read the prefix on every batch.
   */
  sliceBySequence(afterSequence: bigint, limit: number): Promise<ChainSlice>;
  /** §6's audit search. Offset-paged, because the screen shows a total. */
  search(criteria: AuditSearchCriteria, page: PageRequest): Promise<Page<AuditEventRecord>>;
  /** The distinct actions present in the tenant's trail — the search screen's filter list. */
  distinctActions(): Promise<readonly string[]>;
}

/**
 * A signed checkpoint of the chain's state, kept where the chain is not.
 *
 * §4: "Checkpoints are written to a separate store so an attacker with database access alone
 * cannot rewrite history undetected." A checkpoint in the database it attests would be
 * ceremony — the same access that rewrote the trail rewrites its attestation — so the store is
 * object storage, and the signature is what makes the separation mean something: an attacker
 * who reaches the bucket as well still cannot forge one without the key, which is held in
 * neither place.
 */
export const AUDIT_CHECKPOINT_STORE = Symbol('AuditCheckpointStore');

export interface AuditCheckpoint {
  readonly tenantId: TenantId;
  readonly sequence: bigint;
  readonly hash: string;
  readonly verifiedAt: Date;
  readonly eventsVerified: number;
  readonly signature: string;
  readonly algorithm: 'HMAC-SHA256';
}

export interface AuditCheckpointStore {
  /** Whether this deployment can write one at all — no key, or no object store, means no. */
  readonly available: boolean;
  write(checkpoint: AuditCheckpoint): Promise<void>;
  /** The most recent checkpoint, or null before the first pass. Verification resumes from it. */
  latest(): Promise<AuditCheckpoint | null>;
  /** Every checkpoint whose sequence falls in the range — what an evidence bundle carries. */
  covering(fromSequence: bigint, toSequence: bigint): Promise<readonly AuditCheckpoint[]>;
  /** True when the signature recomputes. A checkpoint that fails this is not evidence. */
  isAuthentic(checkpoint: AuditCheckpoint): boolean;
}

/** The bundle jobs, and what each one produced. */
export const AUDIT_EXPORT_REPOSITORY = Symbol('AuditExportRepository');

export const AuditExportState = {
  REQUESTED: 'REQUESTED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type AuditExportStateKey = (typeof AuditExportState)[keyof typeof AuditExportState];

export interface AuditExportArtefact {
  readonly name: string;
  readonly storageKey: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** The `file_object` the artefact was stored as; the download signs through Storage. */
  readonly fileObjectId: string;
}

export interface AuditExportRecord {
  readonly id: AnyId;
  readonly state: AuditExportStateKey;
  readonly from: Date;
  readonly to: Date;
  readonly filters: Readonly<Record<string, string>>;
  readonly requestedById: UserId;
  readonly requestedAt: Date;
  readonly eventCount: number;
  readonly storagePrefix: string | null;
  readonly artefacts: readonly AuditExportArtefact[];
  readonly chainIntact: boolean | null;
  readonly brokenAtId: string | null;
  readonly completedAt: Date | null;
  readonly error: string | null;
}

export interface AuditExportRepository {
  insert(record: AuditExportRecord): Promise<void>;
  findById(id: AnyId): Promise<AuditExportRecord | null>;
  list(page: PageRequest): Promise<Page<AuditExportRecord>>;
  /**
   * Claims a requested export for this run.
   *
   * Conditional on `REQUESTED`, which is what makes at-least-once delivery harmless: a
   * redelivered job finds the row already `RUNNING` or `COMPLETED` and does nothing, rather
   * than producing a second bundle under the same identifier.
   */
  claim(id: AnyId): Promise<boolean>;
  complete(
    id: AnyId,
    outcome: {
      readonly eventCount: number;
      readonly storagePrefix: string;
      readonly artefacts: readonly AuditExportArtefact[];
      readonly chainIntact: boolean;
      readonly brokenAtId: string | null;
    },
  ): Promise<void>;
  fail(id: AnyId, error: string): Promise<void>;
}

export const AUDIT_SERVICE = Symbol('AuditService');

/** What one verification pass established. */
export interface ChainVerification {
  readonly intact: boolean;
  readonly brokenAt: string | null;
  readonly reason: string | null;
  readonly eventsVerified: number;
  readonly fromSequence: bigint;
  readonly toSequence: bigint;
  /** False when the deployment has no key or no store — the pass still ran, and says so. */
  readonly checkpointed: boolean;
}

export interface AuditService {
  /**
   * One subject's trail, filtered to what the caller may see.
   *
   * The filtering happens *once*, at the subject, rather than per row — see
   * `default-audit.service.ts` for why that is the only shape the row model supports and why
   * it is also the correct one.
   */
  timelineFor(
    subjectType: AuditSubjectTypeKey,
    subjectId: AnyId,
    page: PageRequest,
  ): Promise<Page<AuditEventRecord>>;
  /** §6's audit search, behind `audit:view`. */
  search(criteria: AuditSearchCriteria, page: PageRequest): Promise<Page<AuditEventRecord>>;
  /** Daily verification plus external checkpoints; a break is the highest-severity alert. */
  verifyChain(): Promise<ChainVerification>;
  /** Evidence bundles are large: they stream to storage rather than through a response. */
  requestExport(
    from: Date,
    to: Date,
    filters: Readonly<Record<string, string>>,
  ): Promise<AuditExportRecord>;
}
