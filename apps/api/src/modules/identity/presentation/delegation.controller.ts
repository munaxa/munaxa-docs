import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import {
  type Delegation as WireDelegation,
  type DelegationQuery,
  type DelegationUse as WireDelegationUse,
  type DeclareEmergencyDelegationBody,
  type DeclineDelegationBody,
  type RequestDelegationBody,
  type RevokeDelegationBody,
  declareEmergencyDelegationSchema,
  declineDelegationSchema,
  delegationQuerySchema,
  requestDelegationSchema,
  revokeDelegationSchema,
} from '@edms/contracts';
import { type DelegationId, Permission, type UserId, asId } from '@edms/domain';
import { normalizePageRequest } from '@edms/utils';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { DELEGATION_SERVICE } from '../application/ports';
import type { DefaultDelegationService } from '../application/delegation.service';
import type { DelegationUseRecord, DelegationView } from '../application/ports';

interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * Delegation, on the API.
 *
 * `delegation:manage` gates the whole controller, and the **subject is never on the wire**. There
 * is no `delegatorId` in any request body: a delegation is always the caller's own to give away,
 * and the use case reads the actor from the request context. That is what the Phase 1 seed meant
 * by granting the permission to `AUTHOR` and `APPROVER` as an `own` scope with the note that "the
 * use case enforces the subject" — enforcement by *absence* rather than by a check, because a
 * field that is not in the schema cannot be supplied by a client that guesses.
 *
 * The two operations that are somebody *else's* — approving a request and declining one — are
 * gated additionally inside the service, on being a manager of the delegator or holding
 * `user:manage`. They are on this controller rather than an administrative one because the person
 * who approves is a line manager going about their day, not an administrator on a console.
 *
 * The emergency declaration is its own route rather than a flag, so the path that bypasses the
 * approval is a different URL from the path that requests one — visible in an access log, and not
 * reachable by adding a field to an ordinary request.
 */
@Controller({ path: 'delegations', version: '1' })
@RequirePermission(Permission.DELEGATION_MANAGE)
export class DelegationController {
  constructor(@Inject(DELEGATION_SERVICE) private readonly delegations: DefaultDelegationService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(delegationQuerySchema)) query: DelegationQuery,
  ): Promise<{ data: readonly WireDelegation[]; meta: PageMeta }> {
    const page = await this.delegations.list({
      ...normalizePageRequest(query),
      direction: query.direction,
      includeEnded: query.includeEnded === 'true',
      ...(query.status !== undefined && { status: query.status }),
    });
    return { data: page.data.map(toDelegation), meta: page.meta };
  }

  /**
   * Everything decided under one delegation.
   *
   * §4's visibility row: "the delegator sees every action taken on their behalf". Readable by
   * either party — the delegate's own decisions are hardly a secret from them — and by
   * `user:manage`, checked in the service because the answer depends on the row.
   */
  @Get(':id/uses')
  async uses(@Param('id') id: string): Promise<{ data: readonly WireDelegationUse[] }> {
    const uses = await this.delegations.uses(asId<DelegationId>(id));
    return { data: uses.map(toUse) };
  }

  @Post()
  async request(
    @Body(new ZodValidationPipe(requestDelegationSchema)) body: RequestDelegationBody,
  ): Promise<{ id: string }> {
    const id = await this.delegations.request({
      delegateId: asId<UserId>(body.delegateId),
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      permissions: body.permissions,
      reason: body.reason ?? null,
    });
    return { id };
  }

  /**
   * The emergency path.
   *
   * No approval, a much tighter bound, and a mandatory ground that lands in the trail's own
   * attested `reason` column. It starts immediately — a future-dated emergency is a request, and
   * the body has no `startsAt` to say otherwise.
   */
  @Post('emergency')
  async declareEmergency(
    @Body(new ZodValidationPipe(declareEmergencyDelegationSchema))
    body: DeclareEmergencyDelegationBody,
  ): Promise<{ id: string }> {
    const id = await this.delegations.declareEmergency({
      delegateId: asId<UserId>(body.delegateId),
      endsAt: new Date(body.endsAt),
      permissions: body.permissions,
      reason: body.reason,
    });
    return { id };
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approve(@Param('id') id: string): Promise<void> {
    await this.delegations.approve(asId<DelegationId>(id));
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  async decline(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(declineDelegationSchema)) body: DeclineDelegationBody,
  ): Promise<void> {
    await this.delegations.decline(asId<DelegationId>(id), body.reason);
  }

  /**
   * §4: revocation is immediate, and in-flight tasks revert to the delegator.
   *
   * Nothing is reassigned, because nothing ever moved — the delegate was never the assignee. The
   * reason is mandatory for the same reason a delete's is: ending somebody's cover is an act
   * somebody answers for.
   */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(revokeDelegationSchema)) body: RevokeDelegationBody,
  ): Promise<void> {
    await this.delegations.revoke(asId<DelegationId>(id), body.reason);
  }
}

// --- Mappers ---------------------------------------------------------------------------------

function toDelegation(view: DelegationView): WireDelegation {
  return {
    id: view.id,
    delegatorId: view.delegatorId,
    delegatorName: view.delegatorName,
    delegateId: view.delegateId,
    delegateName: view.delegateName,
    kind: view.kind,
    status: view.status,
    permissions: [...view.permissions],
    startsAt: view.startsAt.toISOString(),
    endsAt: view.endsAt.toISOString(),
    reason: view.reason,
    depth: view.depth,
    requestedAt: view.requestedAt.toISOString(),
    approvedById: view.approvedById,
    approvedByName: view.approvedByName,
    approvedAt: view.approvedAt?.toISOString() ?? null,
    declineReason: view.declineReason,
    revokedById: view.revokedById,
    revokedAt: view.revokedAt?.toISOString() ?? null,
    revokeReason: view.revokeReason,
    useCount: view.useCount,
    version: view.version,
  };
}

function toUse(use: DelegationUseRecord): WireDelegationUse {
  return {
    taskId: use.taskId,
    documentId: use.documentId,
    documentTitle: use.documentTitle,
    documentNumber: use.documentNumber,
    decision: use.decision,
    decidedById: use.decidedById,
    decidedByName: use.decidedByName,
    onBehalfOfId: use.onBehalfOfId,
    decidedAt: use.decidedAt?.toISOString() ?? null,
  };
}
