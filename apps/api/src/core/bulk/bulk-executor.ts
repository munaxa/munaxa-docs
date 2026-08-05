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
import { bulkOperationCompletedEvent } from './events';
import {
  BULK_OPERATION_REPOSITORY,
  type BulkExecutor,
  type BulkItemResult,
  type BulkOperationRepository,
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
@Injectable()
export class DefaultBulkExecutor implements BulkExecutor {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    @Inject(BULK_OPERATION_REPOSITORY) private readonly operations: BulkOperationRepository,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly stamps: RecordStamps,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async run(request: BulkRequest): Promise<BulkResult> {
    const { plan, targetIds } = request;
    await this.refuseWhenDisabled(plan);
    await this.refuseBadSelection(targetIds);
    const operationId = uuidv7();
    const requestedAt = this.stamps.now();
    const requestedBy = this.requesterId();

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

    let tally: BulkTally = EMPTY_TALLY;
    const items: BulkItemResult[] = [];

    for (const targetId of targetIds) {
      const item = await this.runOne(plan, targetId);
      tally = countOutcome(tally, item.outcome);
      items.push(item);
      // Its own transaction, deliberately: an object whose write rolled back must still leave its
      // outcome behind. Recording it inside the object's transaction would lose exactly the rows
      // somebody needs — the refusals.
      await this.unitOfWork.run(() =>
        this.operations.recordItem({
          id: uuidv7(),
          operationId,
          targetId,
          outcome: item.outcome,
          errorCode: item.errorCode,
          detail: item.detail,
        }),
      );
    }

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
   * The tenant's own answer to "do we work this way" — the brief's feature flags, read through
   * `SETTINGS_READER` because that is where anything configurable lives.
   *
   * Checked here rather than at the five controllers, and checked at the *use case* rather than
   * only rendered: a flag that merely hid a button would leave the endpoint reachable by anybody
   * who has ever seen the button, which is not what a tenant turning bulk approval off is asking
   * for. Two flags rather than one, because a quality manager who wants drag-select and wants
   * every approval to be a deliberate individual act has a coherent position.
   */
  private async refuseWhenDisabled(plan: BulkRequest['plan']): Promise<void> {
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
  private async runOne(plan: BulkRequest['plan'], targetId: string): Promise<BulkItemResult> {
    try {
      return await this.unitOfWork.run(async () => {
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
        return {
          targetId,
          outcome: BulkItemOutcome.APPLIED as BulkItemOutcomeKey,
          errorCode: null,
          detail: null,
        };
      });
    } catch (error) {
      return this.outcomeFor(targetId, error);
    }
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
