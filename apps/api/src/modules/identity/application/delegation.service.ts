import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  DelegationChainProblem,
  type DelegationId,
  DelegationKind,
  DelegationPeriodProblem,
  DelegationRefusal,
  type DelegationRefusalKey,
  DelegationStatus,
  LIVE_DELEGATION_STATUSES,
  Permission,
  type PermissionKey,
  Settings,
  type UserId,
  asId,
  delegationChainProblem,
  delegationCoversInstant,
  delegationPeriodProblem,
  delegationRefusalFor,
  proposedDelegationDepth,
} from '@edms/domain';
import type { Page } from '@edms/utils';

import { ForbiddenError, NotFoundError, ValidationError } from '../../../core/errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { DelegationAudit } from '../domain/audit-actions';
import {
  delegationApprovedEvent,
  delegationExpiredEvent,
  delegationRequestedEvent,
  delegationRevokedEvent,
} from '../domain/events';
import { canSignIn } from '../domain/user';
import {
  CREDENTIAL_REPOSITORY,
  type CredentialRepository,
  DELEGATION_REPOSITORY,
  type DelegationAuthority,
  type DelegationListRequest,
  type DelegationRecord,
  type DelegationRepository,
  type DelegationService,
  type DelegationUseRecord,
  type DelegationView,
  USER_DIRECTORY,
  type UserDirectory,
} from './ports';

/**
 * Delegation — `07-workflow-architecture.md` §4, made real.
 *
 * Delegation is a **routing overlay, never a permission grant**. Everything in this class is
 * downstream of that sentence, and the three decisions the specification left open are all
 * answered by taking it seriously.
 *
 * ## Who approves a delegation
 *
 * A **manager of the delegator**, from `user_department.is_manager` through `UserDirectory` — the
 * same relationship Phase 4 added for the `MANAGER_OF` participant resolver and the same method
 * that already resolves it for four subjects. Failing that, a holder of **`user:manage`** who is
 * party to neither side — `user:manage` rather than `delegation:manage`, because the latter is
 * `own`-scoped in the Phase 1 seed and every author holds it; see `refuseUnlessApprover` for why
 * that distinction is the difference between a control and the appearance of one.
 *
 * The tempting alternative was a workflow instance, and it is refused with its cost stated. The
 * engine's every path begins at `WorkflowDocumentGate.contextFor(documentId)` and ends at
 * `transition(...)`; `workflow_instance.document_id` is `NOT NULL` and a partial unique index
 * enforces one live approval *per document*. A workflow whose subject is not a document would mean
 * either a fabricated document — a row in the library nobody may open — or a nullable subject on
 * the engine's central table, widening every query, index and completion path in the engine so
 * that one non-document case can borrow the machinery. The approval a delegation needs is one
 * person agreeing once; the engine exists for the case where that is not true.
 *
 * A permission alone was the other alternative, and it cannot express the control: `delegation:manage`
 * is what the delegator holds in order to *ask* (it is `own`-scoped in the seed, for exactly that
 * reason), and "somebody above me agreed" is not a permission anybody holds.
 *
 * ## What an emergency delegation bypasses, and what it does not
 *
 * It bypasses the approval, and nothing else. It is bounded by its own much shorter setting, it
 * carries a mandatory stated ground enforced by a check constraint, and that ground is written to
 * **`audit_event.reason`** — the trail's own column, which Phase 9's widened digest attests and
 * the verifier can address — rather than to a payload field, which is attested only as part of a
 * blob nothing can point at. The difference between an emergency delegation and an ordinary one is
 * therefore visible in the trail as a populated attested column, which is a stronger record than a
 * fifth action name would have been.
 *
 * ## Authority at decision time
 *
 * `authorityFor` reads the **delegator's current permissions** and refuses if the delegation names
 * one they no longer hold. Nothing about the delegator's grants is stored on the delegation, so
 * there is no stale copy to go wrong: a delegation created while Alice held `document:approve`
 * stops authorising the moment her role is edited, with no cache, no token and no job in the path.
 */
@Injectable()
export class DefaultDelegationService implements DelegationService {
  constructor(
    @Inject(DELEGATION_REPOSITORY) private readonly delegations: DelegationRepository,
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepository,
    @Inject(USER_DIRECTORY) private readonly directory: UserDirectory,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly writer: AdministeredWriter,
  ) {}

  // --- The authority check ------------------------------------------------------------------

  /**
   * §4's central rule, and the only method on this class other modules call.
   *
   * The order of the questions is the order the section reads in, and the expensive one is last:
   * find the delegation, check it is in force and current and names the permission, and only then
   * ask what the delegator holds today.
   */
  async authorityFor(input: {
    readonly delegateId: UserId;
    readonly delegatorId: UserId;
    readonly permission: PermissionKey;
    readonly at: Date;
  }): Promise<DelegationAuthority> {
    // `writer.read` rather than a bare call, because this is reached from two directions: the
    // engine calls it *inside* the deciding transaction, and `UnitOfWork.run` joins an ambient one
    // rather than opening a second — so this is free there and correct when something calls it
    // from outside. A repository read with no transaction is a runtime failure, not a slow path.
    return this.writer.read(() => this.authorise(input));
  }

  private async authorise(input: {
    readonly delegateId: UserId;
    readonly delegatorId: UserId;
    readonly permission: PermissionKey;
    readonly at: Date;
  }): Promise<DelegationAuthority> {
    const candidates = await this.delegations.listActiveFor(input.delegateId, input.at);
    const matching = candidates.filter(
      (delegation) => delegation.delegatorId === input.delegatorId,
    );
    if (matching.length === 0) {
      return { delegation: null, refusal: DelegationRefusal.NONE };
    }

    // Read once for the whole set rather than per candidate: somebody covering for one person
    // under two overlapping delegations is unusual but legal, and asking Identity the same
    // question twice inside one decision would be two reads of the same row.
    const delegatorHolds = await this.holdingsOf(input.delegatorId);

    let refusal: DelegationRefusalKey = DelegationRefusal.NONE;
    for (const delegation of matching) {
      const problem = delegationRefusalFor({
        inForce: LIVE_DELEGATION_STATUSES.includes(delegation.status),
        startsAt: delegation.startsAt,
        endsAt: delegation.endsAt,
        permissions: delegation.permissions,
        permission: input.permission,
        delegatorHolds,
        at: input.at,
      });
      if (problem === null) {
        return { delegation, refusal: null };
      }
      // The most specific refusal wins, so two delegations — one expired, one that never named the
      // permission — report the one an approver can act on rather than whichever sorted first.
      refusal = moreSpecific(refusal, problem);
    }
    return { delegation: null, refusal };
  }

  async delegatorsFor(input: {
    readonly delegateId: UserId;
    readonly permission: PermissionKey;
    readonly at: Date;
  }): Promise<readonly DelegationRecord[]> {
    return this.writer.read(() => this.cover(input));
  }

  private async cover(input: {
    readonly delegateId: UserId;
    readonly permission: PermissionKey;
    readonly at: Date;
  }): Promise<readonly DelegationRecord[]> {
    const active = await this.delegations.listActiveFor(input.delegateId, input.at);
    const covering = active.filter(
      (delegation) =>
        delegation.permissions.includes(input.permission) &&
        delegationCoversInstant(delegation, input.at),
    );
    if (covering.length === 0) {
      return [];
    }

    // The delegator's *current* authority, checked here too. An inbox that showed tasks a delegate
    // would then be refused at decision time would be an inbox that lies, and §4 puts the check at
    // decision time rather than only there.
    const held = new Map<string, readonly PermissionKey[]>();
    const authorised: DelegationRecord[] = [];
    for (const delegation of covering) {
      let permissions = held.get(delegation.delegatorId);
      if (permissions === undefined) {
        permissions = await this.holdingsOf(delegation.delegatorId);
        held.set(delegation.delegatorId, permissions);
      }
      if (permissions.includes(input.permission)) {
        authorised.push(delegation);
      }
    }
    return authorised;
  }

  listActive(userId: UserId, at: Date): Promise<readonly DelegationRecord[]> {
    return this.writer.read(() => this.delegations.listActiveFor(userId, at));
  }

  // --- Requesting ---------------------------------------------------------------------------

  /**
   * The ordinary path: somebody asks to be covered, and somebody who is not a party to it agrees.
   *
   * Everything that can refuse refuses before anything is written, for the reason the engine's
   * submission does: a delegation row that existed while its chain was being validated would be a
   * row visible to the authority predicate for the length of a transaction.
   */
  async request(input: {
    readonly delegateId: UserId;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly permissions: readonly PermissionKey[];
    readonly reason: string | null;
  }): Promise<DelegationId> {
    const delegator = this.requireActor();
    const [maximumDays, requireApproval, chainingAllowed] = await Promise.all([
      this.settings.get(Settings.DELEGATION_MAXIMUM_DAYS),
      this.settings.get(Settings.DELEGATION_REQUIRE_APPROVAL),
      this.settings.get(Settings.DELEGATION_ALLOW_CHAINING),
    ]);

    return this.writer.write<DelegationId>(async () => {
      const now = this.writer.clock.now();
      // Resolved *inside* the transaction, with everything else this write reads. The directory is
      // a repository over Identity's own tables and joins the ambient unit of work; resolving the
      // approvers beforehand would also mean naming, in a published event, a set of managers that
      // could have changed before the row committed.
      const approvers = requireApproval ? await this.directory.managersOf(delegator) : [];
      await this.refuseUnlessDelegable({
        delegatorId: delegator,
        delegateId: input.delegateId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        permissions: input.permissions,
        maximumDays,
        chainingAllowed,
        now,
      });

      const id = asId<DelegationId>(this.writer.clock.nextId());
      const depth = proposedDelegationDepth(delegator, await this.delegations.liveEdges(now));
      // Approval is skipped only when the tenant has turned it off — never because nobody could be
      // found to give it. A delegation that activated itself for want of a manager would make
      // "unmanaged" the way to bypass the control.
      const status = requireApproval ? DelegationStatus.PENDING_APPROVAL : DelegationStatus.ACTIVE;

      await this.delegations.create({
        id,
        delegatorId: delegator,
        delegateId: input.delegateId,
        kind: DelegationKind.STANDARD,
        status,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        permissions: input.permissions,
        reason: input.reason,
        depth,
        requestedAt: now,
        // Self-approved is not what this means: with the setting off there is no approval step at
        // all, and naming an approver who did not approve would be a false statement in the trail.
        approvedById: null,
        approvedAt: requireApproval ? null : now,
        declineReason: null,
        revokedById: null,
        revokedAt: null,
        revokeReason: null,
        version: 1,
      });

      await this.outbox.publish([
        requireApproval
          ? delegationRequestedEvent(asId<AnyId>(id), {
              delegationId: id,
              delegatorId: delegator,
              delegateId: input.delegateId,
              approverIds: [...approvers],
              startsAt: input.startsAt.toISOString(),
              endsAt: input.endsAt.toISOString(),
            })
          : delegationApprovedEvent(asId<AnyId>(id), {
              delegationId: id,
              delegatorId: delegator,
              delegateId: input.delegateId,
              startsAt: input.startsAt.toISOString(),
              endsAt: input.endsAt.toISOString(),
            }),
      ]);

      return {
        result: id,
        change: {
          action: DelegationAudit.DELEGATION_CREATED,
          subjectType: AuditSubjectType.DELEGATION,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.CREATED,
          after: {
            delegatorId: delegator,
            delegateId: input.delegateId,
            kind: DelegationKind.STANDARD,
            status,
            permissions: [...input.permissions],
            startsAt: input.startsAt.toISOString(),
            endsAt: input.endsAt.toISOString(),
            depth,
            approvalRequired: requireApproval,
          },
        },
      };
    });
  }

  /**
   * The emergency path: no approval, a much tighter bound, a mandatory ground.
   *
   * The ground goes to `change.reason` rather than into the payload, and that placement is the
   * whole of how an emergency delegation is distinguishable in the trail. `audit_event.reason` is
   * a column Phase 9's digest attests and the verifier can address; a payload field is attested
   * only as part of a blob nothing points at. A bypass of a control belongs in the attested one.
   */
  async declareEmergency(input: {
    readonly delegateId: UserId;
    readonly endsAt: Date;
    readonly permissions: readonly PermissionKey[];
    readonly reason: string;
  }): Promise<DelegationId> {
    const delegator = this.requireActor();
    const [maximumHours, chainingAllowed] = await Promise.all([
      this.settings.get(Settings.DELEGATION_EMERGENCY_MAXIMUM_HOURS),
      this.settings.get(Settings.DELEGATION_ALLOW_CHAINING),
    ]);

    return this.writer.write<DelegationId>(async () => {
      const now = this.writer.clock.now();
      await this.refuseUnlessDelegable({
        delegatorId: delegator,
        delegateId: input.delegateId,
        // An emergency starts now, by definition. A future-dated emergency is a request.
        startsAt: now,
        endsAt: input.endsAt,
        permissions: input.permissions,
        maximumDays: maximumHours / 24,
        chainingAllowed,
        now,
      });

      const id = asId<DelegationId>(this.writer.clock.nextId());
      const depth = proposedDelegationDepth(delegator, await this.delegations.liveEdges(now));

      await this.delegations.create({
        id,
        delegatorId: delegator,
        delegateId: input.delegateId,
        kind: DelegationKind.EMERGENCY,
        status: DelegationStatus.ACTIVE,
        startsAt: now,
        endsAt: input.endsAt,
        permissions: input.permissions,
        reason: input.reason,
        depth,
        requestedAt: now,
        approvedById: null,
        approvedAt: now,
        declineReason: null,
        revokedById: null,
        revokedAt: null,
        revokeReason: null,
        version: 1,
      });

      await this.outbox.publish([
        delegationApprovedEvent(asId<AnyId>(id), {
          delegationId: id,
          delegatorId: delegator,
          delegateId: input.delegateId,
          startsAt: now.toISOString(),
          endsAt: input.endsAt.toISOString(),
        }),
      ]);

      return {
        result: id,
        change: {
          action: DelegationAudit.DELEGATION_CREATED,
          subjectType: AuditSubjectType.DELEGATION,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.CREATED,
          reason: input.reason,
          after: {
            delegatorId: delegator,
            delegateId: input.delegateId,
            kind: DelegationKind.EMERGENCY,
            status: DelegationStatus.ACTIVE,
            permissions: [...input.permissions],
            startsAt: now.toISOString(),
            endsAt: input.endsAt.toISOString(),
            depth,
            // Stated positively in the payload as well, so a report can filter on it without
            // inferring the bypass from the absence of an approver.
            approvalBypassed: true,
          },
        },
      };
    });
  }

  // --- Agreeing, and refusing -----------------------------------------------------------------

  async approve(id: DelegationId): Promise<void> {
    const approver = this.requireActor();

    await this.writer.write(async () => {
      const delegation = await this.lockAndLoad(id);
      await this.refuseUnlessApprover(delegation, approver);
      if (delegation.status !== DelegationStatus.PENDING_APPROVAL) {
        throw new ValidationError('This delegation is not waiting for approval.', [
          { field: 'status', message: delegation.status },
        ]);
      }

      const now = this.writer.clock.now();
      if (delegation.endsAt.getTime() <= now.getTime()) {
        // Approving something already over would write an `ACTIVE` row that authorises nothing,
        // and the sweep would then record it as expired — an arrangement that existed only in the
        // trail. Refused with the reason, so the delegator asks again with dates that work.
        throw new ValidationError('This delegation’s period has already ended.', [
          { field: 'endsAt', message: DelegationPeriodProblem.ALREADY_ENDED },
        ]);
      }

      const moved = await this.delegations.transition({
        id,
        from: [DelegationStatus.PENDING_APPROVAL],
        to: DelegationStatus.ACTIVE,
        at: now,
        approvedById: approver,
      });
      if (!moved) {
        throw new ValidationError('This delegation is no longer waiting for approval.', [
          { field: 'status', message: 'moved' },
        ]);
      }

      await this.outbox.publish([
        delegationApprovedEvent(asId<AnyId>(id), {
          delegationId: id,
          delegatorId: delegation.delegatorId,
          delegateId: delegation.delegateId,
          startsAt: delegation.startsAt.toISOString(),
          endsAt: delegation.endsAt.toISOString(),
        }),
      ]);

      return {
        result: undefined,
        change: {
          action: DelegationAudit.DELEGATION_CREATED,
          subjectType: AuditSubjectType.DELEGATION,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.UPDATED,
          before: { status: DelegationStatus.PENDING_APPROVAL },
          after: {
            status: DelegationStatus.ACTIVE,
            approvedById: approver,
            delegatorId: delegation.delegatorId,
            delegateId: delegation.delegateId,
          },
        },
      };
    });
  }

  /**
   * An approver refusing a request.
   *
   * Recorded under `DELEGATION_CREATED` with a `DECLINED` status rather than under an action of its
   * own, because §2's catalogue names four Delegation actions and a declined request authorised
   * nothing. The refusal and its ground are on the row; the trail says the arrangement was asked
   * for and did not come into force.
   */
  async decline(id: DelegationId, reason: string): Promise<void> {
    const approver = this.requireActor();

    await this.writer.write(async () => {
      const delegation = await this.lockAndLoad(id);
      await this.refuseUnlessApprover(delegation, approver);

      const moved = await this.delegations.transition({
        id,
        from: [DelegationStatus.PENDING_APPROVAL],
        to: DelegationStatus.DECLINED,
        at: this.writer.clock.now(),
        declineReason: reason,
      });
      if (!moved) {
        throw new ValidationError('This delegation is not waiting for approval.', [
          { field: 'status', message: delegation.status },
        ]);
      }

      return {
        result: undefined,
        change: {
          action: DelegationAudit.DELEGATION_CREATED,
          subjectType: AuditSubjectType.DELEGATION,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.UPDATED,
          reason,
          before: { status: DelegationStatus.PENDING_APPROVAL },
          after: { status: DelegationStatus.DECLINED, declinedById: approver },
        },
      };
    });
  }

  // --- Ending -----------------------------------------------------------------------------

  /**
   * §4: "revocation is immediate; in-flight tasks revert to the delegator".
   *
   * Both halves are one fact rather than two operations, and that is the design. No task is
   * touched, because no task ever moved: the delegate was never the assignee, so the moment this
   * row stops being `ACTIVE` the authority predicate stops returning it and every in-flight task is
   * the delegator's again — which it always was. A revocation that had to walk tasks and reassign
   * them would be the version of delegation that moves work, and that version cannot revert
   * anything atomically.
   *
   * A decision arriving at the same instant does not slip through: the engine takes the approval
   * instance's row lock before it asks about authority, and this transaction commits before or
   * after that read rather than during it.
   */
  async revoke(id: DelegationId, reason: string): Promise<void> {
    const actor = this.requireActor();

    await this.writer.write(async () => {
      const delegation = await this.lockAndLoad(id);
      // The delegator, or somebody holding the tenant-wide grant. Not the delegate: giving back an
      // authority is not the same act as taking it away, and only one of them ends the delegator's
      // cover without their knowledge.
      if (delegation.delegatorId !== actor && !this.holds(Permission.USER_MANAGE)) {
        throw new ForbiddenError('revoke somebody else’s delegation');
      }

      const moved = await this.delegations.transition({
        id,
        from: [DelegationStatus.PENDING_APPROVAL, DelegationStatus.ACTIVE],
        to: DelegationStatus.REVOKED,
        at: this.writer.clock.now(),
        revokedById: actor,
        revokeReason: reason,
      });
      if (!moved) {
        throw new ValidationError('This delegation has already ended.', [
          { field: 'status', message: delegation.status },
        ]);
      }

      await this.outbox.publish([
        delegationRevokedEvent(asId<AnyId>(id), {
          delegationId: id,
          revokedBy: actor,
          reason,
        }),
      ]);

      return {
        result: undefined,
        change: {
          action: DelegationAudit.DELEGATION_REVOKED,
          subjectType: AuditSubjectType.DELEGATION,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.UPDATED,
          reason,
          before: { status: delegation.status },
          after: {
            status: DelegationStatus.REVOKED,
            revokedById: actor,
            delegatorId: delegation.delegatorId,
            delegateId: delegation.delegateId,
          },
        },
      };
    });
  }

  /**
   * The nightly sweep: records the delegations whose period has ended.
   *
   * **Records**, and nothing more. What makes a delegation past its end date inert is the
   * predicate in `authorityFor`, which has already refused it however long ago this last ran — so
   * a stalled queue delays a row's status and an audit event, never a refusal. The event exists
   * because `DELEGATION_EXPIRED` is in §2's catalogue and an action has to be written by
   * something, and writing it lazily when somebody next looked would date it to whenever that was,
   * or to never.
   *
   * One transaction per delegation, for the reason Phase 10's sweep settles one schedule at a
   * time: a pass that failed on the ninetieth would otherwise roll back eighty-nine audit rows
   * describing expiries that had genuinely happened.
   */
  async expireEnded(limit: number): Promise<number> {
    const due = await this.writer.read(() =>
      this.delegations.listEndedButActive(this.writer.clock.now(), limit),
    );

    let recorded = 0;
    for (const delegation of due) {
      const moved = await this.writer.write<boolean>(async () => {
        const now = this.writer.clock.now();
        const transitioned = await this.delegations.transition({
          id: delegation.id,
          // Only from `ACTIVE`: one revoked between the read and this write ended by somebody's
          // decision, and recording it as expired would overwrite that fact with a clock's.
          from: [DelegationStatus.ACTIVE],
          to: DelegationStatus.EXPIRED,
          at: now,
        });
        if (!transitioned) {
          return { result: false, change: this.noop(delegation.id) };
        }

        const uses = await this.delegations.usesOf(delegation.id);
        await this.outbox.publish([
          delegationExpiredEvent(asId<AnyId>(delegation.id), {
            delegationId: delegation.id,
            delegatorId: delegation.delegatorId,
            delegateId: delegation.delegateId,
            endsAt: delegation.endsAt.toISOString(),
            useCount: uses.length,
          }),
        ]);

        return {
          result: true,
          change: {
            action: DelegationAudit.DELEGATION_EXPIRED,
            subjectType: AuditSubjectType.DELEGATION,
            subjectId: asId<AnyId>(delegation.id),
            operation: AdministrativeOperation.UPDATED,
            before: { status: DelegationStatus.ACTIVE },
            after: {
              status: DelegationStatus.EXPIRED,
              delegatorId: delegation.delegatorId,
              delegateId: delegation.delegateId,
              endsAt: delegation.endsAt.toISOString(),
              useCount: uses.length,
            },
          },
        };
      });
      if (moved) {
        recorded += 1;
      }
    }
    return recorded;
  }

  // --- The read side --------------------------------------------------------------------------

  async list(request: {
    readonly page: number;
    readonly pageSize: number;
    readonly direction: 'GIVEN' | 'RECEIVED' | 'AWAITING_MY_APPROVAL';
    readonly status?: DelegationListRequest['status'];
    readonly includeEnded: boolean;
  }): Promise<Page<DelegationView>> {
    const caller = this.requireActor();

    return this.writer.read(async () => {
      // Inside the unit of work for the same reason: `subordinatesOf` reads Identity's tables.
      const approvable =
        request.direction === 'AWAITING_MY_APPROVAL' ? await this.approvableBy(caller) : undefined;
      return this.delegations.list({
        page: request.page,
        pageSize: request.pageSize,
        userId: caller,
        direction: request.direction,
        includeEnded: request.includeEnded,
        ...(request.status !== undefined && { status: request.status }),
        ...(approvable !== undefined && { approvableDelegatorIds: approvable }),
      });
    });
  }

  /**
   * Everything decided under one delegation — §4's visibility rule.
   *
   * Readable by either party and by a holder of the tenant-wide grant. The *delegate* may read it
   * too, deliberately: it is a list of things they themselves did, and hiding somebody's own
   * decisions from them would be a strange kind of privacy.
   */
  async uses(id: DelegationId): Promise<readonly DelegationUseRecord[]> {
    const caller = this.requireActor();
    return this.writer.read(async () => {
      const delegation = await this.delegations.findById(id);
      if (delegation === null) {
        throw new NotFoundError('The requested delegation');
      }
      if (
        delegation.delegatorId !== caller &&
        delegation.delegateId !== caller &&
        !this.holds(Permission.USER_MANAGE)
      ) {
        throw new ForbiddenError('read somebody else’s delegation history');
      }
      return this.delegations.usesOf(id);
    });
  }

  // --- Internals ------------------------------------------------------------------------------

  /**
   * Everything that refuses a delegation before it exists, in one place.
   *
   * The delegate is a real, live person; the delegator holds what they are passing; the period is
   * bounded and ordered; and the chain is neither too deep nor a cycle. The order runs cheapest
   * first, except that the chain walk comes last because it is the only one that reads the whole
   * tenant.
   */
  /**
   * What a delegator can pass on *right now* — Slice 28.
   *
   * The one place the question "what does the delegator hold" is answered, because §4's rule is
   * checked at three moments and answering it three ways is how they drift apart. Two of the three
   * ask it about somebody who is not present: `authorise` decides a task for an absent delegator,
   * and `cover` builds a delegate's inbox from absent delegators' grants.
   *
   * **An account that cannot sign in holds nothing to pass on.** `findById` already filters a
   * deleted user, so a *deleted* delegator conferred nothing the moment they were deleted; a
   * *disabled* one kept conferring everything until the delegation's end date, which inverted the
   * two administrative actions — the reversible one was the weaker of the two. Disabling is what a
   * tenant reaches for on an offboarding or a suspension pending investigation, and it is exactly
   * the case where authority continuing by proxy is worst: the delegate goes on approving in the
   * name of an account the tenant has just switched off, and the trail records the approval as the
   * disabled person's own task.
   *
   * `canSignIn` rather than a new predicate, because it is already the product's answer to "may
   * this stored user act": `AuthenticationService.refresh` ends a session with it,
   * `ApiClientService` refuses to issue and to authenticate with it, and `activeAmong` — the same
   * `status = ACTIVE` as a query — is what keeps a disabled person out of a workflow's
   * participants and off the receiving end of a new delegation. This was the fourth such path and
   * the only one that did not ask.
   *
   * Refusing here needs no new refusal key: `DELEGATOR_LACKS_AUTHORITY` already means "the
   * delegator does not hold this", which is true of somebody who holds nothing at all. Nothing is
   * written and no delegation is cancelled — the row stays `ACTIVE` and starts authorising again
   * the moment the account is re-enabled, which is the same shape as the role-withdrawal case and
   * the reason neither needs a compensating job.
   */
  private async holdingsOf(delegatorId: UserId): Promise<readonly PermissionKey[]> {
    const delegator = await this.credentials.findById(delegatorId);
    return delegator !== null && canSignIn(delegator.status) ? delegator.permissions : [];
  }

  private async refuseUnlessDelegable(input: {
    readonly delegatorId: UserId;
    readonly delegateId: UserId;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly permissions: readonly PermissionKey[];
    readonly maximumDays: number;
    readonly chainingAllowed: boolean;
    readonly now: Date;
  }): Promise<void> {
    const [live] = await this.directory.activeAmong([input.delegateId]);
    if (live === undefined) {
      // Never "silently nobody". A delegation to a disabled account is an arrangement whose
      // delegate can never sign in, and it would look exactly like cover that is in place.
      throw new ValidationError('That person cannot be delegated to.', [
        { field: 'delegateId', message: 'not active' },
      ]);
    }

    // §4 at creation time: what a delegator does not hold, they cannot pass. This is *not* the
    // authority check — that one happens again at decision time, and it is the one that counts.
    // Refusing here as well is a courtesy: it stops somebody arranging cover that was never going
    // to work, rather than letting them find out when a decision is refused.
    const holds = new Set<string>(await this.holdingsOf(input.delegatorId));
    const notHeld = input.permissions.filter((permission) => !holds.has(permission));
    if (notHeld.length > 0) {
      throw new ValidationError('You cannot delegate a permission you do not hold.', [
        { field: 'permissions', message: notHeld.join(', ') },
      ]);
    }

    const period = delegationPeriodProblem({
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      now: input.now,
      maximumDays: input.maximumDays,
    });
    if (period !== null) {
      throw new ValidationError(periodMessage(period), [{ field: 'endsAt', message: period }]);
    }

    const chain = delegationChainProblem({
      delegatorId: input.delegatorId,
      delegateId: input.delegateId,
      live: await this.delegations.liveEdges(input.now),
      chainingAllowed: input.chainingAllowed,
    });
    if (chain !== null) {
      throw new ValidationError(chainMessage(chain), [{ field: 'delegateId', message: chain }]);
    }
  }

  /**
   * Who may agree to a delegation: a manager of the delegator, or a holder of `user:manage` who is
   * party to neither side.
   *
   * The second permission is `user:manage` and **not** `delegation:manage`, and the difference is
   * the phase's sharpest constraint rather than a preference. `delegation:manage` is `own`-scoped
   * in the Phase 1 seed — granted to `AUTHOR` and `APPROVER` with the comment that "an author may
   * delegate their own approvals, and the use case enforces the subject" — and the request context
   * carries a permission key with no scope beside it. So `delegation:manage` cannot be read here as
   * "may administer delegations generally": every author holds it, and treating it that way would
   * let any author approve any other author's request, which is the control not existing.
   *
   * `user:manage` is unambiguous. The seed grants it to `TENANT_ADMIN` alone, it is `✓` rather than
   * `own` or `S` in 08 §6's matrix, and it is already the grant that means "administers people".
   * Both parties are excluded explicitly, so an administrator who is themselves the delegate cannot
   * wave through their own cover.
   */
  private async refuseUnlessApprover(
    delegation: DelegationRecord,
    approver: UserId,
  ): Promise<void> {
    if (approver === delegation.delegatorId || approver === delegation.delegateId) {
      throw new ForbiddenError('approve a delegation you are a party to');
    }
    const managers = await this.directory.managersOf(delegation.delegatorId);
    if (managers.includes(approver)) {
      return;
    }
    if (!this.holds(Permission.USER_MANAGE)) {
      throw new ForbiddenError('approve this delegation');
    }
  }

  /**
   * Whose requests this caller may approve — the `AWAITING_MY_APPROVAL` list's own filter.
   *
   * `undefined` means "no filter", which is what a tenant administrator's `user:manage` earns.
   * Everybody else sees the requests of the people they manage, and nothing else — the same
   * relationship that authorises the approval, asked in the other direction so the queue and the
   * refusal can never disagree about who is in it.
   */
  private async approvableBy(caller: UserId): Promise<readonly UserId[] | undefined> {
    if (this.holds(Permission.USER_MANAGE)) {
      return undefined;
    }
    return this.directory.subordinatesOf(caller);
  }

  private async lockAndLoad(id: DelegationId): Promise<DelegationRecord> {
    if (!(await this.delegations.lock(id))) {
      throw new NotFoundError('The requested delegation');
    }
    const delegation = await this.delegations.findById(id);
    if (delegation === null) {
      throw new NotFoundError('The requested delegation');
    }
    return delegation;
  }

  private holds(permission: PermissionKey): boolean {
    return requireContext().permissions.includes(permission);
  }

  private requireActor(): UserId {
    const { userId } = requireContext();
    if (userId === null) {
      throw new ForbiddenError('act on a delegation without a signed-in user');
    }
    return userId;
  }

  /** `AdministeredWriter` writes one event per transaction; this is what a no-op pass records. */
  private noop(id: DelegationId): {
    action: string;
    subjectType: typeof AuditSubjectType.DELEGATION;
    subjectId: AnyId;
    operation: typeof AdministrativeOperation.UPDATED;
    after: Record<string, unknown>;
  } {
    return {
      action: DelegationAudit.DELEGATION_EXPIRED,
      subjectType: AuditSubjectType.DELEGATION,
      subjectId: asId<AnyId>(id),
      operation: AdministrativeOperation.UPDATED,
      after: { effect: 'none' },
    };
  }
}

/**
 * The refusal worth telling somebody about, when two delegations refuse differently.
 *
 * Ordered by how actionable each one is. "The delegator no longer holds it" names a thing an
 * administrator can fix; "there is no delegation" names nothing at all, and reporting it over the
 * other would send somebody looking for an arrangement that exists.
 */
const REFUSAL_SPECIFICITY: readonly string[] = [
  DelegationRefusal.NONE,
  DelegationRefusal.NOT_IN_FORCE,
  DelegationRefusal.OUTSIDE_PERIOD,
  DelegationRefusal.PERMISSION_NOT_DELEGATED,
  DelegationRefusal.DELEGATOR_LACKS_AUTHORITY,
];

function moreSpecific<T extends string>(current: T, candidate: T): T {
  return REFUSAL_SPECIFICITY.indexOf(candidate) > REFUSAL_SPECIFICITY.indexOf(current)
    ? candidate
    : current;
}

function periodMessage(problem: string): string {
  switch (problem) {
    case DelegationPeriodProblem.NOT_ORDERED:
      return 'A delegation has to end after it starts.';
    case DelegationPeriodProblem.ALREADY_ENDED:
      return 'That period has already passed.';
    default:
      return 'That is longer than this organisation allows a delegation to run.';
  }
}

function chainMessage(problem: string): string {
  switch (problem) {
    case DelegationChainProblem.CHAINING_FORBIDDEN:
      return 'You are acting under somebody else’s delegation, which this organisation does not allow you to pass on.';
    case DelegationChainProblem.TOO_DEEP:
      return 'A delegated authority may be passed on once, and no further.';
    default:
      return 'That would send the authority back to somebody who has already passed it on.';
  }
}
