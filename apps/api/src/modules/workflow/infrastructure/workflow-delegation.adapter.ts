import { Inject, Injectable } from '@nestjs/common';

import type { PermissionKey, UserId } from '@edms/domain';

import { DELEGATION_SERVICE, type DelegationService } from '../../identity/application/ports';
import type {
  DelegatedAuthority,
  DelegatorCover,
  WorkflowDelegationGate,
} from '../application/ports';

/**
 * Identity's delegation service, in the engine's own words.
 *
 * The same shape as `WorkflowDirectory` over `USER_DIRECTORY` and `WorkflowDocumentGate` over
 * `DOCUMENT_SERVICE`: Workflow declares the narrow port it needs and this adapter binds it, so the
 * engine never holds Identity's service and cannot grow a dependency on the rest of it. What the
 * engine is allowed to ask is exactly two questions — may this person decide this task, and whose
 * work should appear in their inbox — and neither of them can be asked without naming the
 * permission, which is what keeps §4's authority rule from being routed around.
 *
 * There is deliberately no method here that returns a delegation without a permission. A
 * `isDelegateOf(a, b)` would be the cheap call every future caller reaches for, and it is the one
 * that lets a delegate exceed what the delegator holds.
 */
@Injectable()
export class WorkflowDelegationAdapter implements WorkflowDelegationGate {
  constructor(@Inject(DELEGATION_SERVICE) private readonly delegations: DelegationService) {}

  async authorityFor(input: {
    readonly actorId: UserId;
    readonly assigneeId: UserId;
    readonly permission: PermissionKey;
    readonly at: Date;
  }): Promise<DelegatedAuthority> {
    const authority = await this.delegations.authorityFor({
      delegateId: input.actorId,
      // The task's assignee *is* the delegator. The task never moves, so "whose task is this" and
      // "whom would I be acting for" are the same question — which is the whole of what makes
      // delegation a routing overlay rather than a reassignment.
      delegatorId: input.assigneeId,
      permission: input.permission,
      at: input.at,
    });
    return {
      delegationId: authority.delegation?.id ?? null,
      refusal: authority.refusal,
    };
  }

  async coverFor(input: {
    readonly actorId: UserId;
    readonly permission: PermissionKey;
    readonly at: Date;
  }): Promise<readonly DelegatorCover[]> {
    const delegations = await this.delegations.delegatorsFor({
      delegateId: input.actorId,
      permission: input.permission,
      at: input.at,
    });
    return delegations.map((delegation) => ({
      delegationId: delegation.id,
      delegatorId: delegation.delegatorId,
    }));
  }
}
