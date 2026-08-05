import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScopeType, type ScopeTypeKey, type TenantId, type UserId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realOrganizationService, realWriteStack } from '../../../testing/real-collaborators';
import { FolderContentsRegistry } from '../application/folder-contents.port';
import { LibraryAdminService } from '../application/library-admin.service';
import { PrismaLibraryAdminRepository } from '../infrastructure/prisma-library-admin.repository';
import { sharedDatabase } from '../../../testing/tenant-database';

/**
 * Libraries and folders, against a real PostgreSQL.
 *
 * The interesting assertions are all about *atomicity and exactness*: that a library and its root
 * folder appear together or not at all, that a cascade delete takes a whole subtree in one statement,
 * and that a restore brings back exactly what that cascade took rather than everything currently
 * deleted underneath it.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const config = { env: 'test', database: { url: APP_URL, poolSize: 10 } } as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const FIXED_NOW = new Date('2026-09-01T08:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, outbox, writer } = realWriteStack(clock, unitOfWork);
// The real read side of the scope tree: resolving a library's owner node is a call to Organisation's
// application service, and a double could not be wrong about whether the node exists.
const organization = realOrganizationService();
const libraries = new LibraryAdminService(
  new PrismaLibraryAdminRepository(stamps),
  organization,
  outbox,
  // Unfilled: this suite composes no documents, and an unfilled registry deletes nothing and
  // says nothing — which is the honest behaviour for a library that genuinely holds none.
  new FolderContentsRegistry(),
  writer,
);

const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

const TENANT = asId<TenantId>(uuidv7());
const OTHER_TENANT = asId<TenantId>(uuidv7());
const ADMIN = asId<UserId>(uuidv7());

let companyId: string;
let entityId: string;
let departmentId: string;
let branchId: string;

function contextFor(tenantId: TenantId): RequestContext {
  return {
    tenantId,
    userId: ADMIN,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'library-admin',
    permissionVersion: 1,
    locale: 'en',
  };
}

function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(TENANT), work);
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(3, '0')}`;
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  for (const tenantId of [TENANT, OTHER_TENANT]) {
    await owner.tenant.create({
      data: {
        id: tenantId,
        slug: `lib-${String(Date.now())}-${tenantId.slice(0, 8)}`,
        name: 'Library Test',
        status: 'ACTIVE',
      },
    });
  }

  companyId = uuidv7();
  entityId = uuidv7();
  branchId = uuidv7();
  departmentId = uuidv7();
  await owner.company.create({
    data: { id: companyId, tenantId: TENANT, code: 'HQ', name: 'Head Office' },
  });
  await owner.entity.create({
    data: { id: entityId, tenantId: TENANT, companyId, code: 'OPS', name: 'Operations' },
  });
  await owner.branch.create({
    data: { id: branchId, tenantId: TENANT, entityId, code: 'MAIN', name: 'Main Site' },
  });
  await owner.department.create({
    data: {
      id: departmentId,
      tenantId: TENANT,
      entityId,
      code: 'QA',
      name: 'Quality',
      path: departmentId,
    },
  });
});

afterAll(async () => {
  await owner.$disconnect();
  await prisma.disconnectAll();
});

async function aLibrary(): Promise<{ id: string; version: number; rootFolderId: string }> {
  const library = await asAdmin(() =>
    libraries.createLibrary({
      code: unique('LIB'),
      name: `Library ${String(counter)}`,
      ownerScopeType: ScopeType.ENTITY,
      ownerScopeId: entityId,
      rootFolderName: 'Top',
    }),
  );
  return { id: library.id, version: library.version, rootFolderId: library.rootFolderId };
}

describe('creating a library', () => {
  it('creates the root folder with it, and points one at the other', async () => {
    const library = await aLibrary();

    const root = await owner.folder.findUnique({
      where: { id: library.rootFolderId },
      select: { isRoot: true, parentId: true, path: true, depth: true, libraryId: true },
    });

    // A library with nothing to file in is a broken workspace. The schema permits the intermediate
    // state because a folder cannot exist before its library; the transaction is what makes it
    // unobservable.
    expect(root).toMatchObject({
      isRoot: true,
      parentId: null,
      path: library.rootFolderId,
      depth: 1,
      libraryId: library.id,
    });
  });

  it('resolves the owner node through Organisation, and refuses one that does not exist', async () => {
    await expect(
      asAdmin(() =>
        libraries.createLibrary({
          code: unique('LIB'),
          name: 'Dangling',
          ownerScopeType: ScopeType.DEPARTMENT,
          ownerScopeId: uuidv7(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a branch as an owner, because permission does not flow through one', async () => {
    // `ScopeType` has no `BRANCH` member at all — a branch is a location, not a level — so the
    // compiler and the wire schema both refuse this before it can be sent. What is asserted here is
    // the service's own guard, which exists for the callers a DTO does not cover: a seed, a
    // maintenance script, a future queue consumer. Hence the cast; it is standing in for a caller
    // TypeScript is not checking.
    await expect(
      asAdmin(() =>
        libraries.createLibrary({
          code: unique('LIB'),
          name: 'At a branch',
          ownerScopeType: 'BRANCH' as ScopeTypeKey,
          ownerScopeId: branchId,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: 'ownerScopeType' }],
    });
  });

  it('accepts a tenant-wide library, and refuses one that also names a node', async () => {
    await expect(
      asAdmin(() =>
        libraries.createLibrary({
          code: unique('LIB'),
          name: 'Everyone',
          ownerScopeType: ScopeType.TENANT,
        }),
      ),
    ).resolves.toMatchObject({ ownerScopeId: null });

    // The tenant is implicit, taken from the token. Naming it in a body is the one thing the isolation
    // guard rejects outright — and a tenant-wide library carrying a stray owner id would resolve its
    // ACL chain from the wrong node.
    await expect(
      asAdmin(() =>
        libraries.createLibrary({
          code: unique('LIB'),
          name: 'Contradiction',
          ownerScopeType: ScopeType.TENANT,
          ownerScopeId: entityId,
        }),
      ),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'ownerScopeId' }] });
  });

  it('requires a node for every scope that is not the tenant', async () => {
    await expect(
      asAdmin(() =>
        libraries.createLibrary({
          code: unique('LIB'),
          name: 'Unhomed',
          ownerScopeType: ScopeType.COMPANY,
        }),
      ),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'ownerScopeId', message: 'required' }] });
  });

  it('resolves the owning node’s name for a list', async () => {
    await asAdmin(() =>
      libraries.createLibrary({
        code: unique('LIB'),
        name: 'Departmental',
        ownerScopeType: ScopeType.DEPARTMENT,
        ownerScopeId: departmentId,
      }),
    );

    const page = await asAdmin(() =>
      libraries.listLibraries({
        page: 1,
        pageSize: 100,
        sortDirection: 'asc',
        deleted: 'live',
        ownerScopeType: ScopeType.DEPARTMENT,
      }),
    );
    expect(page.data.map((row) => row.ownerScopeName)).toContain('Quality');
  });

  it('publishes the creation, naming the tenant when no node owns it', async () => {
    const library = await asAdmin(() =>
      libraries.createLibrary({
        code: unique('LIB'),
        name: 'Published',
        ownerScopeType: ScopeType.TENANT,
      }),
    );

    const messages = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, aggregateId: library.id, eventType: 'library.created' },
      select: { payload: true },
    });
    expect(messages).toHaveLength(1);
    // The tenant, not an empty string a consumer would have to interpret.
    expect(messages[0]?.payload).toMatchObject({
      ownerScopeId: TENANT,
      rootFolderId: library.rootFolderId,
    });
  });
});

describe('folders', () => {
  it('derives the path and depth from the parent', async () => {
    const library = await aLibrary();
    const child = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Procedures',
        inheritAcl: true,
      }),
    );

    expect(child.path).toBe(`${library.rootFolderId}.${child.id}`);
    expect(child.depth).toBe(2);
  });

  it('refuses a name a live sibling already has, whatever its case', async () => {
    const library = await aLibrary();
    await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Records',
        inheritAcl: true,
      }),
    );

    await expect(
      asAdmin(() =>
        libraries.createFolder({
          libraryId: library.id,
          parentId: library.rootFolderId,
          name: 'RECORDS',
          inheritAcl: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('refuses a name that could not survive a download header', async () => {
    // A folder name ends up in `Content-Disposition` and on a filesystem the day somebody exports the
    // tree, so accepting one here that has to be rewritten there would mean the export did not match
    // what is on screen. Refused rather than silently sanitised.
    const library = await aLibrary();
    await expect(
      asAdmin(() =>
        libraries.createFolder({
          libraryId: library.id,
          parentId: library.rootFolderId,
          name: 'Q1/Q2',
          inheritAcl: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a parent in another library', async () => {
    const first = await aLibrary();
    const second = await aLibrary();

    // A folder's ancestry *is* the chain the ACL resolver walks from the library down. Parented into
    // another library, it would resolve permissions from a node it does not belong to.
    await expect(
      asAdmin(() =>
        libraries.createFolder({
          libraryId: first.id,
          parentId: second.rootFolderId,
          name: 'Misplaced',
          inheritAcl: true,
        }),
      ),
    ).rejects.toMatchObject({
      fieldErrors: [{ field: 'parentId', message: 'PARENT_IN_ANOTHER_LIBRARY' }],
    });
  });

  it('refuses moving or deleting the root', async () => {
    const library = await aLibrary();
    const root = await asAdmin(() => libraries.getFolder(library.rootFolderId));
    const child = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Elsewhere',
        inheritAcl: true,
      }),
    );

    // It is the library's own anchor: `library.root_folder_id` points at it. Two reasons are reported
    // here, not one — the target is also inside the root's own subtree — and reporting both is the
    // point: an administrator sees everything wrong with the move rather than the first thing.
    try {
      await asAdmin(() => libraries.moveFolder(root.id, child.id, root.version));
      expect.unreachable('moving a root must be refused');
    } catch (error) {
      const reasons = (error as { fieldErrors: { message: string }[] }).fieldErrors.map(
        (entry) => entry.message,
      );
      expect(reasons).toContain('ROOT_CANNOT_MOVE');
      expect(reasons).toContain('PARENT_IS_DESCENDANT');
    }

    await expect(
      asAdmin(() => libraries.deleteFolder(root.id, root.version)),
    ).rejects.toMatchObject({
      fieldErrors: [{ field: 'isRoot' }],
    });
  });

  it('moves a subtree, rewriting every path and depth', async () => {
    const library = await aLibrary();
    const first = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'First',
        inheritAcl: true,
      }),
    );
    const child = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: first.id,
        name: 'Child',
        inheritAcl: true,
      }),
    );
    const grandchild = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: child.id,
        name: 'Grandchild',
        inheritAcl: true,
      }),
    );
    const target = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Target',
        inheritAcl: true,
      }),
    );

    const toMove = await asAdmin(() => libraries.getFolder(child.id));
    await asAdmin(() => libraries.moveFolder(child.id, target.id, toMove.version));

    const rows = await owner.folder.findMany({
      where: { tenantId: TENANT, id: { in: [child.id, grandchild.id] } },
      select: { id: true, path: true, depth: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(child.id)).toMatchObject({
      path: `${library.rootFolderId}.${target.id}.${child.id}`,
      depth: 3,
    });
    // Depth is stored, so it is recomputed on a move rather than left to disagree with the path.
    expect(byId.get(grandchild.id)).toMatchObject({
      path: `${library.rootFolderId}.${target.id}.${child.id}.${grandchild.id}`,
      depth: 4,
    });
  });

  it('publishes a move, because ancestry changed', async () => {
    const library = await aLibrary();
    const source = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Source',
        inheritAcl: true,
      }),
    );
    const target = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Destination',
        inheritAcl: true,
      }),
    );

    await asAdmin(() => libraries.moveFolder(source.id, target.id, source.version));

    const messages = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, aggregateId: source.id, eventType: 'library.folder-moved' },
    });
    expect(messages).toHaveLength(1);
  });

  it('refuses a blind move and a blind change to inheritance', async () => {
    const library = await aLibrary();
    const folder = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Guarded',
        inheritAcl: true,
      }),
    );
    const target = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Anywhere',
        inheritAcl: true,
      }),
    );

    await expect(
      asAdmin(() => libraries.moveFolder(folder.id, target.id, undefined)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    // Breaking inheritance restricts a subtree, and the previous state is not recoverable by anyone who
    // did not see it.
    await expect(
      asAdmin(() => libraries.updateFolder(folder.id, { inheritAcl: false }, undefined)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    // A rename is an ordinary edit, and stays blind-writable.
    await expect(
      asAdmin(() => libraries.updateFolder(folder.id, { name: 'Renamed' }, undefined)),
    ).resolves.toMatchObject({ name: 'Renamed' });
  });
});

describe('cascade delete and exact restore', () => {
  async function aTree(): Promise<{
    library: { id: string; rootFolderId: string };
    parent: string;
    child: string;
    grandchild: string;
    sibling: string;
  }> {
    const library = await aLibrary();
    const parent = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Parent',
        inheritAcl: true,
      }),
    );
    const child = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: parent.id,
        name: 'Child',
        inheritAcl: true,
      }),
    );
    const grandchild = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: child.id,
        name: 'Grandchild',
        inheritAcl: true,
      }),
    );
    const sibling = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Sibling',
        inheritAcl: true,
      }),
    );
    return {
      library: { id: library.id, rootFolderId: library.rootFolderId },
      parent: parent.id,
      child: child.id,
      grandchild: grandchild.id,
      sibling: sibling.id,
    };
  }

  it('takes the whole subtree and reports how many', async () => {
    const tree = await aTree();
    const parent = await asAdmin(() => libraries.getFolder(tree.parent));

    const removed = await asAdmin(() => libraries.deleteFolder(tree.parent, parent.version));

    // Deleting a folder means deleting what is in it — unlike a department, whose sub-departments are
    // not implied. Both are honest about it, and this one says how many it took.
    expect(removed).toBe(3);
    const deleted = await owner.folder.findMany({
      where: { tenantId: TENANT, id: { in: [tree.parent, tree.child, tree.grandchild] } },
      select: { deletedAt: true, deleteCascadeId: true },
    });
    expect(deleted.every((row) => row.deletedAt !== null)).toBe(true);
    // One cascade identifier across all three: that is what makes the restore exact.
    expect(new Set(deleted.map((row) => row.deleteCascadeId)).size).toBe(1);
  });

  it('leaves a sibling alone', async () => {
    const tree = await aTree();
    const parent = await asAdmin(() => libraries.getFolder(tree.parent));
    await asAdmin(() => libraries.deleteFolder(tree.parent, parent.version));

    const sibling = await owner.folder.findUnique({
      where: { id: tree.sibling },
      select: { deletedAt: true },
    });
    expect(sibling?.deletedAt).toBeNull();
  });

  it('restores exactly what the cascade took, and not what was already deleted', async () => {
    const tree = await aTree();

    // Monday: somebody deletes the grandchild on its own.
    const grandchild = await asAdmin(() => libraries.getFolder(tree.grandchild));
    await asAdmin(() => libraries.deleteFolder(tree.grandchild, grandchild.version));

    // Tuesday: somebody deletes the parent, which cascades over what remains.
    const parent = await asAdmin(() => libraries.getFolder(tree.parent));
    const removed = await asAdmin(() => libraries.deleteFolder(tree.parent, parent.version));
    expect(removed).toBe(2);

    // Restoring Tuesday's delete must not undo Monday's. "Everything currently deleted underneath"
    // would have resurrected the grandchild, which somebody removed deliberately.
    const deletedParent = await asAdmin(() => libraries.getFolder(tree.parent));
    const restored = await asAdmin(() =>
      libraries.restoreFolder(tree.parent, deletedParent.version),
    );

    expect(restored).toBe(2);
    const rows = await owner.folder.findMany({
      where: { tenantId: TENANT, id: { in: [tree.parent, tree.child, tree.grandchild] } },
      select: { id: true, deletedAt: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row.deletedAt]));
    expect(byId.get(tree.parent)).toBeNull();
    expect(byId.get(tree.child)).toBeNull();
    expect(byId.get(tree.grandchild)).not.toBeNull();
  });

  it('refuses to restore a folder whose parent is still deleted', async () => {
    const tree = await aTree();
    const parent = await asAdmin(() => libraries.getFolder(tree.parent));
    await asAdmin(() => libraries.deleteFolder(tree.parent, parent.version));

    // Restored on its own it would be live and unreachable from the library at the same time.
    const child = await asAdmin(() => libraries.getFolder(tree.child));
    await expect(
      asAdmin(() => libraries.restoreFolder(tree.child, child.version)),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'parentId', message: 'deleted' }] });
  });

  it('frees a sibling name while deleted and refuses the restore that would collide', async () => {
    const tree = await aTree();
    const parent = await asAdmin(() => libraries.getFolder(tree.parent));
    await asAdmin(() => libraries.deleteFolder(tree.parent, parent.version));

    // The partial index skips deleted rows, so the name is available again.
    await asAdmin(() =>
      libraries.createFolder({
        libraryId: tree.library.id,
        parentId: tree.library.rootFolderId,
        name: 'Parent',
        inheritAcl: true,
      }),
    );

    const deleted = await asAdmin(() => libraries.getFolder(tree.parent));
    await expect(
      asAdmin(() => libraries.restoreFolder(tree.parent, deleted.version)),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });
});

describe('deleting a library', () => {
  it('refuses while it still holds folders, and says how many', async () => {
    const library = await aLibrary();
    await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Occupied',
        inheritAcl: true,
      }),
    );

    const current = await asAdmin(() => libraries.getLibrary(library.id));
    await expect(
      asAdmin(() => libraries.deleteLibrary(library.id, current.version)),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'folderCount', message: '1' }] });
  });

  it('deletes an empty library and takes its root folder with it', async () => {
    const library = await aLibrary();
    await asAdmin(() => libraries.deleteLibrary(library.id, library.version));

    const root = await owner.folder.findUnique({
      where: { id: library.rootFolderId },
      select: { deletedAt: true },
    });
    // Leaving it live would put an orphan at the top of a folder list whose library is in the recycle
    // bin.
    expect(root?.deletedAt).not.toBeNull();
  });

  it('does not count the root as a folder that blocks the delete', async () => {
    const library = await aLibrary();
    const current = await asAdmin(() => libraries.getLibrary(library.id));
    // The root is created with the library and removed with it, so it is not something to clear first.
    expect(current.folderCount).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('does not read another tenant’s library', async () => {
    const library = await aLibrary();

    await expect(
      runWithContext(contextFor(OTHER_TENANT), () => libraries.getLibrary(library.id)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not list another tenant’s folders', async () => {
    const library = await aLibrary();

    const theirs = await runWithContext(contextFor(OTHER_TENANT), () =>
      libraries.listFolders({ page: 1, pageSize: 100, sortDirection: 'asc', deleted: 'all' }),
    );
    expect(theirs.data.map((row) => row.libraryId)).not.toContain(library.id);
  });
});
