import { Inject, Injectable } from '@nestjs/common';

import {
  ALL_PERMISSIONS,
  type AnyId,
  AclEffect,
  AclSubjectType,
  AuditSubjectType,
  type AuditSubjectTypeKey,
  type FolderId,
  Permission,
  ScopeType,
  type ScopeRef,
  asId,
  isPermissionKey,
} from '@edms/domain';

import {
  ACL_RESOLVER,
  type AclResolver,
  type AuthorizationSubject,
} from '../../../core/authorization/acl-resolver.port';
import { NotFoundError, ValidationError } from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import {
  AdministeredWriter,
  AdministrativeOperation,
  checkVersion,
} from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { CACHE_PORT, type CachePort } from '../../../ports/cache.port';
import { LibraryAudit } from '../domain/audit-actions';
import { aclChangedEvent } from '../domain/events';
import {
  ACL_REPOSITORY,
  SCOPE_CHAIN_READER,
  type AclEntryDraft,
  type AclEntryRecord,
  type AclRepository,
  type EffectivePermission,
  type EffectivePermissions,
  type PermissionService,
  type ScopeChainReader,
  type StoredAclEntry,
} from './ports';

/**
 * Editing reach, and explaining it.
 *
 * The write half of the ACL model, and the reader ADR-0005 asked for by name as the mitigation for
 * its own central consequence: *"a `DENY` is a blunt instrument and administrators must be told so:
 * the UI shows, for any user and object, the effective permission and the node that decided it."*
 * `Decision.decidedAt` has carried that field since Phase 0.5 and nothing read it; `effectiveFor`
 * is what reads it.
 *
 * Four decisions are worth reading before the code.
 *
 * **An edit is a replacement, and the diff is what is audited.** A screen edits a matrix and posts
 * a matrix; the repository computes what was added and what was removed inside the transaction, and
 * this writes one `ACL_GRANTED` for the additions and one `ACL_REVOKED` for the removals. An edit
 * that changes nothing writes nothing — a `PUT` of the current state is not an act.
 *
 * **A grant on a node the caller cannot itself reach is refused.** `document:permission:manage` is
 * a capability; reaching the node is the second question, and it is asked here through the same
 * resolver that would answer it for any other act. Without this, holding the permission anywhere
 * would let somebody grant themselves reach everywhere, which is the privilege escalation 08 §8's
 * table forbids and the sharpest edge this phase adds.
 *
 * **Breaking inheritance is audited; restoring it is not a separate action.** ADR-0005 names
 * `INHERITANCE_BROKEN` and names no counterpart, and that asymmetry is right rather than an
 * omission: breaking is the operation that hides content from the people accountable for it, and
 * restoring it is the operation that stops doing so. The restoring direction is still recorded —
 * as `FOLDER_CHANGED`, which is where every other edit to a folder lives — so nothing is silent;
 * what it is not is a row in the compliance filter that exists to find concealment.
 *
 * **Every write invalidates the decision cache before it publishes.** The prefix is the tenant's,
 * not the node's: an entry on a company changes answers about documents six levels below it, and a
 * cache keyed by node cannot express "and everything under it" without walking the tree it was
 * added to avoid walking. Clearing a tenant's decisions on an ACL edit is a cost paid by the
 * administrator who made the edit, on an operation that happens a handful of times a week.
 */
@Injectable()
export class DefaultPermissionService implements PermissionService {
  constructor(
    @Inject(ACL_REPOSITORY) private readonly entries: AclRepository,
    @Inject(SCOPE_CHAIN_READER) private readonly chains: ScopeChainReader,
    @Inject(ACL_RESOLVER) private readonly resolver: AclResolver,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly writer: AdministeredWriter,
  ) {}

  async explicitFor(scope: ScopeRef): Promise<readonly StoredAclEntry[]> {
    return this.writer.read(async () => {
      await this.requireReachable(scope);
      return this.entries.listForScope(scope);
    });
  }

  /**
   * Every permission in the catalogue, answered for one person on one object, with the node.
   *
   * One walk rather than thirty-seven: `capabilitiesFor` reads the chain once. The `decidedAt` that
   * makes the answer *explicable* needs a second pass, because `Capabilities` is a permission-to-
   * boolean map and has nowhere to carry a node — so this asks `resolve` per permission, and pays
   * for the explanation with the cache the resolver now has behind it. That is the right trade for
   * a screen an administrator opens to investigate one person, and the wrong one for a guard, which
   * is why the guard does not use this method.
   */
  async effectiveFor(scope: ScopeRef, userId: string): Promise<EffectivePermissions> {
    return this.writer.read(async () => {
      await this.requireReachable(scope);
      const chain = await this.chains.chainFor(scope);
      if (chain === null) {
        throw new NotFoundError('The requested resource');
      }
      const subject = await this.subjectFor(userId);
      const names = new Map(chain.map((node) => [String(node.scope.id), node.name]));

      const permissions: EffectivePermission[] = [];
      for (const permission of ALL_PERMISSIONS) {
        const decision = await this.resolver.resolve(subject, scope, permission);
        permissions.push({
          permission,
          allowed: decision.allowed,
          decidedAt: decision.decidedAt,
          decidedAtName:
            decision.decidedAt === null ? null : (names.get(String(decision.decidedAt.id)) ?? null),
          reason:
            decision.reason === 'STATE' || decision.reason === 'CONFIDENTIALITY'
              ? 'CLOSED_BY_DEFAULT'
              : decision.reason,
        });
      }

      return {
        scope,
        userId,
        permissions,
        chain: chain.map((node) => ({
          scope: node.scope,
          name: node.name,
          breaksInheritance: node.breaksInheritance,
        })),
        inheritanceBroken: chain.some((node) => node.breaksInheritance),
      };
    });
  }

  async replaceFor(
    scope: ScopeRef,
    drafts: readonly AclEntryDraft[],
  ): Promise<readonly StoredAclEntry[]> {
    const entries = drafts.map((draft) => this.validate(scope, draft));
    // Refusing duplicates here rather than letting the unique index do it: the index would report
    // a constraint name, and an administrator posting two rows for one subject wants to be told
    // which subject and which permission.
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.subjectType}:${entry.subjectId}:${entry.permission}`;
      if (seen.has(key)) {
        throw new ValidationError(
          'One subject holds at most one effect per permission on a node.',
          [
            {
              field: 'entries',
              message: `Two entries name ${entry.subjectType.toLowerCase()} ${entry.subjectId} for ${entry.permission}.`,
            },
          ],
        );
      }
      seen.add(key);
    }

    return this.writer.write(async () => {
      await this.requireReachable(scope);
      await this.requireManagePermission(scope);
      const { granted, revoked } = await this.entries.replaceForScope(scope, entries);

      // The `write` wrapper records one event; the second, when both halves changed, goes through
      // `record` — the same shape Phase 10's purge uses for its two-audience act.
      if (granted.length > 0 && revoked.length > 0) {
        await this.writer.record({
          action: LibraryAudit.ACL_REVOKED,
          subjectType: subjectTypeFor(scope.type),
          subjectId: scope.id,
          operation: AdministrativeOperation.DELETED,
          before: { entries: revoked.map(describe) },
        });
      }
      await this.afterChange(scope, [...granted, ...revoked]);

      const change =
        granted.length > 0
          ? {
              action: LibraryAudit.ACL_GRANTED,
              subjectType: subjectTypeFor(scope.type),
              subjectId: scope.id,
              operation: AdministrativeOperation.CREATED,
              after: { entries: granted.map(describe) },
            }
          : revoked.length > 0
            ? {
                action: LibraryAudit.ACL_REVOKED,
                subjectType: subjectTypeFor(scope.type),
                subjectId: scope.id,
                operation: AdministrativeOperation.DELETED,
                before: { entries: revoked.map(describe) },
              }
            : {
                // Nothing changed. The trail still gets one row, because a `PUT` that matched is
                // an administrator confirming a set — and a compliance reader asking "who last
                // reviewed this node's permissions" has nothing else to read.
                action: LibraryAudit.ACL_GRANTED,
                subjectType: subjectTypeFor(scope.type),
                subjectId: scope.id,
                operation: AdministrativeOperation.UPDATED,
                after: { entries: [], unchanged: true },
              };

      return { result: await this.entries.listForScope(scope), change };
    });
  }

  async setInheritance(
    folderId: FolderId,
    inherit: boolean,
    expectedVersion?: number,
  ): Promise<boolean> {
    const scope: ScopeRef = { type: ScopeType.FOLDER, id: folderId };
    return this.writer.write(async () => {
      await this.requireReachable(scope);
      await this.requireManagePermission(scope);
      const folder = await this.entries.findInheritance(folderId);
      if (folder === null) {
        throw new NotFoundError('Folder');
      }
      checkVersion(expectedVersion, folder.version);

      if (folder.inheritAcl !== inherit) {
        await this.entries.setInheritance(folderId, inherit);
        await this.afterChange(scope, []);
      }

      return {
        result: folder.inheritAcl !== inherit,
        change: {
          // ADR-0005's row, and only in the direction the ADR names. Restoring inheritance is a
          // folder edit, filed where every other folder edit is.
          action: inherit ? LibraryAudit.FOLDER_CHANGED : LibraryAudit.INHERITANCE_BROKEN,
          subjectType: AuditSubjectType.FOLDER,
          subjectId: folderId,
          operation: AdministrativeOperation.UPDATED,
          before: { inheritAcl: folder.inheritAcl },
          after: { inheritAcl: inherit, name: folder.name },
        },
      };
    });
  }

  // --- Internals ---------------------------------------------------------------------------

  /**
   * The node exists and this caller may reach it — the `404` that keeps existence undisclosed.
   *
   * Asked before anything else, including before the manage check, because "you may not manage
   * permissions here" answered for a node the caller cannot see is itself the existence answer
   * `08 §7` withholds.
   */
  private async requireReachable(scope: ScopeRef): Promise<void> {
    if ((await this.chains.chainFor(scope)) === null) {
      throw new NotFoundError('The requested resource');
    }
  }

  /**
   * Reach for `document:permission:manage`, on the node being edited.
   *
   * The route already declares the permission, which is question one — capability. This is question
   * two, and it is asked *here* rather than by `@ScopedTo` on the route because the scope type is a
   * path segment rather than a fixed one: `/scopes/{scopeType}/{scopeId}/permissions` binds a
   * different node type per request, and `@ScopedTo` takes the type as a decorator argument. The
   * check is the same resolver, asked the same question.
   */
  private async requireManagePermission(scope: ScopeRef): Promise<void> {
    const context = requireContext();
    const subject: AuthorizationSubject = {
      userId: asId(context.userId ?? ''),
      roleIds: context.roles.map((role) => asId<AnyId>(role)),
      departmentIds: [],
      delegationIds: [],
    };
    const decision = await this.resolver.resolve(
      subject,
      scope,
      Permission.DOCUMENT_PERMISSION_MANAGE,
    );
    if (!decision.allowed) {
      throw new NotFoundError('The requested resource');
    }
  }

  private async subjectFor(userId: string): Promise<AuthorizationSubject> {
    const roles = await this.entries.rolesOf(userId);
    if (roles === null) {
      throw new NotFoundError('User');
    }
    return {
      userId: asId(userId),
      roleIds: roles.map((roleId) => asId<AnyId>(roleId)),
      // Left empty so the resolver reads them itself, exactly as it does for a request: passing a
      // list here would be a second way of collecting departments, and §3 step 1 makes collecting
      // them the resolver's own job.
      departmentIds: [],
      delegationIds: [],
    };
  }

  /**
   * What every ACL write does afterwards: clear the tenant's decisions, then publish.
   *
   * The order matters. Invalidating first means the window in which a stale decision could be read
   * closes before anything downstream reacts; publishing first would leave the search projection
   * re-reading through a cache that still holds the old answer, and materialising it.
   */
  private async afterChange(scope: ScopeRef, changed: readonly AclEntryRecord[]): Promise<void> {
    const { tenantId } = requireContext();
    await this.cache.deleteByPrefix(`acl:${tenantId}:`);
    await this.outbox.publish([
      aclChangedEvent(scope.id, {
        scopeType: scope.type,
        scopeId: String(scope.id),
        affectedSubjectIds: [...new Set(changed.map((entry) => entry.subjectId))],
      }),
    ]);
  }

  private validate(scope: ScopeRef, draft: AclEntryDraft): AclEntryRecord {
    if (!isPermissionKey(draft.permission)) {
      throw new ValidationError('A permission that is not in the catalogue does not exist.', [
        {
          field: 'permission',
          message: `${String(draft.permission)} is not in the permission catalogue.`,
        },
      ]);
    }
    if (
      draft.subjectType !== AclSubjectType.USER &&
      draft.subjectType !== AclSubjectType.ROLE &&
      draft.subjectType !== AclSubjectType.DEPARTMENT
    ) {
      throw new ValidationError('An entry names a user, a role or a department.', [
        { field: 'subjectType', message: `${String(draft.subjectType)} is not a subject type.` },
      ]);
    }
    if (draft.effect !== AclEffect.ALLOW && draft.effect !== AclEffect.DENY) {
      throw new ValidationError('An entry allows or denies.', [
        { field: 'effect', message: `${String(draft.effect)} is neither ALLOW nor DENY.` },
      ]);
    }
    return {
      scope,
      subjectType: draft.subjectType,
      subjectId: draft.subjectId,
      permission: draft.permission,
      effect: draft.effect,
    };
  }
}

/** The payload shape both ACL actions carry — enough to re-read the row, and nothing more. */
function describe(entry: AclEntryRecord): Record<string, string> {
  return {
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    permission: entry.permission,
    effect: entry.effect,
  };
}

/**
 * Which audit subject an ACL edit is filed against.
 *
 * The node, not the subject of the entry. "What has happened to this folder's permissions" is the
 * question a folder's timeline answers; "what has this person been granted" is an audit *search*
 * over the payload, which is what 13 §4's payload filter is for. Filing it against the user would
 * make the first question a scan.
 *
 * The upper nodes have no audit subject type of their own, for the reason `AccessDenialRecorder`
 * gives: they are configuration to an investigation, and `CONFIGURATION` is what the catalogue
 * already calls that.
 */
function subjectTypeFor(scopeType: string): AuditSubjectTypeKey {
  switch (scopeType) {
    case ScopeType.DOCUMENT:
      return AuditSubjectType.DOCUMENT;
    case ScopeType.FOLDER:
      return AuditSubjectType.FOLDER;
    case ScopeType.LIBRARY:
      return AuditSubjectType.LIBRARY;
    default:
      return AuditSubjectType.CONFIGURATION;
  }
}
