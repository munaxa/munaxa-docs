import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  asId,
  isUsableCode,
  pathFor,
  relativeDepthOf,
  rewriteSubtree,
} from '@edms/domain';
import { type Page, squish } from '@edms/utils';

import {
  AdministeredWriter,
  AdministrativeOperation,
  checkVersion,
  requireVersion,
} from '../../../core/persistence';
import {
  DuplicateError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { ACL_RESOLVER, type AclResolver } from '../../../core/authorization/acl-resolver.port';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { OrganizationAudit } from '../domain/audit-actions';
import { OrganizationNodeKind, type OrganizationNodeKindKey } from '../domain/node-kind';
import { departmentMovedEvent, organizationNodeArchivedEvent } from '../domain/events';
import { MAXIMUM_DEPTH, checkPlacement, subtreeFitsUnder } from '../domain/scope-tree';
import {
  type BranchListRequest,
  type BranchRow,
  type CompanyRow,
  type DepartmentListRequest,
  type DepartmentRow,
  type EntityListRequest,
  type EntityRow,
  type ListRequest,
  SCOPE_ADMIN_REPOSITORY,
  type ScopeAdminRepository,
} from './ports';

/**
 * Creating and editing the scope tree.
 *
 * Phase 1 built this tree's read side and left the writes to Phase 2, which is this. What makes it
 * more than four sets of CRUD is that the tree it edits is the one the permission model walks, so
 * three ordinary-looking operations are load-bearing:
 *
 * **A move rewrites derived data the ACL resolver reads.** Re-parenting a department changes the
 * materialised path of its whole subtree, and every ACL granted along the old chain stops applying
 * to it. The rewrite is one statement in one transaction, and it publishes
 * `organization.department-moved` so permission caches drop what they know.
 *
 * **A delete never cascades.** A company with entities, or a department with sub-departments, is
 * refused with the count of what is in the way. The alternative — silently soft-deleting the
 * subtree — is a confirmation dialogue that cannot honestly summarise what it is about to do.
 *
 * **A restore re-checks uniqueness.** A code freed by a delete can be taken by something else in
 * the meantime, and the partial unique index would then refuse the restore with a constraint
 * violation. Checking first turns that into a message naming the collision.
 */
@Injectable()
export class ScopeAdminService {
  constructor(
    @Inject(SCOPE_ADMIN_REPOSITORY) private readonly scopes: ScopeAdminRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    /** Only to clear it: a move rewrites the ancestry the resolver reads — see `moveDepartment`. */
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    private readonly writer: AdministeredWriter,
  ) {}

  // --- Companies -------------------------------------------------------------------------

  listCompanies(request: ListRequest): Promise<Page<CompanyRow>> {
    return this.writer.read(() => this.scopes.listCompanies(request));
  }

  getCompany(id: string): Promise<CompanyRow> {
    return this.writer.read(() => this.requireCompany(id, true));
  }

  async createCompany(input: { code: string; name: string }): Promise<CompanyRow> {
    const code = this.requireCode(input.code);
    const name = this.requireName(input.name);

    return this.writer.write(async () => {
      await this.refuseTakenCompanyCode(code, null);
      const id = this.writer.clock.nextId();
      await this.scopes.insertCompany({ id, code, name });

      return {
        result: await this.requireCompany(id, false),
        change: this.changed(id, AdministrativeOperation.CREATED, undefined, { code, name }),
      };
    });
  }

  async updateCompany(
    id: string,
    patch: { code?: string; name?: string },
    expectedVersion: number | undefined,
  ): Promise<CompanyRow> {
    return this.writer.write(async () => {
      const current = await this.requireCompany(id, false);
      checkVersion(expectedVersion, current.version);

      const code = patch.code === undefined ? undefined : this.requireCode(patch.code);
      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      if (code !== undefined && !equalCodes(code, current.code)) {
        await this.refuseTakenCompanyCode(code, id);
      }

      await this.scopes.updateCompany(id, current.version, {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
      });

      return {
        result: await this.requireCompany(id, false),
        change: this.changed(
          id,
          AdministrativeOperation.UPDATED,
          changedOnly(current, { code, name }),
          onlyDefined({ code, name }),
        ),
      };
    });
  }

  // --- Entities --------------------------------------------------------------------------

  listEntities(request: EntityListRequest): Promise<Page<EntityRow>> {
    return this.writer.read(() => this.scopes.listEntities(request));
  }

  getEntity(id: string): Promise<EntityRow> {
    return this.writer.read(() => this.requireEntity(id, true));
  }

  async createEntity(input: {
    companyId: string;
    code: string;
    name: string;
    legalName?: string | undefined;
  }): Promise<EntityRow> {
    const code = this.requireCode(input.code);
    const name = this.requireName(input.name);
    const legalName = input.legalName === undefined ? null : this.requireName(input.legalName);

    return this.writer.write(async () => {
      // The company is resolved rather than trusted: a caller naming another tenant's company gets
      // "not found", which is the same answer they get for one that does not exist. Telling them
      // apart would confirm that the identifier belongs to somebody.
      await this.requireCompany(input.companyId, false);
      if (await this.scopes.entityCodeTaken(input.companyId, code, null)) {
        throw new DuplicateError('entity', 'code');
      }

      const id = this.writer.clock.nextId();
      await this.scopes.insertEntity({ id, companyId: input.companyId, code, name, legalName });

      return {
        result: await this.requireEntity(id, false),
        change: this.changed(id, AdministrativeOperation.CREATED, undefined, {
          companyId: input.companyId,
          code,
          name,
        }),
      };
    });
  }

  async updateEntity(
    id: string,
    patch: { code?: string; name?: string; legalName?: string | null },
    expectedVersion: number | undefined,
  ): Promise<EntityRow> {
    return this.writer.write(async () => {
      const current = await this.requireEntity(id, false);
      checkVersion(expectedVersion, current.version);

      const code = patch.code === undefined ? undefined : this.requireCode(patch.code);
      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      const legalName =
        patch.legalName === undefined || patch.legalName === null
          ? patch.legalName
          : this.requireName(patch.legalName);

      if (code !== undefined && !equalCodes(code, current.code)) {
        if (await this.scopes.entityCodeTaken(current.companyId, code, id)) {
          throw new DuplicateError('entity', 'code');
        }
      }

      await this.scopes.updateEntity(id, current.version, {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
        ...(legalName !== undefined && { legalName }),
      });

      return {
        result: await this.requireEntity(id, false),
        change: this.changed(
          id,
          AdministrativeOperation.UPDATED,
          changedOnly(current, { code, name, legalName }),
          onlyDefined({ code, name, legalName }),
        ),
      };
    });
  }

  // --- Branches --------------------------------------------------------------------------

  listBranches(request: BranchListRequest): Promise<Page<BranchRow>> {
    return this.writer.read(() => this.scopes.listBranches(request));
  }

  getBranch(id: string): Promise<BranchRow> {
    return this.writer.read(() => this.requireBranch(id, true));
  }

  async createBranch(input: {
    entityId: string;
    code: string;
    name: string;
    address?: string | undefined;
  }): Promise<BranchRow> {
    const code = this.requireCode(input.code);
    const name = this.requireName(input.name);
    const address = input.address === undefined ? null : squish(input.address);

    return this.writer.write(async () => {
      await this.requireEntity(input.entityId, false);
      if (await this.scopes.branchCodeTaken(input.entityId, code, null)) {
        throw new DuplicateError('branch', 'code');
      }

      const id = this.writer.clock.nextId();
      await this.scopes.insertBranch({ id, entityId: input.entityId, code, name, address });

      return {
        result: await this.requireBranch(id, false),
        change: this.changed(id, AdministrativeOperation.CREATED, undefined, {
          entityId: input.entityId,
          code,
          name,
        }),
      };
    });
  }

  async updateBranch(
    id: string,
    patch: { code?: string; name?: string; address?: string | null },
    expectedVersion: number | undefined,
  ): Promise<BranchRow> {
    return this.writer.write(async () => {
      const current = await this.requireBranch(id, false);
      checkVersion(expectedVersion, current.version);

      const code = patch.code === undefined ? undefined : this.requireCode(patch.code);
      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      const address =
        patch.address === undefined || patch.address === null
          ? patch.address
          : squish(patch.address);

      if (code !== undefined && !equalCodes(code, current.code)) {
        if (await this.scopes.branchCodeTaken(current.entityId, code, id)) {
          throw new DuplicateError('branch', 'code');
        }
      }

      await this.scopes.updateBranch(id, current.version, {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
        ...(address !== undefined && { address }),
      });

      return {
        result: await this.requireBranch(id, false),
        change: this.changed(
          id,
          AdministrativeOperation.UPDATED,
          changedOnly(current, { code, name, address }),
          onlyDefined({ code, name, address }),
        ),
      };
    });
  }

  // --- Departments -----------------------------------------------------------------------

  listDepartments(request: DepartmentListRequest): Promise<Page<DepartmentRow>> {
    return this.writer.read(() => this.scopes.listDepartments(request));
  }

  getDepartment(id: string): Promise<DepartmentRow> {
    return this.writer.read(() => this.requireDepartment(id, true));
  }

  async createDepartment(input: {
    entityId: string;
    parentId?: string | null | undefined;
    branchId?: string | null | undefined;
    code: string;
    name: string;
  }): Promise<DepartmentRow> {
    const code = this.requireCode(input.code);
    const name = this.requireName(input.name);
    const parentId = input.parentId ?? null;
    const branchId = input.branchId ?? null;

    return this.writer.write(async () => {
      await this.requireEntity(input.entityId, false);
      const parent = parentId === null ? null : await this.requireDepartment(parentId, false);
      if (branchId !== null) {
        const branch = await this.requireBranch(branchId, false);
        if (branch.entityId !== input.entityId) {
          // A department sitting at a branch of another entity would put a code from one legal
          // entity into another's document numbers.
          throw new ValidationError('That branch belongs to a different entity.');
        }
      }

      this.refuseBadPlacement(
        checkPlacement({
          nodeId: null,
          nodePath: null,
          parentId,
          parentPath: parent?.path ?? null,
          entityId: input.entityId,
          parentEntityId: parent?.entityId ?? null,
        }),
      );

      if (await this.scopes.departmentCodeTaken(input.entityId, code, null)) {
        throw new DuplicateError('department', 'code');
      }

      const id = this.writer.clock.nextId();
      await this.scopes.insertDepartment({
        id,
        entityId: input.entityId,
        branchId,
        parentId,
        code,
        name,
        // The path is derived here and nowhere else. It is the only field a client can never send.
        path: pathFor(parent?.path ?? null, id),
      });

      return {
        result: await this.requireDepartment(id, false),
        change: this.changed(id, AdministrativeOperation.CREATED, undefined, {
          entityId: input.entityId,
          parentId,
          branchId,
          code,
          name,
        }),
      };
    });
  }

  async updateDepartment(
    id: string,
    patch: { code?: string; name?: string; branchId?: string | null; parentId?: string | null },
    expectedVersion: number | undefined,
  ): Promise<DepartmentRow> {
    // A changed parent is a move, whichever endpoint it arrived on, because the consequences are
    // the same: a subtree of paths rewritten and a permission cache to invalidate. Routing it here
    // rather than duplicating the logic is what stops `PATCH` becoming a way to move a department
    // without publishing the event that says it moved.
    if (patch.parentId !== undefined) {
      await this.moveDepartment(id, patch.parentId, expectedVersion);
    }

    const rest = { ...patch };
    delete rest.parentId;
    if (Object.keys(rest).length === 0) {
      return this.getDepartment(id);
    }

    return this.writer.write(async () => {
      const current = await this.requireDepartment(id, false);
      // The version was consumed by the move above, if there was one; re-reading is what makes the
      // two writes composable rather than a guaranteed conflict on the second.
      checkVersion(
        patch.parentId === undefined ? expectedVersion : current.version,
        current.version,
      );

      const code = rest.code === undefined ? undefined : this.requireCode(rest.code);
      const name = rest.name === undefined ? undefined : this.requireName(rest.name);

      if (code !== undefined && !equalCodes(code, current.code)) {
        if (await this.scopes.departmentCodeTaken(current.entityId, code, id)) {
          throw new DuplicateError('department', 'code');
        }
      }
      if (rest.branchId !== undefined && rest.branchId !== null) {
        const branch = await this.requireBranch(rest.branchId, false);
        if (branch.entityId !== current.entityId) {
          throw new ValidationError('That branch belongs to a different entity.');
        }
      }

      await this.scopes.updateDepartment(id, current.version, {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
        ...(rest.branchId !== undefined && { branchId: rest.branchId }),
      });

      return {
        result: await this.requireDepartment(id, false),
        change: this.changed(
          id,
          AdministrativeOperation.UPDATED,
          changedOnly(current, { code, name, branchId: rest.branchId }),
          onlyDefined({ code, name, branchId: rest.branchId }),
        ),
      };
    });
  }

  /**
   * Re-parents a department, taking its subtree with it.
   *
   * The version is required rather than optional. A blind move is a change nobody has seen the
   * starting state of, and its effect — every ACL granted along the old chain ceasing to apply —
   * is not recoverable by moving the node back, because the grants are not restored with it.
   */
  async moveDepartment(
    id: string,
    parentId: string | null,
    expectedVersion: number | undefined,
  ): Promise<DepartmentRow> {
    return this.writer.write(async () => {
      const current = await this.requireDepartment(id, false);
      requireVersion(expectedVersion, current.version);

      const parent = parentId === null ? null : await this.requireDepartment(parentId, false);

      this.refuseBadPlacement(
        checkPlacement({
          nodeId: id,
          nodePath: current.path,
          parentId,
          parentPath: parent?.path ?? null,
          entityId: current.entityId,
          parentEntityId: parent?.entityId ?? null,
        }),
      );

      const subtree = await this.scopes.departmentSubtree(current.path);
      // The *subtree's* height, not the node's own new depth. Moving a three-deep branch under a
      // department at depth 8 puts its leaves at 11, and `checkPlacement` never sees them.
      if (!subtreeFitsUnder(parent?.path ?? null, relativeDepthOf(subtree, current.path))) {
        throw new ValidationError(
          `Departments may not nest more than ${String(MAXIMUM_DEPTH)} levels deep.`,
        );
      }

      const toPath = pathFor(parent?.path ?? null, id);
      await this.scopes.moveDepartment({
        id,
        version: current.version,
        parentId,
        paths: [...rewriteSubtree(subtree, current.path, toPath)],
      });

      /*
       * The cached answers go first — Slice 36.
       *
       * The header of this class already said what the move does: it "rewrites derived data the
       * ACL resolver reads … every ACL granted along the old chain stops applying to it", and it
       * publishes `organization.department-moved` "so permission caches drop what they know".
       * Nothing consumed that event — not the search index consumer, which handles
       * `library.acl-changed` and `library.folder-moved`, and not the outbox dispatcher. The
       * caches were never told.
       *
       * The dependency is one line in the resolver: `departmentsOf` returns `idsInPath(row.path)`,
       * so a member of a child department carries its ancestors as ACL subjects and an entry
       * naming an old parent reaches them until the path changes. `decisionKey` is
       * `(tenant, user, roles, scope, permission)` and does not mention departments, so the answer
       * cached before the move was served after it under the very same key — a grant outliving the
       * reorganisation that removed it.
       *
       * Cleared here rather than by giving the event a consumer, for the reason the comment below
       * gives about the queue: an invalidation that depends on a lane being reachable is an
       * invalidation that can be lost, and the ACL architecture's own rule is "by prefix, in the
       * transaction that caused it".
       */
      await this.acl.invalidateTenant();

      // Published because ancestry changed, so inherited permissions changed with it. Through the
      // outbox, inside this transaction: a cache invalidated for a move that then rolled back is
      // a cache that will be repopulated with the right answer, but an invalidation lost because
      // the queue was unreachable leaves every process serving a stale permission.
      await this.outbox.publish([
        departmentMovedEvent(asId<AnyId>(id), {
          departmentId: id,
          fromParentId: current.parentId,
          toParentId: parentId ?? '',
          path: toPath,
        }),
      ]);

      return {
        result: await this.requireDepartment(id, false),
        change: this.changed(
          id,
          AdministrativeOperation.MOVED,
          { parentId: current.parentId, path: current.path },
          { parentId, path: toPath, subtreeSize: subtree.length },
        ),
      };
    });
  }

  // --- Delete and restore ----------------------------------------------------------------

  /**
   * Soft-deletes a node, provided nothing live still hangs from it.
   *
   * The dependent check is the whole of the behaviour worth reading. Refusing with a count is what
   * lets an administrator understand a reorganisation before performing it; cascading would make
   * "delete this company" a one-click way to remove every department in it.
   */
  async delete(
    kind: OrganizationNodeKindKey,
    id: string,
    expectedVersion: number | undefined,
  ): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.requireNode(kind, id, false);
      requireVersion(expectedVersion, current.version);

      const dependents = await this.scopes.dependentsOf(kind, id);
      const blocking = Object.entries(dependents).filter(([, count]) => count > 0);
      if (blocking.length > 0) {
        throw new ValidationError(
          'Remove what is inside this first.',
          blocking.map(([kind, count]) => ({ field: kind, message: String(count) })),
        );
      }

      await this.scopes.setDeleted(kind, id, current.version, true);

      // A retired node stops conferring access at once — the read side already excludes deleted
      // rows from every chain — and libraries owned by it stay readable, which is what the event
      // tells the permission caches to reconsider.
      await this.outbox.publish([
        organizationNodeArchivedEvent(asId<AnyId>(id), { nodeId: id, scopeType: kind }),
      ]);

      return {
        result: undefined,
        change: this.changed(
          id,
          AdministrativeOperation.DELETED,
          { deletedAt: null },
          {
            nodeKind: kind,
            code: current.code,
          },
        ),
      };
    });
  }

  /**
   * Restores a soft-deleted node.
   *
   * Uniqueness is re-checked because the code was released when the node was deleted and may have
   * been taken since. The partial unique index would refuse the restore anyway; checking first
   * turns a constraint violation into a message that names the collision
   * (`05-database-design.md` §4).
   */
  async restore(
    kind: OrganizationNodeKindKey,
    id: string,
    expectedVersion: number | undefined,
  ): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.requireNode(kind, id, true);
      checkVersion(expectedVersion, current.version);
      if (current.deletedAt === null) {
        // Idempotent rather than an error: two administrators clicking restore is not a conflict,
        // and the second one wants the same end state the first produced.
        return {
          result: undefined,
          change: this.changed(id, AdministrativeOperation.RESTORED, undefined, {
            nodeKind: kind,
            alreadyLive: true,
          }),
        };
      }

      await this.refuseTakenCodeOnRestore(kind, current);
      await this.scopes.setDeleted(kind, id, current.version, false);

      return {
        result: undefined,
        change: this.changed(
          id,
          AdministrativeOperation.RESTORED,
          { deletedAt: current.deletedAt },
          {
            nodeKind: kind,
            code: current.code,
          },
        ),
      };
    });
  }

  // --- Internals -------------------------------------------------------------------------

  private async requireNode(
    kind: OrganizationNodeKindKey,
    id: string,
    includeDeleted: boolean,
  ): Promise<CompanyRow | EntityRow | BranchRow | DepartmentRow> {
    switch (kind) {
      case OrganizationNodeKind.COMPANY:
        return this.requireCompany(id, includeDeleted);
      case OrganizationNodeKind.ENTITY:
        return this.requireEntity(id, includeDeleted);
      case OrganizationNodeKind.BRANCH:
        return this.requireBranch(id, includeDeleted);
      case OrganizationNodeKind.DEPARTMENT:
        return this.requireDepartment(id, includeDeleted);
      default:
        // Libraries, folders and documents hang below this tree and are owned elsewhere. Reaching
        // here is a routing mistake, not a caller's.
        throw new NotFoundError('The requested resource');
    }
  }

  private async refuseTakenCodeOnRestore(
    kind: OrganizationNodeKindKey,
    node: CompanyRow | EntityRow | BranchRow | DepartmentRow,
  ): Promise<void> {
    const taken = await (() => {
      switch (kind) {
        case OrganizationNodeKind.COMPANY:
          return this.scopes.companyCodeTaken(node.code, node.id);
        case OrganizationNodeKind.ENTITY:
          return this.scopes.entityCodeTaken((node as EntityRow).companyId, node.code, node.id);
        case OrganizationNodeKind.BRANCH:
          return this.scopes.branchCodeTaken((node as BranchRow).entityId, node.code, node.id);
        case OrganizationNodeKind.DEPARTMENT:
          return this.scopes.departmentCodeTaken(
            (node as DepartmentRow).entityId,
            node.code,
            node.id,
          );
        default:
          return Promise.resolve(false);
      }
    })();

    if (taken) {
      throw new DuplicateError('code', 'code');
    }
  }

  private async requireCompany(id: string, includeDeleted: boolean): Promise<CompanyRow> {
    return this.found(await this.scopes.findCompany(id, includeDeleted));
  }

  private async requireEntity(id: string, includeDeleted: boolean): Promise<EntityRow> {
    return this.found(await this.scopes.findEntity(id, includeDeleted));
  }

  private async requireBranch(id: string, includeDeleted: boolean): Promise<BranchRow> {
    return this.found(await this.scopes.findBranch(id, includeDeleted));
  }

  private async requireDepartment(id: string, includeDeleted: boolean): Promise<DepartmentRow> {
    return this.found(await this.scopes.findDepartment(id, includeDeleted));
  }

  /**
   * `NotFoundError` for everything a caller may not see, including another tenant's row.
   *
   * A caller who may not reach an object is told it does not exist, so the API never confirms that
   * an identifier belongs to somebody (`15-api-architecture.md` §4).
   */
  private found<TRow>(row: TRow | null): TRow {
    if (row === null) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  private async refuseTakenCompanyCode(code: string, exceptId: string | null): Promise<void> {
    if (await this.scopes.companyCodeTaken(code, exceptId)) {
      throw new DuplicateError('company', 'code');
    }
  }

  private requireCode(raw: string): string {
    const code = raw.trim();
    if (!isUsableCode(code)) {
      // The rule is `@edms/domain`'s, because Numbering renders these codes into printed document
      // numbers and has to agree with what Organisation accepted.
      throw new ValidationError(
        'A code is letters, digits and hyphens, not starting with a hyphen, up to 16 characters.',
        [{ field: 'code', message: 'unusable' }],
      );
    }
    return code;
  }

  private requireName(raw: string): string {
    const name = squish(raw);
    if (name.length === 0) {
      throw new ValidationError('A name is required.', [{ field: 'name', message: 'required' }]);
    }
    return name;
  }

  private refuseBadPlacement(rejections: readonly string[]): void {
    if (rejections.length === 0) {
      return;
    }
    // Every reason, not the first: an administrator fixing one problem and hitting the next is a
    // worse experience than being told both at once.
    throw new ValidationError(
      'That is not a place this department can sit.',
      rejections.map((reason) => ({ field: 'parentId', message: reason })),
    );
  }

  private changed(
    id: string,
    operation: (typeof AdministrativeOperation)[keyof typeof AdministrativeOperation],
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return {
      action: OrganizationAudit.ORG_CHANGED,
      subjectType: AuditSubjectType.CONFIGURATION,
      subjectId: asId<AnyId>(id),
      operation,
      ...(before && { before }),
      ...(after && { after }),
    };
  }
}

/** Codes are compared case-insensitively; "QA" and "qa" are the same code to the unique index. */
function equalCodes(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** The keys a patch actually names, so an audit payload does not claim `undefined` was written. */
function onlyDefined(patch: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/**
 * The current values of the fields a patch is about to change — and only those.
 *
 * `before`/`after` carry changed fields, never a copy of the row: a full snapshot would make the
 * audit trail a second store of the data it describes, with no soft delete and no retention policy
 * (`13-audit-architecture.md` §3).
 */
function changedOnly<TRow extends object>(
  current: TRow,
  patch: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const values = current as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => [key, values[key]]),
  );
}
