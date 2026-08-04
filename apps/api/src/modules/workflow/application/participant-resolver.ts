import { Inject, Injectable } from '@nestjs/common';

import {
  ManagerOfSubject,
  ParticipantKind,
  ParticipantScope,
  type UserId,
  asId,
} from '@edms/domain';
import type { Participant } from '@edms/contracts';

import { ValidationError } from '../../../core/errors/application-errors';
import {
  type DocumentApprovalContext,
  type RoleScope,
  WORKFLOW_DIRECTORY,
  type WorkflowDirectory,
} from './ports';

/**
 * Turning a stage's participant resolvers into the people who will be asked.
 *
 * `07-workflow-architecture.md` §2 fixes two things about this, and both are easy to get subtly
 * wrong in ways nothing would notice for months.
 *
 * **Resolution happens at stage activation**, against the document's own context — never at
 * definition time, and never cached from an earlier stage. A definition says "the author's
 * manager"; who that is on the day the stage activates is the answer, and a workflow authored two
 * reorganisations ago still routes correctly because it never stored a name.
 *
 * **A resolver that yields nobody fails loudly.** §8 lists "skip a stage whose participants resolve
 * empty" as something the engine must never do, and calls it a silent loss of a control. So an
 * empty resolution is a refusal naming *which* resolver produced nothing — the whole point being
 * that somebody can fix it — rather than a stage that quietly did not run.
 *
 * The distinction from a **skipped** stage matters and is deliberate: a stage whose *condition*
 * does not hold is scoped away by the definition and is skipped; a stage whose *people* cannot be
 * found is broken and stops the submission. From outside they look alike, which is exactly why the
 * engine keeps them apart.
 */
@Injectable()
export class ParticipantResolver {
  constructor(@Inject(WORKFLOW_DIRECTORY) private readonly directory: WorkflowDirectory) {}

  /**
   * The people a stage will ask, in the order its resolvers name them.
   *
   * Order is preserved and duplicates are dropped keeping the first occurrence, because in an
   * `ordered` stage the position *is* the sequence: a definition listing the author's manager and
   * then the quality manager means the manager decides first. De-duplicating from the end would
   * silently reorder somebody's approval chain.
   */
  async resolve(
    participants: readonly Participant[],
    context: DocumentApprovalContext,
    stageName: string,
    previousApprovers: readonly UserId[],
  ): Promise<readonly ResolvedParticipant[]> {
    const resolved: ResolvedParticipant[] = [];
    const seen = new Set<string>();
    const empty: string[] = [];

    for (const participant of participants) {
      const found = await this.resolveOne(participant, context, previousApprovers);
      if (found.length === 0) {
        empty.push(describe(participant));
        continue;
      }
      for (const userId of found) {
        if (seen.has(userId)) {
          // One person named twice is one task. Two tasks for one person would count twice toward
          // a quorum, which is why the database refuses the pair as well.
          continue;
        }
        seen.add(userId);
        resolved.push({ userId, resolvedBy: describe(participant) });
      }
    }

    // Filtered once, at the end, rather than inside each resolver: the round trip is per stage
    // rather than per resolver, and a resolver whose every candidate is disabled is reported as
    // empty by the check below, in the same sentence as one that matched nobody at all.
    const active = new Set(await this.directory.activeAmong(resolved.map((entry) => entry.userId)));
    const live = resolved.filter((entry) => active.has(entry.userId));

    if (live.length === 0) {
      throw new ValidationError(
        `No one could be found to approve “${stageName}”. The workflow cannot start until somebody can.`,
        [
          {
            field: 'participants',
            message:
              empty.length > 0
                ? `These resolved to nobody: ${empty.join(', ')}.`
                : 'Everybody they resolved to is inactive.',
          },
        ],
      );
    }
    return live;
  }

  private async resolveOne(
    participant: Participant,
    context: DocumentApprovalContext,
    previousApprovers: readonly UserId[],
  ): Promise<readonly UserId[]> {
    switch (participant.kind) {
      case ParticipantKind.USER:
        return [asId<UserId>(participant.userId)];

      case ParticipantKind.OWNER:
        return [context.ownerUserId];

      case ParticipantKind.ROLE:
        return this.directory.holdersOfRole(
          participant.roleKey,
          scopeFor(participant.scope, context),
        );

      case ParticipantKind.DEPARTMENT:
        return this.directory.membersOfDepartment(
          participant.departmentId,
          participant.managersOnly,
        );

      case ParticipantKind.GROUP:
        return this.directory.membersOfGroup(participant.groupKey);

      case ParticipantKind.DOCUMENT_FIELD: {
        // The user named in a metadata field — "Reviewer". Absent is a legitimate answer for an
        // optional field, and it is reported as an empty resolver rather than as an error, so the
        // refusal names the field the author has to fill in.
        const named = context.userFields.get(participant.fieldKey);
        return named === undefined ? [] : [named];
      }

      case ParticipantKind.MANAGER_OF:
        return this.managersOf(participant.of, context, previousApprovers);

      default:
        // The kind set is closed and the wire schema validates against it, so this is a stored
        // version written by something other than the product. Empty, which the caller turns into
        // a refusal naming the resolver — rather than a throw that would name nothing useful.
        return [];
    }
  }

  /**
   * The managers of whoever the subject turns out to be.
   *
   * `PREVIOUS_APPROVER` is the one that needs the extra argument, and it is why participants are
   * resolved per stage rather than once for the whole instance: the previous approver is not known
   * until the previous stage has finished deciding.
   */
  private async managersOf(
    of: (typeof ManagerOfSubject)[keyof typeof ManagerOfSubject],
    context: DocumentApprovalContext,
    previousApprovers: readonly UserId[],
  ): Promise<readonly UserId[]> {
    const subject = ((): UserId | null => {
      switch (of) {
        case ManagerOfSubject.AUTHOR:
          // The author, falling back to the owner. A document created by provisioning or an import
          // has no author, and the owner is the person accountable for it either way.
          return context.authorUserId ?? context.ownerUserId;
        case ManagerOfSubject.OWNER:
          return context.ownerUserId;
        case ManagerOfSubject.PREVIOUS_APPROVER:
          return previousApprovers[previousApprovers.length - 1] ?? null;
        case ManagerOfSubject.ASSIGNEE:
          // "The assignee's manager" only means something once there *is* an assignee, which is
          // during escalation rather than during activation. At activation it is the same person a
          // stage is being created for, so the sensible reading is the author's manager — and
          // guessing otherwise would create a stage assigned to nobody's manager in particular.
          return context.authorUserId ?? context.ownerUserId;
        default:
          return null;
      }
    })();

    return subject === null ? [] : this.directory.managersOf(subject);
  }
}

export interface ResolvedParticipant {
  readonly userId: UserId;
  /** The resolver that produced them, recorded on the task and shown to the person asked. */
  readonly resolvedBy: string;
}

/**
 * A resolver, described in one short string.
 *
 * Stored on the task and used in the refusal a failed resolution produces. Not the raw JSON: the
 * point of both is that a person reads it, and `{"kind":"ROLE","roleKey":"quality-manager"}` in a
 * refusal is not something anybody acts on faster than `ROLE:quality-manager`.
 */
export function describe(participant: Participant): string {
  switch (participant.kind) {
    case ParticipantKind.USER:
      return `USER:${participant.userId}`;
    case ParticipantKind.ROLE:
      return `ROLE:${participant.roleKey}@${participant.scope}`;
    case ParticipantKind.DEPARTMENT:
      return `DEPARTMENT:${participant.departmentId}${participant.managersOnly ? ':managers' : ''}`;
    case ParticipantKind.MANAGER_OF:
      return `MANAGER_OF:${participant.of}`;
    case ParticipantKind.GROUP:
      return `GROUP:${participant.groupKey}`;
    case ParticipantKind.DOCUMENT_FIELD:
      return `DOCUMENT_FIELD:${participant.fieldKey}`;
    case ParticipantKind.OWNER:
      return 'OWNER';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Where a `ROLE` resolver looks for holders.
 *
 * A scope naming a node the document does not have — `DOCUMENT_DEPARTMENT` on a document whose
 * folder belongs to no department — narrows to nothing rather than widening to the tenant. Widening
 * is the dangerous default: it would route an approval meant for one department's quality manager
 * to every quality manager in the organisation, and it would do it silently.
 */
function scopeFor(
  scope: (typeof ParticipantScope)[keyof typeof ParticipantScope],
  context: DocumentApprovalContext,
): RoleScope {
  switch (scope) {
    case ParticipantScope.DOCUMENT_ENTITY:
      return { kind: 'ENTITY', nodeId: context.entityId };
    case ParticipantScope.DOCUMENT_DEPARTMENT:
      return { kind: 'DEPARTMENT', nodeId: context.departmentId };
    default:
      return { kind: 'TENANT', nodeId: null };
  }
}
