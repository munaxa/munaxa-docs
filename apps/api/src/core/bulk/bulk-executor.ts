import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditOutcome,
  AuditSubjectType,
  BulkItemOutcome,
  type BulkItemOutcomeKey,
  BulkOperationKind,
  BulkOperationState,
  type BulkTally,
  DomainError,
  EMPTY_TALLY,
  ErrorCode,
  Settings,
  asId,
  bulkSizeVerdict,
  countOutcome,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { ACL_RESOLVER, type AclResolver } from '../authorization/acl-resolver.port';
import { AUDIT_WRITER, type AuditActor, type AuditWriter } from '../audit/audit-writer.port';
import { ValidationError } from '../errors/application-errors';
import { LOGGER, type Logger } from '../observability/logger';
import { RecordStamps } from '../persistence/record-stamps';
import { UNIT_OF_WORK, type UnitOfWork } from '../prisma/unit-of-work';
import { SETTINGS_READER, type SettingsReader } from '../settings/settings.port';
import { requireContext } from '../tenancy/tenant-context';
import { OUTBOX_WRITER, type OutboxWriter } from '../outbox/outbox.port';
import { BulkAudit } from './audit-actions';
import { bulkOperationCompletedEvent, bulkOperationQueuedEvent } from './events';
import {
  BULK_OPERATION_REPOSITORY,
  BULK_PLAN_REGISTRY,
  type BulkExecutor,
  type BulkItemResult,
  type BulkOperationRepository,
  type BulkPlan,
  type BulkPlanRegistry,
  type BulkRequest,
  type BulkResult,
} from './bulk.port';

/**
 * The one implementation of "do this to N objects".
 *
 * ## The rule this class exists to make unbreakable
 *
 * Phase 14 put the reach predicate inside `PrismaDocumentRepository.whereFor` and Phase 15 built
 * everything on top of it, and the tempting bulk implementation resolves the caller's reach once
 * and then applies the answer to a list of identifiers the client supplied. That is
 * fetch-then-filter wearing a new hat, and it is worse than the original because it *writes*: a
 * bulk approve would decide a task the caller could not decide singly, a bulk restore would
 * resurrect a document they cannot see, and a bulk metadata edit would write to a row outside
 * their reach — all through one permission check that passed.
 *
 * So `resolve` is called **per object**, with that object's own scope, through the same
 * `ACL_RESOLVER` that answers `AclGuard` on the single-object routes. A bulk endpoint cannot carry
 * `@ScopedTo` — that decorator binds one route parameter to one object, and there are N — so the
 * decision the guard would have made is made here instead, N times, rather than not at all. The
 * integration suite asserts it by having two callers with different reach send the *same*
 * identifier list and get different sets of `APPLIED` rows back.
 *
 * ## One transaction per object
 *
 * Not one transaction for the batch, and this is the difference between "partially succeeding" and
 * "silently skipping". A single transaction would mean one legal-held document rolls back the
 * other three hundred and ninety-nine, and the caller is told nothing about which one. A
 * transaction each means the hold refuses its own document, the rest commit, and the record names
 * it. It also means the audit rows the single-object use cases write commit with their own
 * changes, which is what keeps `13-audit-architecture.md`'s "audit commits with its change" true
 * inside a bulk operation rather than only outside one.
 *
 * The cost is real and is stated rather than hidden: N transactions, and each writes an audit row
 * onto a chain that serialises per tenant under an advisory lock. That is why `bulk.maxObjects`
 * exists, why anything over `bulk.synchronousLimit` is queued, and why `documents.bulk` is the
 * first lane in the product to declare a per-tenant concurrency cap.
 *
 * ## Two audit rows per object is one too many, and zero is one too few
 *
 * The per-object rows are the single-object use cases' own — this class writes none of them, and
 * that is what keeps a bulk restore's timeline entry identical to a single restore's. What it adds
 * is exactly **one** row for the operation, carrying the kind, the parameters and the tally, and
 * carrying **no identifier list**: 13 §3 requires a minimised payload, and five thousand UUIDs in
 * one `jsonb` would be a second copy of the operation with no retention policy. Which objects were
 * touched is `bulk_operation_item`, which is a table, indexed, and pageable.
 */
/**
 * How many objects a queued run settles between progress updates — Phase 6.2.
 *
 * Fifty, and the number is bounded by the *row* rather than by throughput: progress is five columns
 * on one `bulk_operation` row, and updating it per object would serialise a five-thousand-object
 * import behind its own progress bar for no reader's benefit. Fifty gives a poller a visible move
 * every few seconds at this product's per-object cost, and costs one extra write per fifty
 * transactions.
 *
 * It is not a transaction size. Each object keeps its own transaction, which is Phase 16's rule and
 * the reason one legal hold does not roll back four hundred and ninety-nine other documents.
 */
const DEFAULT_PROGRESS_BATCH = 50;

@Injectable()
export class DefaultBulkExecutor implements BulkExecutor {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    @Inject(BULK_OPERATION_REPOSITORY) private readonly operations: BulkOperationRepository,
    @Inject(BULK_PLAN_REGISTRY) private readonly plans: BulkPlanRegistry,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly stamps: RecordStamps,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async run(request: BulkRequest): Promise<BulkResult> {
    const { kind, payload, targetIds } = request;
    // Built here rather than handed in — Phase 6.2. Both paths derive the plan from the same
    // payload through the same factory, so a queued run cannot drift from the synchronous one.
    const plan = this.plans.planFor(kind, payload);
    await this.refuseWhenDisabled(plan);
    await this.refuseBadSelection(targetIds);
    const operationId = uuidv7();
    const requestedAt = this.stamps.now();
    const requestedBy = this.requesterId();

    // **The decision this phase exists for.** Below the threshold the caller waits and gets the
    // per-object outcomes; above it they get an operation to poll. `bulk.synchronousLimit` has
    // been a tenant setting since Phase 16 and was read by nothing until this line, which is why
    // a request naming five thousand objects executed five thousand transactions inside one HTTP
    // request — the failure the setting's own documentation describes.
    const synchronousLimit = await this.settings.get(Settings.BULK_SYNCHRONOUS_LIMIT);
    if (targetIds.length > synchronousLimit) {
      return this.enqueue({ operationId, plan, payload, targetIds, requestedAt, requestedBy });
    }

    await this.unitOfWork.run(() =>
      this.operations.open({
        id: operationId,
        kind: plan.kind,
        requestedById: requestedBy,
        requestedAt,
        parameters: plan.parameters,
        requested: targetIds.length,
      }),
    );
    await this.unitOfWork.run(() => this.operations.start(operationId, requestedAt));

    const { tally, items } = await this.process({ operationId, plan, targetIds, settled: null });
    await this.finalise(plan, operationId, items);

    await this.unitOfWork.run(async () => {
      await this.operations.finish({
        id: operationId,
        state: BulkOperationState.COMPLETED,
        tally,
        at: this.stamps.now(),
        error: null,
      });
      await this.recordOperation(operationId, plan.kind, plan.parameters, tally);
      // 18 §7's storm control, finally producing a storm to control. Published from inside the
      // same transaction that finishes the operation, so a summary can never describe a run that
      // rolled back — and it is exactly *one* event however many objects the operation touched.
      await this.outbox.publish([
        bulkOperationCompletedEvent(asId<AnyId>(operationId), {
          operationId,
          kind: plan.kind,
          requestedById: requestedBy,
          ...tally,
        }),
      ]);
    });

    return {
      operationId: asId<AnyId>(operationId),
      state: BulkOperationState.COMPLETED,
      tally,
      items,
    };
  }

  /**
   * Accepts the operation and hands it to the lane — Phase 6.2.
   *
   * One transaction: the record, its payload and the outbox row that will become the job. The
   * queue is **not** touched here, which is `ports/queue.port.ts`'s standing rule — the dispatcher
   * enqueues after commit, so a job can never be delivered for an operation whose row rolled back.
   *
   * The caller gets `REQUESTED` and no items, which is what `BulkResult.items` has documented since
   * Phase 16: *"present for a synchronous run, empty for a queued one"*.
   */
  private async enqueue(input: {
    readonly operationId: string;
    readonly plan: BulkPlan;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly targetIds: readonly string[];
    readonly requestedAt: Date;
    readonly requestedBy: string;
  }): Promise<BulkResult> {
    const { operationId, plan, payload, targetIds, requestedAt, requestedBy } = input;
    await this.unitOfWork.run(async () => {
      await this.operations.open({
        id: operationId,
        kind: plan.kind,
        requestedById: requestedBy,
        requestedAt,
        parameters: plan.parameters,
        requested: targetIds.length,
        payload: { payload, targetIds, requestedById: requestedBy },
      });
      await this.outbox.publish([
        bulkOperationQueuedEvent(asId<AnyId>(operationId), {
          operationId,
          kind: plan.kind,
          requestedById: requestedBy,
          requested: targetIds.length,
        }),
      ]);
    });

    this.logger.info('A bulk operation was queued', {
      operationId,
      kind: plan.kind,
      requested: targetIds.length,
    });

    return {
      operationId: asId<AnyId>(operationId),
      state: BulkOperationState.REQUESTED,
      tally: { ...EMPTY_TALLY, requested: targetIds.length },
      items: [],
    };
  }

  /**
   * The loop, shared by both paths — Phase 6.2 lifted it out of `run` unchanged.
   *
   * `settled` is the queued path's resume set: targets that already carry an outcome from an
   * earlier delivery are skipped, which is what makes a redelivered job safe without a second
   * idempotency store. It is null for a synchronous run, which cannot be redelivered.
   *
   * `onBatch` lets the consumer publish progress every so many objects. The synchronous path
   * passes nothing: nobody is polling a request they are still waiting on.
   */
  async process(input: {
    readonly operationId: string;
    readonly plan: BulkPlan;
    readonly targetIds: readonly string[];
    readonly settled: ReadonlySet<string> | null;
    readonly onBatch?: ((tally: BulkTally) => Promise<void>) | undefined;
    readonly batchSize?: number | undefined;
  }): Promise<{ tally: BulkTally; items: BulkItemResult[] }> {
    const { operationId, plan, targetIds, settled, onBatch } = input;
    const batchSize = input.batchSize ?? DEFAULT_PROGRESS_BATCH;
    let tally: BulkTally = EMPTY_TALLY;
    const items: BulkItemResult[] = [];
    let sinceBatch = 0;

    for (const targetId of targetIds) {
      if (settled?.has(targetId) === true) {
        // Already settled by an earlier delivery. Not re-applied, and not re-counted either — the
        // tally this pass produces describes this pass, and `finish` writes the sum of the item
        // rows rather than of one delivery's arithmetic.
        continue;
      }
      const item = await this.runOne(plan, operationId, targetId);
      tally = countOutcome(tally, item.outcome);
      items.push(item);
      sinceBatch += 1;
      if (onBatch !== undefined && sinceBatch >= batchSize) {
        await onBatch(tally);
        sinceBatch = 0;
      }
    }
    return { tally, items };
  }

  /** The executor's clock, so the consumer stamps its transitions from the same source. */
  now(): Date {
    return this.stamps.now();
  }

  /**
   * Finishes a queued operation: the tally from the item rows, the audit row, the summary event.
   *
   * The tally is recomputed from `bulk_operation_item` rather than from the pass that just ran,
   * and that is the resume case made correct: a delivery that settled two hundred of five hundred
   * objects and died leaves a successor whose own arithmetic describes three hundred. The rows are
   * the record; the pass is an episode.
   */
  async complete(operationId: string, plan: BulkPlan, requestedById: string): Promise<void> {
    const tally = await this.unitOfWork.run(() => this.operations.tallyOf(operationId));
    await this.unitOfWork.run(async () => {
      await this.operations.finish({
        id: operationId,
        state: BulkOperationState.COMPLETED,
        tally,
        at: this.stamps.now(),
        error: null,
      });
      await this.recordOperation(operationId, plan.kind, plan.parameters, tally);
      await this.outbox.publish([
        bulkOperationCompletedEvent(asId<AnyId>(operationId), {
          operationId,
          kind: plan.kind,
          requestedById,
          ...tally,
        }),
      ]);
    });
  }

  /**
   * The tenant's own answer to "do we work this way" — the brief's feature flags, read through
   * `SETTINGS_READER` because that is where anything configurable lives.
   *
   * Checked here rather than at the five controllers, and checked at the *use case* rather than
   * only rendered: a flag that merely hid a button would leave the endpoint reachable by anybody
   * who has ever seen the button, which is not what a tenant turning bulk approval off is asking
   * for. Two flags rather than one, because a quality manager who wants drag-select and wants
   * every approval to be a deliberate individual act has a coherent position.
   */
  private async refuseWhenDisabled(plan: BulkPlan): Promise<void> {
    if (!(await this.settings.get(Settings.FEATURE_BULK_OPERATIONS))) {
      throw new ValidationError('Bulk operations are turned off for this organisation.', [
        { field: 'feature', message: 'disabled' },
      ]);
    }
    if (
      plan.kind === BulkOperationKind.APPROVAL &&
      !(await this.settings.get(Settings.FEATURE_BULK_APPROVAL))
    ) {
      throw new ValidationError('Bulk approval is turned off for this organisation.', [
        { field: 'feature', message: 'disabled' },
      ]);
    }
  }

  /**
   * The ceiling, and the empty selection.
   *
   * The empty case is the one worth a branch of its own. Running it would open an audited
   * operation row that touched nothing and report it as a success, and a client that sent it has
   * a defect it should be told about rather than a result it should believe.
   */
  private async refuseBadSelection(targetIds: readonly string[]): Promise<void> {
    const maximum = await this.settings.get(Settings.BULK_MAX_OBJECTS);
    const verdict = bulkSizeVerdict(targetIds.length, maximum);
    if (verdict === 'EMPTY') {
      throw new ValidationError('A bulk operation must name at least one object.', [
        { field: 'ids', message: 'required' },
      ]);
    }
    if (verdict === 'TOO_MANY') {
      throw new ValidationError(`A bulk operation may name at most ${String(maximum)} objects.`, [
        { field: 'ids', message: 'too_many' },
      ]);
    }
  }

  /**
   * One object: reach, then the module's own use case, in one transaction.
   *
   * The order matters and is not an optimisation. Resolving reach first means a refusal costs a
   * read rather than a write that is then rolled back — but more importantly, both happen inside
   * the *same* transaction, so the decision cannot go stale between being taken and being acted
   * on. An administrator revoking an ACL entry mid-batch stops the objects after it rather than
   * racing the ones in flight.
   */
  private async runOne(
    plan: BulkPlan,
    operationId: string,
    targetId: string,
  ): Promise<BulkItemResult> {
    let applied = false;
    try {
      const result = await this.unitOfWork.run(async () => {
        const scope = await plan.resolveScope(targetId);
        if (scope === null) {
          // Unreachable and non-existent give the same answer. Distinguishing them here would make
          // a bulk request a probe for which identifiers exist in a tenant.
          return refused(targetId, 'The caller does not reach this object.');
        }
        const decision = await this.acl.resolve(this.subject(), scope, plan.permission);
        if (!decision.allowed) {
          return refused(targetId, `Refused at ${decision.reason}.`);
        }
        await plan.apply(targetId);
        // **The item row commits with the mutation** — Phase 6.2, and the whole of why a
        // redelivered job cannot apply anything twice.
        //
        // Phase 16 recorded every item in its own transaction, for a good reason it stated: an
        // object whose write rolled back must still leave its outcome behind, or a refusal would
        // be indistinguishable from an object nobody attempted. That reasoning is right for the
        // three not-applied outcomes and wrong for this one. An `APPLIED` row written *after* the
        // object's transaction leaves a window — commit the mutation, crash, redeliver — in which
        // the resume set does not know the object was done. For a metadata edit that is harmless
        // repetition; for `UPLOAD` it is a second document, because `create` mints a new
        // identifier every time. Writing it here closes the window by construction: the mutation
        // and the fact that it happened are one commit or neither.
        await this.operations.recordItem({
          id: uuidv7(),
          operationId,
          targetId,
          outcome: BulkItemOutcome.APPLIED,
          errorCode: null,
          detail: null,
        });
        applied = true;
        return {
          targetId,
          outcome: BulkItemOutcome.APPLIED as BulkItemOutcomeKey,
          errorCode: null,
          detail: null,
        };
      });
      if (applied) {
        return result;
      }
      // A refusal decided before anything was written: its transaction committed nothing, so the
      // outcome is recorded separately, exactly as Phase 16 recorded every outcome.
      await this.record(operationId, result);
      return result;
    } catch (error) {
      const outcome = this.outcomeFor(targetId, error);
      // The object's transaction rolled back and took any row it wrote with it. This one is its
      // own, which is the case Phase 16's comment is about.
      await this.record(operationId, outcome);
      return outcome;
    }
  }

  /**
   * The operation's own completion step, when its kind has one.
   *
   * Called before `finish`, so an artefact that cannot be written fails the operation rather than
   * completing one that claims an artefact it does not have.
   */
  async finalise(
    plan: BulkPlan,
    operationId: string,
    items: readonly BulkItemResult[],
  ): Promise<void> {
    if (plan.finalise === undefined) {
      return;
    }
    const applied = items
      .filter((item) => item.outcome === BulkItemOutcome.APPLIED)
      .map((item) => item.targetId);
    if (applied.length > 0) {
      await plan.finalise(operationId, applied);
    }
  }

  /** One outcome, in its own transaction, for the objects whose own transaction did not commit. */
  private async record(operationId: string, item: BulkItemResult): Promise<void> {
    await this.unitOfWork.run(() =>
      this.operations.recordItem({
        id: uuidv7(),
        operationId,
        targetId: item.targetId,
        outcome: item.outcome,
        errorCode: item.errorCode,
        detail: item.detail,
      }),
    );
  }

  /**
   * Which of the three not-applied outcomes an error is.
   *
   * A `DomainError` is the module saying no for a reason it has a code for, and every one of those
   * is `BLOCKED` except the two that are really reach answers. `LEGAL_HOLD` is the case Phase 10
   * built and this phase's suite asserts: the hold refuses that one document *regardless of
   * permission*, and the rest of the batch completes.
   *
   * Anything that is not a `DomainError` is `FAILED` and is logged, because it is a defect rather
   * than a decision — and a batch that quietly recorded a crashed object as "blocked" would hide
   * an incident inside an ordinary-looking result.
   */
  private outcomeFor(targetId: string, error: unknown): BulkItemResult {
    if (error instanceof DomainError) {
      const isReach = error.code === ErrorCode.FORBIDDEN || error.code === ErrorCode.NOT_FOUND;
      return {
        targetId,
        outcome: isReach ? BulkItemOutcome.REFUSED : BulkItemOutcome.BLOCKED,
        errorCode: error.code,
        detail: error.message,
      };
    }
    this.logger.error('A bulk operation object failed outside the domain', {
      targetId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return {
      targetId,
      outcome: BulkItemOutcome.FAILED,
      errorCode: ErrorCode.INTERNAL,
      detail: null,
    };
  }

  /**
   * The operation's own audit row — 13 §2's `BULK_OPERATION`, filed under its own subject type.
   *
   * Counts, not identifiers. "Who ran the bulk edit that touched four hundred documents" is not
   * answerable by reading four hundred rows, and "which four hundred" is not answerable from a
   * payload that would have to hold them. The first is this row; the second is the item table.
   */
  private async recordOperation(
    operationId: string,
    kind: string,
    parameters: Readonly<Record<string, unknown>>,
    tally: BulkTally,
  ): Promise<void> {
    await this.audit.write(this.actor(), {
      action: BulkAudit.BULK_OPERATION,
      subjectType: AuditSubjectType.BULK_OPERATION,
      subjectId: asId<AnyId>(operationId),
      outcome: tally.failed > 0 ? AuditOutcome.FAILED : AuditOutcome.SUCCESS,
      payload: { kind, parameters, ...tally },
    });
  }

  private subject() {
    const context = requireContext();
    return {
      userId: asId<AnyId>(context.userId ?? ''),
      roleIds: context.roles.map((role) => asId<AnyId>(role)),
      departmentIds: [],
      delegationIds: [],
    } as Parameters<AclResolver['resolve']>[0];
  }

  private actor(): AuditActor {
    const context = requireContext();
    return {
      tenantId: context.tenantId,
      userId: context.userId,
      channel: 'WEB',
      correlationId: context.correlationId,
      ipAddress: null,
      userAgent: null,
    };
  }

  private requesterId(): string {
    const { userId } = requireContext();
    if (userId === null) {
      // A bulk operation has no system caller. Every one of them is somebody's act, and an
      // operation with no requester could not be scoped to a reach at all — `visibilityCondition`
      // answers a subject-less caller with an empty predicate, which Phase 15 found the hard way.
      throw new ValidationError('A bulk operation must be requested by a user.', [
        { field: 'requestedBy', message: 'required' },
      ]);
    }
    return userId;
  }
}

function refused(targetId: string, detail: string): BulkItemResult {
  return {
    targetId,
    outcome: BulkItemOutcome.REFUSED,
    errorCode: ErrorCode.FORBIDDEN,
    detail,
  };
}
