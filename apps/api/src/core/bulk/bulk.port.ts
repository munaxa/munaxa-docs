import type {
  AnyId,
  BulkItemOutcomeKey,
  BulkOperationKindKey,
  BulkOperationStateKey,
  BulkTally,
  ErrorCodeKey,
  PermissionKey,
  ScopeRef,
  UserId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Bulk operations, as a core capability rather than as a module.
 *
 * `apps/api/src/modules/README.md` fixes the rule this had to be built around: a module may call
 * downward and publish upward, and cross-module calls go through the owning module's application
 * service. A `bulk` module would have violated it in the worst available way — it would be a
 * module that *every* other module calls sideways, holding four different modules' rules about
 * what may be restored, approved and edited. That is the coupling the boundaries exist to prevent,
 * and it is exactly what a "BulkService" becomes by its second release.
 *
 * So the shape here is the same one `AdministeredWriter` has: **a choreography, in core, that owns
 * no rules.** What repeats across all five operations is the transaction per object, the reach
 * decision per object, the outcome per object, the tally and the one operation-level audit row.
 * What each operation *does* stays in the module that owns the row, expressed as a `BulkPlan` the
 * module builds, so a bulk restore is `DocumentService.restore` called N times and not a second
 * implementation of restore.
 *
 * The one thing core does own is the property the whole phase turns on, stated once so it cannot
 * be forgotten in four places: **the caller's reach is resolved for each object, immediately
 * before that object is written, in the transaction that writes it.**
 */
export const BULK_EXECUTOR = Symbol('BulkExecutor');
export const BULK_OPERATION_REPOSITORY = Symbol('BulkOperationRepository');
export const BULK_PLAN_REGISTRY = Symbol('BulkPlanRegistry');
export const BULK_REQUESTER_DIRECTORY = Symbol('BulkRequesterDirectory');

/**
 * What one operation does, in the vocabulary of the module that owns the rows.
 *
 * `resolveScope` and `apply` are separate on purpose. The scope is where *reach* is decided —
 * for a document that is the document, for an approval task it is the document the task belongs
 * to — and it is resolved before anything is written so that a refusal costs a read rather than
 * a rolled-back write. `apply` then performs the module's own single-object use case, with every
 * rule that use case enforces: a legal hold still refuses, a version still conflicts, an illegal
 * transition is still illegal, and each writes its own audit event, on the document's own
 * timeline, exactly as the single-object path does.
 */
export interface BulkPlan {
  readonly kind: BulkOperationKindKey;
  /**
   * The permission each object is checked against — the same one the single-object route declares
   * through `@RequirePermission`, because a bulk operation must not be able to decide something
   * its caller could not decide singly.
   */
  readonly permission: PermissionKey;
  /** What was asked for, beyond the identifiers. Recorded on the operation row and audited. */
  readonly parameters: Readonly<Record<string, unknown>>;
  /**
   * Where this object's reach is decided.
   *
   * `null` means the object cannot be located at all — a deleted identifier, another tenant's
   * UUID, a typo. That is a `REFUSED`, not a `NOT_FOUND`: telling a caller that an identifier
   * they cannot reach *exists* is the disclosure 08 §7 spends its length preventing, and "you do
   * not reach this" is the same answer whether the row is absent or invisible.
   */
  resolveScope(targetId: string): Promise<ScopeRef | null>;
  /** The module's own single-object use case. Throws a `DomainError` to refuse this one object. */
  apply(targetId: string): Promise<void>;
  /**
   * What the operation does once, after its objects — Phase 6.2, and only `EXPORT` has one.
   *
   * A bulk export produces an *artefact*: the objects are read, and then one manifest is written
   * and attached to the operation. Phase 16 did that by accumulating rows in a closure and calling
   * `attachManifest` after `executor.run` returned, which works exactly as long as the run happens
   * on the stack that started it. A queued run does not, so the step moved here — where the
   * executor calls it in both paths, from the applied targets rather than from a closure the
   * worker could never have.
   *
   * Absent on the other four kinds: they produce changes, and each change is complete when its own
   * transaction commits.
   */
  finalise?(operationId: string, appliedTargetIds: readonly string[]): Promise<void>;
}

export interface BulkRequest {
  readonly kind: BulkOperationKindKey;
  /**
   * The serialisable input the plan is built from — Phase 6.2, and the change that made the queued
   * path possible at all.
   *
   * A `BulkPlan` carries two closures, so it cannot cross a process boundary: a worker that never
   * saw the request cannot be handed one. Before this phase the module services built the plan
   * directly and there was nothing else to build it *from*, which is why `documents.bulk` was a
   * lane with no producer — not because nobody had written the consumer, but because there was no
   * way to tell one what to do.
   *
   * So the payload is now the source and the plan is derived from it, by `BulkPlanRegistry`, in
   * **both** paths. The synchronous run and the queued run therefore execute a plan built by the
   * same function from the same bytes, which is what stops the two drifting — the failure mode a
   * second "queued" implementation of each operation would have guaranteed.
   */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Already de-duplicated and ordered by `normaliseTargets`; the executor asserts it. */
  readonly targetIds: readonly string[];
}

/**
 * Rebuilds a module's plan from its payload.
 *
 * Registered by the module that owns the rows, exactly as `FolderContentsRegistry` is filled by
 * Document at boot — core holds the registry and owns none of the rules in it.
 */
export type BulkPlanFactory = (payload: Readonly<Record<string, unknown>>) => BulkPlan;

export interface BulkPlanRegistry {
  register(kind: BulkOperationKindKey, factory: BulkPlanFactory): void;
  /** Throws rather than returning null: a kind with no factory is a wiring defect, not a request. */
  planFor(kind: BulkOperationKindKey, payload: Readonly<Record<string, unknown>>): BulkPlan;
  has(kind: BulkOperationKindKey): boolean;
}

/**
 * Who the requester is **now** — Phase 6.2, and a security requirement rather than a convenience.
 *
 * A queued operation executes minutes or hours after it was asked for, and the person's roles may
 * have changed in between. Copying their permissions onto the job at enqueue time would let
 * somebody bank an authority they no longer hold; reading them here, at execution time, means a
 * revoked grant takes effect on the objects not yet processed. That is the same direction as the
 * per-object ACL resolution the executor already does, applied one level up to role membership.
 *
 * A narrow port rather than a dependency on Identity's service, for the reason
 * `WorkflowDirectory`'s own comment gives: a narrow port is what stops a module growing a
 * dependency on the rest of another one.
 */
export interface BulkRequesterDirectory {
  /** Null when the user is gone or disabled — the operation then fails rather than running. */
  currentAuthority(userId: string): Promise<BulkRequesterAuthority | null>;
}

export interface BulkRequesterAuthority {
  readonly roleKeys: readonly string[];
  readonly roleIds: readonly string[];
  readonly permissions: readonly PermissionKey[];
  readonly permissionVersion: number;
}

export interface BulkItemResult {
  readonly targetId: string;
  readonly outcome: BulkItemOutcomeKey;
  readonly errorCode: ErrorCodeKey | null;
  readonly detail: string | null;
}

export interface BulkResult {
  readonly operationId: AnyId;
  readonly state: BulkOperationStateKey;
  readonly tally: BulkTally;
  /**
   * Present for a synchronous run, empty for a queued one.
   *
   * A caller who pressed a button on a screenful of documents gets the outcomes back and can act
   * on them. A caller who queued four thousand gets an operation to poll and reads the items from
   * the record — sending four thousand rows through a `202` would be sending them before most of
   * them exist.
   */
  readonly items: readonly BulkItemResult[];
}

export interface BulkExecutor {
  /**
   * Runs the plan over the targets, one transaction each, and records the operation.
   *
   * Never throws for a per-object failure — that is the point of the outcome vocabulary. It throws
   * only when the *operation* cannot start: the feature is disabled, the selection is empty or
   * over the tenant's ceiling, the tenant is read-only.
   */
  run(request: BulkRequest): Promise<BulkResult>;
}

// --- The record -------------------------------------------------------------------------------

/** What a queued delivery needs: the plan's input and the objects it was asked for. */
export interface QueuedWork {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly targetIds: readonly string[];
  readonly requestedById: string;
}

export interface BulkOperationRecord {
  readonly id: AnyId;
  readonly kind: BulkOperationKindKey;
  readonly state: BulkOperationStateKey;
  readonly requestedById: UserId;
  readonly requestedAt: Date;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly tally: BulkTally;
  readonly fileObjectId: string | null;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly error: string | null;
}

export interface BulkOperationRepository {
  open(input: {
    readonly id: string;
    readonly kind: BulkOperationKindKey;
    readonly requestedById: string;
    readonly requestedAt: Date;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly requested: number;
    /** Phase 6.2: present only when the operation is queued. */
    readonly payload?: QueuedWork | undefined;
  }): Promise<void>;
  /** Marks the operation started. Its own call, so a queued run records when it actually began. */
  start(id: string, at: Date): Promise<void>;
  /**
   * The reconstruction input for a queued operation, with its target list — Phase 6.2.
   *
   * Written by `open` and read exactly once per delivery. Null for a synchronous operation.
   */
  payloadOf(id: string): Promise<QueuedWork | null>;
  /**
   * The targets that already have an outcome — Phase 6.2's resume read.
   *
   * This is the whole of the idempotency mechanism for a redelivered job, and it needs no second
   * store: `bulk_operation_item` is unique on `(operation_id, target_id)` and an `APPLIED` row is
   * committed in the same transaction as the mutation it describes, so a target listed here has
   * been settled and must not be touched again.
   */
  settledTargets(operationId: string): Promise<ReadonlySet<string>>;
  /**
   * Moves the tally forward mid-run, without touching the state — Phase 6.2.
   *
   * Called once per batch rather than once per object: the row is one row, and five thousand
   * updates to it would serialise the whole operation behind its own progress bar.
   */
  progress(id: string, tally: BulkTally): Promise<void>;
  /** The tally computed from the item rows — the record, rather than one delivery's arithmetic. */
  tallyOf(operationId: string): Promise<BulkTally>;
  /** `FAILED`, with an operator-readable reason. The one state Phase 16 declared and never wrote. */
  markFailed(id: string, reason: string, at: Date): Promise<void>;
  /**
   * Records one object's outcome.
   *
   * In its **own** transaction rather than the object's, and that is the interesting decision: an
   * object whose write rolled back must still leave its outcome behind, or a `BLOCKED` document
   * would be indistinguishable from one nobody attempted. Upserted on
   * `(operation_id, target_id)`, so a redelivered queued job overwrites rather than duplicating.
   */
  recordItem(input: {
    readonly id: string;
    readonly operationId: string;
    readonly targetId: string;
    readonly outcome: BulkItemOutcomeKey;
    readonly errorCode: string | null;
    readonly detail: string | null;
  }): Promise<void>;
  finish(input: {
    readonly id: string;
    readonly state: BulkOperationStateKey;
    readonly tally: BulkTally;
    readonly at: Date;
    readonly error: string | null;
  }): Promise<void>;
  /** Attaches the artefact a bulk export produced. Null for every other kind. */
  attachArtifact(input: {
    readonly id: string;
    readonly fileObjectId: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }): Promise<void>;
  findById(id: string): Promise<BulkOperationRecord | null>;
  listFor(requestedById: UserId, page: PageRequest): Promise<Page<BulkOperationRecord>>;
  itemsOf(operationId: string, page: PageRequest): Promise<Page<BulkItemResult>>;
}
