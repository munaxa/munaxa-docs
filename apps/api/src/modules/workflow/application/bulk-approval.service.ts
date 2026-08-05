import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type ApprovalTaskId,
  BulkOperationKind,
  Permission,
  ScopeType,
  type ScopeRef,
  TaskDecision,
  type TaskDecisionKey,
  asId,
  normaliseTargets,
} from '@edms/domain';

import {
  BULK_EXECUTOR,
  type BulkExecutor,
  type BulkPlan,
  type BulkResult,
} from '../../../core/bulk';
import { ForbiddenError, ValidationError } from '../../../core/errors/application-errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { APPROVAL_QUERY_REPOSITORY, type ApprovalQueryRepository } from './ports';
// A value import, not `import type`: Nest reads the constructor's parameter types from the
// emitted `design:paramtypes` metadata, and a type-only import erases them — the provider would
// resolve as `undefined` at boot with a message naming only the argument index.
import { WorkflowEngine } from './workflow-engine.service';

/**
 * Deciding many approval tasks the same way — the item most likely to be got wrong, and the one a
 * tenant can turn off on its own.
 *
 * ## Two authorities, and both are checked
 *
 * A single-object decision passes two gates that have nothing to do with each other. The route
 * declares `document:approve` (and `document:reject` on top for a rejection), which is a
 * *permission* question; and `WorkflowEngine.decide` refuses a task that is not the actor's
 * unless a live delegation covers exactly that permission at that instant, which is an *authority*
 * question Phase 11 spent a phase getting right.
 *
 * Bulk decisions pass both, per task, and neither is reimplemented here. The permission is the
 * executor's per-object `ACL_RESOLVER.resolve` against the document the task decides — resolved at
 * the document because that is the scope node, and a task is not one. The authority is the engine's
 * own, because `apply` calls `decide` and nothing here reaches past it: a delegation that expired
 * between the second and third task in a batch refuses the third, and the executor records it as
 * `BLOCKED` with the engine's own reason attached.
 *
 * ## Rejection is refused in bulk, and that is a decision rather than an omission
 *
 * A rejection or a request for changes must say why — the engine enforces it — and one sentence
 * covering forty documents is not a reason for any of them; it is a reason for the batch. A
 * reviewer sending forty documents back with "see comments" produces forty audit rows that tell the
 * next reader nothing, in exactly the place a controlled-document system exists to record why
 * something was refused.
 *
 * So bulk approval approves. `REJECTED` and `CHANGES_REQUESTED` are refused at the door with a
 * sentence a person can read, and the single-object route is unchanged and one click away. That
 * also keeps `document:reject` out of this path entirely, so the permission that a rejection
 * additionally needs cannot be reached in bulk at all.
 */
@Injectable()
export class BulkApprovalService {
  constructor(
    @Inject(BULK_EXECUTOR) private readonly executor: BulkExecutor,
    @Inject(APPROVAL_QUERY_REPOSITORY) private readonly queries: ApprovalQueryRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    private readonly engine: WorkflowEngine,
  ) {}

  async decide(input: {
    readonly taskIds: readonly string[];
    readonly decision: TaskDecisionKey;
    readonly comment: string | null;
  }): Promise<BulkResult> {
    if (input.decision !== TaskDecision.APPROVED) {
      throw new ValidationError(
        'Only approval may be decided in bulk. A rejection has to say why, for each document.',
        [{ field: 'decision', message: 'unsupported' }],
      );
    }
    if (!this.holds(Permission.DOCUMENT_APPROVE)) {
      // The tenant-wide floor, checked here because the route's `@RequirePermission` has already
      // checked it and this service is also reachable from the queued consumer, where no guard ran.
      // The per-object check that follows is the real one; this is the cheap refusal that keeps a
      // caller with no approval grant at all from opening an operation record.
      throw new ForbiddenError('approve documents');
    }

    const plan: BulkPlan = {
      kind: BulkOperationKind.APPROVAL,
      permission: Permission.DOCUMENT_APPROVE,
      parameters: { decision: input.decision },
      resolveScope: async (taskId) => {
        const documentId = await this.unitOfWork.run(() =>
          this.queries.documentOfTask(asId<ApprovalTaskId>(taskId)),
        );
        // Reach is decided at the document, never at the task. A task carries no ACL entries and
        // has no place in the scope tree; what governs whether somebody may decide it is whether
        // they reach the document it is about.
        return documentId === null
          ? null
          : ({ type: ScopeType.DOCUMENT, id: asId<AnyId>(documentId) } satisfies ScopeRef);
      },
      apply: async (taskId) => {
        await this.engine.decide({
          taskId: asId<ApprovalTaskId>(taskId),
          decision: input.decision,
          comment: input.comment,
        });
      },
    };

    return this.executor.run({ plan, targetIds: normaliseTargets(input.taskIds) });
  }

  private holds(permission: string): boolean {
    return requireContext().permissions.includes(permission as never);
  }
}
