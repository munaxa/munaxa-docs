import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type DocumentId,
  type UserId,
  Permission,
  ScopeType,
  asId,
} from '@edms/domain';

import {
  ACL_RESOLVER,
  type AclResolver,
  type AuthorizationSubject,
} from '../../../core/authorization/acl-resolver.port';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { USER_DIRECTORY, type UserDirectory } from '../../identity/application/ports';

/**
 * Who, of a computed recipient list, may be told that a document exists.
 *
 * ## This is the phase's named risk, and this file is the answer to it
 *
 * A recipient list is derived from an event: an approval task's assignee, a document's owner, the
 * author of a revision. Every one of those is a question about who may *see* the document, and
 * `PrismaAclResolver` is the only thing entitled to answer it
 * (`docs/architecture/08-permission-model.md` §3).
 *
 * The failure this prevents is subtle and total. Somebody is removed from a project's folder,
 * keeps an approval task that was assigned before the change, and is emailed "QMS-PROC-0042 —
 * Supplier Audit Procedure has been rejected. Reason: the tolerances in section 4 are wrong."
 * They click the link and are correctly refused. They have still learned the document's number,
 * its title, its state and a sentence of its content. **A notification that tells somebody a
 * document exists is a disclosure even when the link then refuses them** — 18 §8's third and
 * fourth prohibitions, read together.
 *
 * ## Why filtering happens here and not in the resolver
 *
 * The ACL resolver is unchanged by this phase, deliberately, and this is the second consecutive
 * phase to decline to extend it (Phase 11 recorded its reasons in 08 §3). What is needed here is
 * not a new *subject* or a new rule — it is the existing `resolve` asked about somebody other
 * than the caller, which the port has always supported: `AuthorizationSubject` is a parameter,
 * not the request context.
 *
 * ## Why the answer is not cached
 *
 * A notification is sent once, and the walk it costs is one query per recipient per document
 * event. Caching it would mean deciding how long a stale "yes" is acceptable for, and the answer
 * for a disclosure question is zero.
 *
 * ## What is deliberately *not* filtered
 *
 * A recipient list with no document behind it — the two parties to a delegation, an
 * administrator told an address was suppressed, a person told their own password changed. There
 * is no object to resolve, and 18 §4's rows for those name the people by their relationship to
 * the event rather than by what they can see. Passing them through a document walk would refuse
 * every one of them, since the nil document is in nobody's ACL.
 */
@Injectable()
export class RecipientVisibilityService {
  constructor(
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Narrows a recipient list to those who may view the document.
   *
   * Joins the caller's transaction — every consumer wraps this in one — because the walk reads
   * the scope tree and the ACL entries, and reading them outside the transaction the recipients
   * were computed in would answer about a tree that may have changed in between.
   */
  async whoMaySee(
    recipientIds: readonly UserId[],
    documentId: DocumentId,
  ): Promise<readonly UserId[]> {
    const unique = [...new Set(recipientIds)];
    if (unique.length === 0) {
      return [];
    }

    const permitted: UserId[] = [];

    for (const recipientId of unique) {
      const subject = await this.subjectFor(recipientId);
      if (subject === null) {
        continue;
      }
      const decision = await this.acl.resolve(
        subject,
        { type: ScopeType.DOCUMENT, id: documentId },
        Permission.DOCUMENT_VIEW,
      );
      if (decision.allowed) {
        permitted.push(recipientId);
      }
    }

    if (permitted.length < unique.length) {
      // Worth one line, because "the approver stopped being emailed" is otherwise indisting-
      // uishable from a mail outage. The document, never the people: a log is not the place to
      // accumulate a list of who cannot see what.
      this.logger.debug('Some notification recipients may not see the document', {
        documentId,
        considered: unique.length,
        permitted: permitted.length,
      });
    }
    return permitted;
  }

  /**
   * The recipient's own authorisation subject.
   *
   * Identity's, through `USER_DIRECTORY` and nothing else, and asked per recipient at the instant
   * of the send — never cached, and never derived from the request context, which in a queue
   * consumer belongs to nobody at all.
   */
  private async subjectFor(userId: UserId): Promise<AuthorizationSubject | null> {
    const subject = await this.users.authorizationSubjectFor(userId);
    if (subject === null) {
      // Not a live user. Skipped rather than refused, which are the same outcome here and
      // different facts: there is nobody to decide about.
      return null;
    }
    return {
      userId,
      roleIds: subject.roleIds.map((role) => asId<AnyId>(role)),
      /*
       * Empty, so the resolver works the recipient's departments out itself — Slice 23.
       *
       * This used to pass `subject.departmentIds`, read straight from `user_department`, and that
       * one field was the whole of the divergence this file exists to prevent.
       * `PrismaAclResolver.departmentsOf` has two branches: handed a non-empty list it returns it
       * verbatim, and handed an empty one it queries the department table and expands the
       * **materialised path**, so a member of `Quality/Audit` also carries `Quality`.
       *
       * `AclGuard.subjectFor` passes `[]`, and so does every other construction of an
       * `AuthorizationSubject` in the product. This was the only caller that did not, so it was the
       * only one taking the branch without the ancestry — and a recipient whose reach comes from an
       * entry on a *parent* department resolved to a refusal and was silently dropped from a
       * notification about a document they can open. 18 §4 says those people must be told.
       *
       * There is a second reason, and it is why the first went unnoticed. `decisionKey` is built
       * from the tenant, the user, the roles, the scope and the permission — **not** the
       * departments. Two subjects for one person that differ only in their departments share a
       * cache entry, so whichever path ran first decided for both and the disagreement showed up
       * only on a cold cache. Passing `[]` here leaves no caller supplying departments at all,
       * which makes the key complete for every subject the product actually builds.
       */
      departmentIds: [],
      // Empty, deliberately. 08 §3 lost its "active delegations" clause in Phase 11 rather than
      // the resolver gaining a subject, and a recipient's visibility must not depend on cover
      // they were given — which would make a delegation the permission grant 07 §4 forbids.
      delegationIds: [],
    };
  }
}
