import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  ScopeType,
  type ScopeTypeKey,
  asId,
  depthOf,
  isLibraryOwnerScope,
  isUsableCode,
  pathFor,
  relativeDepthOf,
  rewriteSubtree,
} from '@edms/domain';
import { type Page, sanitizeFilename, squish } from '@edms/utils';

import {
  AdministeredWriter,
  AdministrativeOperation,
  type AdministrativeOperationKey,
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
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  ORGANIZATION_SERVICE,
  type OrganizationService,
} from '../../organization/application/ports';
import { FolderContentsRegistry } from './folder-contents.port';
import { LibraryAudit } from '../domain/audit-actions';
import { folderMovedEvent, libraryCreatedEvent } from '../domain/events';
import {
  MAXIMUM_FOLDER_DEPTH,
  checkFolderPlacement,
  folderSubtreeFits,
} from '../domain/folder-tree';
import {
  type FolderListRequest,
  type FolderRow,
  LIBRARY_ADMIN_REPOSITORY,
  type LibraryAdminRepository,
  type LibraryListRequest,
  type LibraryRow,
} from './administration.ports';

/**
 * Creating and editing libraries and folders.
 *
 * No document upload in Phase 2. What is built here is the *place*, and four of its rules are the
 * reason it is not a filesystem:
 *
 * **A library is created with its root folder, atomically.** A library with nothing to file in is a
 * broken workspace, and the schema has to permit the intermediate state because a folder cannot exist
 * before its library. The transaction is what makes that state unobservable.
 *
 * **A library's owner scope cannot change.** Re-homing one moves every folder and document in it into
 * a different permission chain: every ACL granted along the old chain silently stops applying, and
 * every one along the new chain silently starts. No confirmation dialogue can honestly summarise
 * that, so it is not offered.
 *
 * **A folder never leaves its library, and a root never moves.** The folder's ancestry *is* the chain
 * the ACL resolver walks from the library down; a folder parented into another library would resolve
 * permissions from a node it does not belong to.
 *
 * **Deleting a folder cascades, and restoring undoes exactly that cascade.** Every affected row is
 * stamped with one cascade identifier, so a restore brings back what this delete took — not everything
 * currently deleted underneath, which would resurrect folders somebody removed deliberately
 * beforehand (`05-database-design.md` §4).
 */
@Injectable()
export class LibraryAdminService {
  constructor(
    @Inject(LIBRARY_ADMIN_REPOSITORY) private readonly libraries: LibraryAdminRepository,
    @Inject(ORGANIZATION_SERVICE) private readonly organization: OrganizationService,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    /** Only to clear it: a move rewrites the subtree's ancestry — see `moveFolder`. */
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    private readonly contents: FolderContentsRegistry,
    private readonly writer: AdministeredWriter,
  ) {}

  // --- Libraries -------------------------------------------------------------------------

  listLibraries(request: LibraryListRequest): Promise<Page<LibraryRow>> {
    return this.writer.read(() => this.libraries.listLibraries(request));
  }

  getLibrary(id: string): Promise<LibraryRow> {
    return this.writer.read(() => this.requireLibrary(id, true));
  }

  async createLibrary(input: {
    code: string;
    name: string;
    description?: string | undefined;
    ownerScopeType: ScopeTypeKey;
    ownerScopeId?: string | null | undefined;
    rootFolderName?: string | undefined;
  }): Promise<LibraryRow> {
    const code = this.requireCode(input.code);
    const name = this.requireName(input.name);
    const ownerScopeId = this.requireOwnerScope(input.ownerScopeType, input.ownerScopeId ?? null);
    // Defaults to the library's own name, which is what an administrator expects to see at the top of
    // the tree they just made.
    const rootFolderName = this.requireFolderName(input.rootFolderName ?? name);

    return this.writer.write(async () => {
      if (await this.libraries.libraryCodeTaken(code, null)) {
        throw new DuplicateError('library', 'code');
      }
      // Resolved through Organisation's application service, never by reading its tables. A caller
      // naming another tenant's node gets "not found", which is the same answer as for one that does
      // not exist.
      if (
        ownerScopeId !== null &&
        !(await this.organization.exists(asId<AnyId>(ownerScopeId), input.ownerScopeType))
      ) {
        throw new ValidationError('That part of the organisation does not exist.', [
          { field: 'ownerScopeId', message: 'unknown' },
        ]);
      }

      const libraryId = this.writer.clock.nextId();
      const rootFolderId = this.writer.clock.nextId();
      await this.libraries.insertLibraryWithRoot({
        libraryId,
        rootFolderId,
        code,
        name,
        description: input.description === undefined ? null : squish(input.description),
        ownerScopeType: input.ownerScopeType,
        ownerScopeId,
        rootFolderName,
      });

      await this.outbox.publish([
        libraryCreatedEvent(asId<AnyId>(libraryId), {
          libraryId,
          code,
          ownerScopeType: input.ownerScopeType,
          // The tenant is the owner when no node is named, and the event says so explicitly rather
          // than carrying an empty string a consumer would have to interpret.
          ownerScopeId: ownerScopeId ?? requireContext().tenantId,
          rootFolderId,
        }),
      ]);

      return {
        result: await this.requireLibrary(libraryId, false),
        change: this.libraryChanged(libraryId, AdministrativeOperation.CREATED, undefined, {
          code,
          name,
          ownerScopeType: input.ownerScopeType,
          ownerScopeId,
          rootFolderId,
        }),
      };
    });
  }

  async updateLibrary(
    id: string,
    patch: { code?: string; name?: string; description?: string | null },
    expectedVersion: number | undefined,
  ): Promise<LibraryRow> {
    return this.writer.write(async () => {
      const current = await this.requireLibrary(id, false);
      checkVersion(expectedVersion, current.version);

      const code = patch.code === undefined ? undefined : this.requireCode(patch.code);
      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      if (code !== undefined && code.toLowerCase() !== current.code.toLowerCase()) {
        if (await this.libraries.libraryCodeTaken(code, id)) {
          throw new DuplicateError('library', 'code');
        }
      }

      await this.libraries.updateLibrary(id, current.version, {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
        ...(patch.description !== undefined && {
          description: patch.description === null ? null : squish(patch.description),
        }),
      });

      return {
        result: await this.requireLibrary(id, false),
        change: this.libraryChanged(
          id,
          AdministrativeOperation.UPDATED,
          {
            ...(code !== undefined && { code: current.code }),
            ...(name !== undefined && { name: current.name }),
          },
          { ...(code !== undefined && { code }), ...(name !== undefined && { name }) },
        ),
      };
    });
  }

  /**
   * Soft-deletes an empty library.
   *
   * Empty means: nothing but its root folder. Cascading a library delete through its whole tree would
   * make one click remove a filing structure somebody spent a day building, and the count in the
   * refusal is what lets them see that before deciding.
   */
  async deleteLibrary(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.requireLibrary(id, false);
      requireVersion(expectedVersion, current.version);

      const folders = await this.libraries.countLibraryFolders(id);
      if (folders > 0) {
        throw new ValidationError('Remove the folders in this library first.', [
          { field: 'folderCount', message: String(folders) },
        ]);
      }

      await this.libraries.setLibraryDeleted(id, current.version, true);

      return {
        result: undefined,
        change: this.libraryChanged(
          id,
          AdministrativeOperation.DELETED,
          { deletedAt: null },
          {
            code: current.code,
          },
        ),
      };
    });
  }

  async restoreLibrary(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.requireLibrary(id, true);
      checkVersion(expectedVersion, current.version);
      if (current.deletedAt === null) {
        return {
          result: undefined,
          change: this.libraryChanged(id, AdministrativeOperation.RESTORED, undefined, {
            alreadyLive: true,
          }),
        };
      }
      if (await this.libraries.libraryCodeTaken(current.code, id)) {
        throw new DuplicateError('library', 'code');
      }

      await this.libraries.setLibraryDeleted(id, current.version, false);

      return {
        result: undefined,
        change: this.libraryChanged(
          id,
          AdministrativeOperation.RESTORED,
          { deletedAt: current.deletedAt },
          { code: current.code },
        ),
      };
    });
  }

  // --- Folders ---------------------------------------------------------------------------

  listFolders(request: FolderListRequest): Promise<Page<FolderRow>> {
    return this.writer.read(() => this.libraries.listFolders(request));
  }

  getFolder(id: string): Promise<FolderRow> {
    return this.writer.read(() => this.requireFolder(id, true));
  }

  async createFolder(input: {
    libraryId: string;
    parentId: string;
    name: string;
    description?: string | undefined;
    inheritAcl: boolean;
  }): Promise<FolderRow> {
    const name = this.requireFolderName(input.name);

    return this.writer.write(async () => {
      const library = await this.requireLibrary(input.libraryId, false);
      const parent = await this.requireFolder(input.parentId, false);

      this.refuseFolderPlacement(
        checkFolderPlacement({
          nodeId: null,
          nodePath: null,
          // Creating: the new folder is never a root, whatever its parent is.
          nodeIsRoot: false,
          libraryId: library.id,
          parentId: parent.id,
          parentPath: parent.path,
          parentLibraryId: parent.libraryId,
        }),
      );
      if (await this.libraries.folderSiblingNameTaken(parent.id, name, null)) {
        throw new DuplicateError('folder', 'name');
      }

      const id = this.writer.clock.nextId();
      await this.libraries.insertFolder({
        id,
        libraryId: library.id,
        parentId: parent.id,
        name,
        description: input.description === undefined ? null : squish(input.description),
        path: pathFor(parent.path, id),
        depth: parent.depth + 1,
        inheritAcl: input.inheritAcl,
      });

      if (!input.inheritAcl) {
        /*
         * A folder born with the break is a new cut on the tree — Slice 35.
         *
         * Creation grants nothing and hides nothing that already existed, which is why Slice 33
         * left the permission model alone and this does too. What it changes is the *answer*: the
         * visibility filter's tenant-wide region carries `excludedFolderPaths`, the broken paths
         * read at the moment the filter was computed, and a break created after that read is a cut
         * the cached filter does not have. Every list and every search built from it then reaches
         * into a subtree that was never reachable, until the TTL runs out.
         *
         * Only when the break is asked for. A folder that inherits adds no cut and no entry, and
         * the regions are path prefixes that already cover it — clearing the tenant's ACL cache on
         * every ordinary folder creation would be a cost paid for nothing.
         */
        await this.acl.invalidateTenant();
      }

      return {
        result: await this.requireFolder(id, false),
        change: this.folderChanged(id, AdministrativeOperation.CREATED, undefined, {
          libraryId: library.id,
          parentId: parent.id,
          name,
          inheritAcl: input.inheritAcl,
        }),
      };
    });
  }

  /**
   * Renames a folder, or changes its description. **Not its inheritance** — Slice 33.
   *
   * This method used to write `inheritAcl`, and `PATCH /v1/admin/folders/{id}` is gated on
   * `folder:manage`. `AclPermissionService.setInheritance` is gated on
   * `document:permission:manage`, and `permissions.controller.ts` says exactly why the two are
   * different keys: "so somebody who may rename folders cannot silently detach one from the
   * tenant's grants". The same file records that `updateFolderSchema.inheritAcl` stays in the
   * contract because the screen still *shows* the flag, and that "what it no longer does is set
   * it". It still did.
   *
   * Three things went wrong through this door, and only the first needs the two keys to have been
   * separated by a custom role:
   *
   * 1. the gate ADR-0005 singles out — "the one most likely to hide content from the people
   *    accountable for it" — was reachable without its key;
   * 2. the trail recorded `FOLDER_CHANGED`, an ordinary folder edit, where the dedicated route
   *    writes `INHERITANCE_BROKEN`;
   * 3. nothing invalidated `acl:<tenant>:`, so every cached decision and every cached chain went
   *    on answering with the old inheritance until the TTL ran out. That one happened in every
   *    tenant, whatever roles it had.
   *
   * The field is gone from `updateFolderSchema` rather than ignored here, so a caller who sends it
   * is refused by validation instead of being told the change succeeded when it did not.
   */
  async updateFolder(
    id: string,
    patch: { name?: string; description?: string | null },
    expectedVersion: number | undefined,
  ): Promise<FolderRow> {
    return this.writer.write(async () => {
      const current = await this.requireFolder(id, false);
      checkVersion(expectedVersion, current.version);

      const name = patch.name === undefined ? undefined : this.requireFolderName(patch.name);
      if (name !== undefined && name.toLowerCase() !== current.name.toLowerCase()) {
        if (current.isRoot) {
          // The root may be renamed — it is a label like any other — but only where its parent is,
          // which for a root is nowhere. There are no siblings to collide with, so this is a no-op
          // check kept explicit so the reasoning is visible rather than inferred from its absence.
          void 0;
        } else if (
          current.parentId !== null &&
          (await this.libraries.folderSiblingNameTaken(current.parentId, name, id))
        ) {
          throw new DuplicateError('folder', 'name');
        }
      }

      await this.libraries.updateFolder(id, current.version, {
        ...(name !== undefined && { name }),
        ...(patch.description !== undefined && {
          description: patch.description === null ? null : squish(patch.description),
        }),
      });

      return {
        result: await this.requireFolder(id, false),
        change: this.folderChanged(
          id,
          AdministrativeOperation.UPDATED,
          {
            ...(name !== undefined && { name: current.name }),
          },
          {
            ...(name !== undefined && { name }),
          },
        ),
      };
    });
  }

  async moveFolder(
    id: string,
    parentId: string,
    expectedVersion: number | undefined,
  ): Promise<FolderRow> {
    return this.writer.write(async () => {
      const current = await this.requireFolder(id, false);
      requireVersion(expectedVersion, current.version);
      const parent = await this.requireFolder(parentId, false);

      this.refuseFolderPlacement(
        checkFolderPlacement({
          nodeId: id,
          nodePath: current.path,
          nodeIsRoot: current.isRoot,
          libraryId: current.libraryId,
          parentId: parent.id,
          parentPath: parent.path,
          parentLibraryId: parent.libraryId,
        }),
      );

      const subtree = await this.libraries.folderSubtree(current.path);
      if (!folderSubtreeFits(parent.depth, relativeDepthOf(subtree, current.path))) {
        // The subtree's height, not the node's own new depth: a ten-deep branch moved under a folder
        // at depth 30 would put its leaves at 40, and the placement check never sees them.
        throw new ValidationError(
          `Folders may not nest more than ${String(MAXIMUM_FOLDER_DEPTH)} levels deep.`,
          [{ field: 'parentId', message: 'TOO_DEEP' }],
        );
      }
      if (await this.libraries.folderSiblingNameTaken(parent.id, current.name, id)) {
        // Its name has to be free among its *new* siblings.
        throw new DuplicateError('folder', 'name');
      }

      const toPath = pathFor(parent.path, id);
      const rewritten = rewriteSubtree(subtree, current.path, toPath).map((node) => ({
        id: node.id,
        path: node.path,
        // Depth is stored, so it is recomputed rather than left to disagree with the path.
        depth: depthOf(node.path),
      }));

      await this.libraries.moveFolder({
        id,
        version: current.version,
        parentId: parent.id,
        nodes: rewritten,
      });

      /*
       * Ancestry changed, so inherited permissions changed with it — and so will the ACL
       * fingerprints the search index carries once there are documents to index.
       *
       * Which is why the cached answers go first — Slice 34. The resolver's own header names this
       * case: the chain is cached "per (tenant, scope)" because it is "the half that changes least:
       * a folder's ancestry changes when somebody moves it, which is a `library.folder-moved`
       * event". Nothing acted on that event but the search index, so every decision and every
       * chain resolved over the old ancestry — for the whole subtree, since `rewriteSubtree` moves
       * the descendants too — survived until the TTL.
       */
      await this.acl.invalidateTenant();
      await this.outbox.publish([
        folderMovedEvent(asId<AnyId>(id), {
          folderId: id,
          fromParentId: current.parentId,
          toParentId: parent.id,
          // No documents exist yet; Phase 3 fills this in from the same place.
          documentCount: 0,
        }),
      ]);

      return {
        result: await this.requireFolder(id, false),
        change: this.folderChanged(
          id,
          AdministrativeOperation.MOVED,
          { parentId: current.parentId, path: current.path },
          { parentId: parent.id, path: toPath, subtreeSize: subtree.length },
        ),
      };
    });
  }

  /**
   * Soft-deletes a folder and everything under it.
   *
   * A cascade, unlike a department or a category — and the difference is what people expect. Deleting a
   * folder means deleting what is in it; deleting a department does not mean deleting its
   * sub-departments. Both are honest about what they do, and neither is silent about it: this one
   * reports how many folders it took.
   */
  async deleteFolder(id: string, expectedVersion: number | undefined): Promise<number> {
    return this.writer.write(async () => {
      const current = await this.requireFolder(id, false);
      requireVersion(expectedVersion, current.version);
      if (current.isRoot) {
        throw new ValidationError(
          'The top folder is created with the library and cannot be removed.',
          [{ field: 'isRoot', message: 'root' }],
        );
      }

      const cascadeId = this.writer.clock.nextId();
      // The documents first: any legal hold under the subtree refuses the whole delete before a
      // single folder is touched (ADR-0010 §5 — a hold blocks deletion absolutely, including the
      // folder above the record). Phase 10 is where the cascade started reaching documents at
      // all; until it, they stayed live in a deleted folder, reachable by search and nothing else.
      const documentsRemoved = await this.contents.deleteUnder({
        folderId: id,
        path: current.path,
        cascadeId,
      });
      const removed = await this.libraries.cascadeDeleteFolder({
        id,
        version: current.version,
        path: current.path,
        cascadeId,
      });

      return {
        result: removed,
        change: this.folderChanged(
          id,
          AdministrativeOperation.DELETED,
          { deletedAt: null },
          {
            name: current.name,
            cascadeId,
            foldersRemoved: removed,
            documentsRemoved,
          },
        ),
      };
    });
  }

  /**
   * Restores exactly what one delete took.
   *
   * By cascade identifier, not by "everything deleted under this node". The difference matters the
   * moment somebody deleted a subfolder on Monday and its parent on Tuesday: restoring Tuesday's
   * delete must not undo Monday's.
   */
  async restoreFolder(id: string, expectedVersion: number | undefined): Promise<number> {
    return this.writer.write(async () => {
      const current = await this.requireFolder(id, true);
      checkVersion(expectedVersion, current.version);
      if (current.deletedAt === null) {
        return {
          result: 0,
          change: this.folderChanged(id, AdministrativeOperation.RESTORED, undefined, {
            alreadyLive: true,
          }),
        };
      }

      // The parent has to be back first, or the restored folder would be unreachable from the library
      // while counting as live.
      if (current.parentId !== null) {
        const parent = await this.libraries.findFolder(current.parentId, true);
        if (parent === null || parent.deletedAt !== null) {
          throw new ValidationError('Restore the folder above this one first.', [
            { field: 'parentId', message: 'deleted' },
          ]);
        }
        if (await this.libraries.folderSiblingNameTaken(current.parentId, current.name, id)) {
          throw new DuplicateError('folder', 'name');
        }
      }

      const cascadeId = await this.libraries.cascadeIdOf(id);
      let restored: number;
      let documentsRestored = 0;
      if (cascadeId === null) {
        // No cascade recorded — an older release, or a maintenance script. Restoring a "subtree" would
        // be guessing at an intent nothing wrote down, so only this folder comes back.
        await this.libraries.restoreFolderOnly(id, current.version);
        restored = 1;
      } else {
        restored = await this.libraries.restoreCascade(cascadeId);
        // The same identifier, so the restore returns exactly what the delete took: a document
        // deleted on its own beforehand carries its own cascade identifier and stays deleted.
        documentsRestored = await this.contents.restoreCascade(cascadeId);
      }

      return {
        result: restored,
        change: this.folderChanged(
          id,
          AdministrativeOperation.RESTORED,
          { deletedAt: current.deletedAt },
          { name: current.name, cascadeId, foldersRestored: restored, documentsRestored },
        ),
      };
    });
  }

  // --- Internals -------------------------------------------------------------------------

  private async requireLibrary(id: string, includeDeleted: boolean): Promise<LibraryRow> {
    const row = await this.libraries.findLibrary(id, includeDeleted);
    if (!row) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  private async requireFolder(id: string, includeDeleted: boolean): Promise<FolderRow> {
    const row = await this.libraries.findFolder(id, includeDeleted);
    if (!row) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  /**
   * The owner node, checked for coherence before it is resolved.
   *
   * `TENANT` names no node and everything else names exactly one. The database holds the same rule as
   * a check constraint; asking here is what makes the failure say which field is wrong — and it is
   * also what stops a tenant-wide library carrying a stray owner id, which would make its ACL chain
   * resolve from the wrong node.
   */
  private requireOwnerScope(type: ScopeTypeKey, id: string | null): string | null {
    if (!isLibraryOwnerScope(type)) {
      throw new ValidationError('A library cannot belong to that part of the organisation.', [
        { field: 'ownerScopeType', message: type },
      ]);
    }
    if (type === ScopeType.TENANT) {
      if (id !== null) {
        // The tenant is implicit, taken from the token. Naming it in a body is the one thing the
        // isolation guard rejects outright.
        throw new ValidationError('A library for the whole organisation names no part of it.', [
          { field: 'ownerScopeId', message: 'must be absent' },
        ]);
      }
      return null;
    }
    if (id === null) {
      throw new ValidationError('Say which part of the organisation this library belongs to.', [
        { field: 'ownerScopeId', message: 'required' },
      ]);
    }
    return id;
  }

  private refuseFolderPlacement(rejections: readonly string[]): void {
    if (rejections.length === 0) {
      return;
    }
    throw new ValidationError(
      'That is not a place this folder can sit.',
      rejections.map((reason) => ({ field: 'parentId', message: reason })),
    );
  }

  private requireCode(raw: string): string {
    const code = raw.trim();
    if (!isUsableCode(code)) {
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

  /**
   * A folder name, sanitised the way a download's filename is.
   *
   * The same rule and the same helper, because a folder name ends up in a `Content-Disposition` header
   * and on a filesystem the day somebody exports a tree — so accepting a name here that has to be
   * rewritten there would mean the exported structure did not match the one on screen.
   *
   * Sanitised *and* checked: `sanitizeFilename` would happily turn a name of `///` into `download`,
   * and silently renaming what somebody typed is worse than refusing it.
   */
  private requireFolderName(raw: string): string {
    const name = squish(raw);
    if (name.length === 0) {
      throw new ValidationError('A name is required.', [{ field: 'name', message: 'required' }]);
    }
    if (sanitizeFilename(name) !== name) {
      throw new ValidationError(
        'A folder name cannot contain \\ / : * ? " < > | or start with a dot.',
        [{ field: 'name', message: 'unusable' }],
      );
    }
    return name;
  }

  private libraryChanged(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return this.entry(
      LibraryAudit.LIBRARY_CHANGED,
      AuditSubjectType.LIBRARY,
      id,
      operation,
      before,
      after,
    );
  }

  private folderChanged(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return this.entry(
      LibraryAudit.FOLDER_CHANGED,
      AuditSubjectType.FOLDER,
      id,
      operation,
      before,
      after,
    );
  }

  private entry(
    action: string,
    subjectType: typeof AuditSubjectType.LIBRARY | typeof AuditSubjectType.FOLDER,
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return {
      action,
      subjectType,
      subjectId: asId<AnyId>(id),
      operation,
      ...(before && { before }),
      ...(after && { after }),
    };
  }
}
