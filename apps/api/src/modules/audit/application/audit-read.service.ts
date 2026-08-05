import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type AuditSubjectTypeKey,
  AuditSubjectType,
  Permission,
  ScopeType,
  type ScopeRef,
  type UserId,
  asId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import { AccessDenialRecorder } from '../../../core/authorization/access-denial.recorder';
import {
  ACL_RESOLVER,
  type AclResolver,
  type AuthorizationSubject,
} from '../../../core/authorization/acl-resolver.port';
import { NotFoundError } from '../../../core/errors/application-errors';
import { AdministeredWriter } from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  AUDIT_REPOSITORY,
  type AuditEventRecord,
  type AuditRepository,
  type AuditSearchCriteria,
} from './ports';

/**
 * Reading the trail — the half of `13-audit-architecture.md` §6 that had never been built.
 *
 * ## The decision this class exists to record: how a timeline is filtered
 *
 * 13 §6 requires a document timeline to be "filtered to what the caller may see", and the audit
 * row model makes the obvious reading impossible. A row carries `(subject_type, subject_id)` and
 * nothing else — no folder, no library, no scope chain — so there is nothing on the row to push a
 * `visibilityFilter` predicate against. Worse, Phase 8's `SEARCH` rows carry the *actor's own user
 * id* as `subject_id`, which is the first subject in the product that is not a domain object at
 * all; a per-row object lookup would find no such document and would have to guess.
 *
 * And a per-row lookup would be wrong even where it worked. Audit outlives its subject (§1): a
 * purged document's trail remains, deliberately, with its number preserved. A filter that resolved
 * each row's object would silently hide exactly the history that matters most — the trail of a
 * thing that no longer exists.
 *
 * **So the decision is resolved once, at the subject, before the query runs.** A timeline request
 * names one object; whether the caller may see that object is one question, asked of `ACL_RESOLVER`
 * — the same port, the same binding and the same algorithm Phase 8 bound for search, because an
 * audit timeline is a second call site for a question the product already answers in one place, and
 * inventing a different answer inside this module is the defect 08's rule exists to prevent. Every
 * row in the page is about that object, so one decision covers the page exactly.
 *
 * A refusal is a `404`, not a `403`: 08 §7's "cross-scope reads return 404, not 403, so existence
 * is not leaked" applies here more than anywhere, because the existence of a *trail* for a document
 * number is itself an answer worth harvesting.
 *
 * ## Why the audit search is filtered differently, and how
 *
 * A search spans subjects, so there is no single object to resolve. 13 §6 gates it on `audit:view`
 * and says nothing further, and 08 §6 grants `audit:view` to the tenant administrator, the document
 * controller and the auditor — three roles whose whole definition is reading the trail. That grant
 * *is* the filter: narrowing an auditor's search by document ACLs would produce an auditor who
 * cannot audit, which is the opposite of the row 08 §5 wrote for them ("Reads everything in scope
 * plus the audit trail").
 *
 * What the search does *not* do is become a back door into a timeline: the two surfaces are
 * separate, `audit:view` gates only the search, and a caller holding `document:view` alone reaches
 * a timeline and never the search. `library manager` is the matrix's one `S` on `audit:view` — a
 * scoped grant — and scoped grants arrive with the ACL entries the permission phase builds; until
 * then the resolver answers it as the tenant-level grant it currently is, which is the same
 * position Phase 8 recorded and not a new one taken here.
 */
@Injectable()
export class AuditReadService {
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    private readonly denials: AccessDenialRecorder,
    private readonly writer: AdministeredWriter,
  ) {}

  async timelineFor(
    subjectType: AuditSubjectTypeKey,
    subjectId: AnyId,
    page: PageRequest,
  ): Promise<Page<AuditEventRecord>> {
    await this.refuseUnlessVisible(subjectType, subjectId);
    return this.writer.read(() => this.repository.listForSubject(subjectId, page));
  }

  search(criteria: AuditSearchCriteria, page: PageRequest): Promise<Page<AuditEventRecord>> {
    return this.writer.read(() => this.repository.search(criteria, page));
  }

  actions(): Promise<readonly string[]> {
    return this.writer.read(() => this.repository.distinctActions());
  }

  /**
   * One decision, for the whole page.
   *
   * The permission asked for is the *subject's* own read permission rather than `audit:view`,
   * because that is what "what the caller may see" means: an author who may read a procedure may
   * see who else has read it, and `audit:view` is the trail-wide grant that the search is gated on
   * instead. The route additionally carries `document:history:view`, which is where "may I see
   * this document's history at all" is decided — this is the *reach* question, on this object.
   */
  private async refuseUnlessVisible(
    subjectType: AuditSubjectTypeKey,
    subjectId: AnyId,
  ): Promise<void> {
    const context = requireContext();
    // A caller holding the trail-wide grant has already been answered: `audit:view` is the
    // permission whose entire meaning is "may read the audit trail", and re-asking the object
    // question of an auditor would deny them the timelines their role exists to read.
    if (context.permissions.includes(Permission.AUDIT_VIEW)) {
      return;
    }

    const scope = scopeFor(subjectType, subjectId);
    if (scope === null) {
      // A subject with no scope of its own — a `SEARCH` row is about the search capability and
      // carries the actor's user id, a `SESSION` row is about a sign-in. There is no object to
      // resolve, so there is no reading of "what the caller may see" that is not simply the
      // trail-wide grant, and the caller does not hold it.
      throw new NotFoundError('The requested resource');
    }

    const subject: AuthorizationSubject = {
      userId: context.userId ?? asId<UserId>(''),
      roleIds: context.roles.map((role) => asId<AnyId>(role)),
      departmentIds: [],
      delegationIds: [],
    };
    const decision = await this.writer.read(() =>
      this.acl.resolve(subject, scope, Permission.DOCUMENT_VIEW),
    );
    if (!decision.allowed) {
      // 08 §7, through the one recorder `AclGuard` uses. A refused timeline is a denied attempt
      // on an object like any other, and recording it differently here would give a compliance
      // report two spellings of one refusal.
      await this.denials.record({
        scopeType: scope.type,
        subjectId: subjectId,
        permission: Permission.DOCUMENT_VIEW,
        reason: decision.reason,
      });
      throw new NotFoundError('The requested resource');
    }
  }
}

/**
 * The scope an audit subject resolves through, or null when it has none.
 *
 * The mapping is deliberately narrow. `DOCUMENT`, `FOLDER` and `LIBRARY` are nodes on the scope
 * tree 08 §3 walks, and a `REVISION`'s trail is the document's. Everything else — a role, a
 * configuration row, a session, a search — is either tenant-wide administration or not an object
 * at all, and both are the trail-wide grant's business rather than an ACL walk's.
 */
function scopeFor(subjectType: AuditSubjectTypeKey, subjectId: AnyId): ScopeRef | null {
  switch (subjectType) {
    case AuditSubjectType.DOCUMENT:
    case AuditSubjectType.REVISION:
      return { type: ScopeType.DOCUMENT, id: subjectId };
    case AuditSubjectType.FOLDER:
      return { type: ScopeType.FOLDER, id: subjectId };
    case AuditSubjectType.LIBRARY:
      return { type: ScopeType.LIBRARY, id: subjectId };
    default:
      return null;
  }
}
