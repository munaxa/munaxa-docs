import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { updateFolderSchema } from '@edms/contracts';
import {
  ScopeType,
  type ScopeTypeKey,
  type TenantId,
  type UserId,
  asId,
  idsInPath,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import {
  realAclResolver,
  realOrganizationService,
  realWriteStack,
} from '../../../testing/real-collaborators';
import type { FolderRow } from '../application/administration.ports';
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
  // Real, so a move clears real cache entries — this suite just never reads them back.
  realAclResolver({ clock, unitOfWork }),
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

    // A rename is an ordinary edit, and stays blind-writable.
    await expect(
      asAdmin(() => libraries.updateFolder(folder.id, { name: 'Renamed' }, undefined)),
    ).resolves.toMatchObject({ name: 'Renamed' });
  });

  /**
   * This case used to require `If-Match` for `updateFolder({ inheritAcl: false })` and said why:
   * "breaking inheritance restricts a subtree, and the previous state is not recoverable by anyone
   * who did not see it". The guard was right about the operation and wrong about the door —
   * Slice 33 removed the door, so there is nothing left here to require a version for.
   */
  it('does not accept inheritance on the folder route at all', async () => {
    // Refused at the boundary rather than ignored behind it. `.partial()` strips a key the object
    // does not declare, so a patch of nothing but `inheritAcl` becomes an empty patch — and the
    // schema's own refinement is what turns that into a refusal instead of a `200` for a change
    // that never happened.
    expect(updateFolderSchema.safeParse({ inheritAcl: false }).success).toBe(false);

    // And a real edit alongside it changes the name and leaves the flag alone.
    const library = await aLibrary();
    const folder = await asAdmin(() =>
      libraries.createFolder({
        libraryId: library.id,
        parentId: library.rootFolderId,
        name: 'Still inheriting',
        inheritAcl: true,
      }),
    );
    const patch = updateFolderSchema.parse({ name: 'Renamed again', inheritAcl: false });
    expect(patch).not.toHaveProperty('inheritAcl');

    const updated = await asAdmin(() => libraries.updateFolder(folder.id, patch, folder.version));
    expect(updated.name).toBe('Renamed again');
    expect(updated.inheritAcl).toBe(true);
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

/**
 * Two callers, each parked at a chosen boundary.
 *
 * Gated on an explicit marker rather than on "the turnstile is armed", so the ordinary setup this
 * suite performs through the same repository does not park itself, take ordinals no slot was armed
 * for, and leave the caller it does want to hold waiting for ever.
 */
class Turnstile<TMarker> {
  readonly arrivals: TMarker[] = [];
  readonly reached: Promise<void>[] = [];
  private readonly announce: (() => void)[] = [];
  private readonly admissions: Promise<void>[] = [];
  private readonly admits: (() => void)[] = [];

  arm(callers: number): number {
    const base = this.reached.length;
    for (let index = 0; index < callers; index += 1) {
      let arrive: () => void = () => undefined;
      this.reached.push(
        new Promise<void>((resolve) => {
          arrive = resolve;
        }),
      );
      this.announce.push(arrive);
      let admit: () => void = () => undefined;
      this.admissions.push(
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
      );
      this.admits.push(admit);
    }
    return base;
  }

  async park(marker: TMarker): Promise<void> {
    const ordinal = this.arrivals.length;
    this.arrivals.push(marker);
    this.announce[ordinal]?.();
    await this.admissions[ordinal];
  }

  release(ordinal: number): void {
    this.admits[ordinal]?.();
  }
}

/**
 * A folder move rewrites the paths it read, and only those — Slice 68.
 *
 * `moveFolder` reads its subtree, computes every descendant's new `path` and `depth` from that
 * snapshot, and writes them back. The moved folder's own write was version-guarded; the
 * descendants' writes were not, and the repository said why: path and depth "are derived data this
 * module owns, not fields anybody edits, so there is no concurrent edit to lose to".
 *
 * There is one, and it is this same method: a move writes a descendant's `path` and `depth`, and
 * the `parent_id` of the folder it was asked to move. Two moves inside one subtree are two writers
 * of one row, and the row that came out named one parent in `parent_id` and another in `path`.
 *
 * `path` is what resolves access. `PrismaScopeChainReader.chainFor` is `idsInPath(folder.path)`,
 * then a read of exactly those folders for their `inherit_acl` — so the chain a document's
 * permissions are decided on is the ancestry the *path* names. A stale path resolves the chain
 * through folders that are no longer above it, and not through the one that is: the entries on the
 * ancestry it left still reach it, and an inheritance break on the ancestry it joined does not.
 *
 * The database cannot catch this. `folder` carries no constraint tying `path` to `parent_id`, and
 * `ck_folder_depth` bounds `depth` to 1..32 without tying it to the path either.
 */
describe('a folder move that rewrites a subtree it no longer owns', () => {
  const turnstile = new Turnstile<string>();
  /** Which move this test wants to stop at, between its snapshot and its writes. */
  let parkOn: string | null = null;

  class ParkingLibraryRepository extends PrismaLibraryAdminRepository {
    override async moveFolder(
      input: Parameters<PrismaLibraryAdminRepository['moveFolder']>[0],
    ): Promise<void> {
      // Parked *here*: the service has already read the subtree and computed every new path and
      // depth, and has written nothing. That is the window the snapshot is stale in.
      if (parkOn === `move:${input.id}`) {
        await turnstile.park(`move:${input.id}`);
      }
      return super.moveFolder(input);
    }
  }

  const parking = new LibraryAdminService(
    new ParkingLibraryRepository(stamps),
    organization,
    outbox,
    realAclResolver({ clock, unitOfWork }),
    new FolderContentsRegistry(),
    writer,
  );

  /** `parent → child → grandchild` with a `sibling` beside the child, plus two folders to move to. */
  async function tree(): Promise<{
    parent: FolderRow;
    child: FolderRow;
    grandchild: FolderRow;
    sibling: FolderRow;
    destination: FolderRow;
    elsewhere: FolderRow;
  }> {
    const library = await aLibrary();
    const make = (parentId: string, name: string): Promise<FolderRow> =>
      asAdmin(() =>
        parking.createFolder({ libraryId: library.id, parentId, name, inheritAcl: true }),
      );
    const parent = await make(library.rootFolderId, 'Parent');
    const child = await make(parent.id, 'Child');
    const grandchild = await make(child.id, 'Grandchild');
    const sibling = await make(parent.id, 'Sibling');
    const destination = await make(library.rootFolderId, 'Destination');
    const elsewhere = await make(library.rootFolderId, 'Elsewhere');
    return { parent, child, grandchild, sibling, destination, elsewhere };
  }

  async function rowOf(id: string): Promise<{
    parentId: string | null;
    path: string;
    depth: number;
  }> {
    return owner.folder.findUniqueOrThrow({
      where: { id },
      select: { parentId: true, path: true, depth: true },
    });
  }

  /** Every live folder whose path or depth disagrees with the parent it actually points at. */
  async function foldersDisagreeingWithTheirParent(): Promise<string[]> {
    const rows = await owner.folder.findMany({
      where: { tenantId: TENANT, deletedAt: null },
      select: { id: true, parentId: true, path: true, depth: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return rows
      .filter((row) => {
        const parent = row.parentId === null ? null : byId.get(row.parentId);
        const expected = parent ? `${parent.path}.${row.id}` : row.id;
        return row.path !== expected || row.depth !== idsInPath(row.path).length;
      })
      .map((row) => row.id);
  }

  it('moves a subtree when nothing contends', async () => {
    // The control. Without it every assertion below passes on a service that moves nothing.
    const { parent, child, grandchild, destination } = await tree();
    const moved = await asAdmin(() =>
      parking.moveFolder(parent.id, destination.id, parent.version),
    );

    expect(moved.path).toBe(`${destination.path}.${parent.id}`);
    expect(moved.depth).toBe(destination.depth + 1);
    expect((await rowOf(child.id)).path).toBe(`${moved.path}.${child.id}`);
    expect((await rowOf(grandchild.id)).depth).toBe(moved.depth + 2);
    expect(await foldersDisagreeingWithTheirParent()).toEqual([]);
  });

  it('refuses to rewrite a descendant that moved out while it was deciding', async () => {
    const { parent, child, destination, elsewhere } = await tree();
    parkOn = `move:${parent.id}`;
    const base = turnstile.arm(1);

    // The first administrator moves the parent. Its subtree snapshot, taken before it parks, still
    // has the child under it.
    const movingParent = asAdmin(() =>
      parking.moveFolder(parent.id, destination.id, parent.version),
    );
    await turnstile.reached[base];

    // The second administrator moves the child out, from its own scope and so its own transaction,
    // and commits. This is the edit the first administrator's snapshot cannot know about.
    parkOn = null;
    const movedChild = await asAdmin(() =>
      parking.moveFolder(child.id, elsewhere.id, child.version),
    );
    expect(movedChild.path).toBe(`${elsewhere.path}.${child.id}`);

    turnstile.release(base);
    const outcome = await movingParent.then(
      () => ({ kind: 'moved' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    // Whatever the first move's own fate, the child must not be left describing an ancestry it does
    // not have: `chainFor` is `idsInPath(path)`, so a stale path is a stale ACL chain — the folders
    // it has left deciding its documents' permissions, and the one it has joined not.
    const after = await rowOf(child.id);
    expect(after.parentId).toBe(elsewhere.id);
    expect(after.path).toBe(`${elsewhere.path}.${child.id}`);
    expect(idsInPath(after.path)).not.toContain(parent.id);
    expect(after.depth).toBe(idsInPath(after.path).length);
    expect(await foldersDisagreeingWithTheirParent()).toEqual([]);

    // And the loser is told, rather than committing a rewrite of a tree that changed under it.
    expect(outcome.kind).toBe('refused');
    expect(outcome.error).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('refuses when a descendant only moved to another branch of the same subtree', async () => {
    /*
     * Why the guard refuses rather than quietly skipping the row it no longer recognises.
     *
     * The folder that moved is still inside the subtree being moved, so the rest of the snapshot is
     * still wrong about it: the grandchild now hangs from the sibling, and the sibling's path is
     * about to be rewritten. Skipping the one row whose parent changed would rewrite the sibling and
     * leave the grandchild describing where the sibling used to be — the same divergence, one level
     * further down. The whole snapshot is stale together, so the whole move is refused together.
     */
    const { parent, child, grandchild, sibling, destination } = await tree();
    parkOn = `move:${parent.id}`;
    const base = turnstile.arm(1);

    const movingParent = asAdmin(() =>
      parking.moveFolder(parent.id, destination.id, parent.version),
    );
    await turnstile.reached[base];

    parkOn = null;
    const moved = await asAdmin(() =>
      parking.moveFolder(grandchild.id, sibling.id, grandchild.version),
    );
    expect(moved.path).toBe(`${sibling.path}.${grandchild.id}`);

    turnstile.release(base);
    const outcome = await movingParent.then(
      () => ({ kind: 'moved' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    expect(outcome.kind).toBe('refused');
    expect(outcome.error).toMatchObject({ code: 'VERSION_CONFLICT' });
    // Refused means nothing was written, so the sibling still holds the path the grandchild names.
    expect((await rowOf(child.id)).path).toBe(`${parent.path}.${child.id}`);
    expect((await rowOf(sibling.id)).path).toBe(`${parent.path}.${sibling.id}`);
    expect(await foldersDisagreeingWithTheirParent()).toEqual([]);
  });

  it('still moves when a descendant was only put in the recycle bin', async () => {
    /*
     * The other side of the guard: what must *not* become a conflict.
     *
     * Deleting a leaf moves nothing, so the snapshot is still right about where every folder sits
     * and the move has nothing to lose to. The deleted row is carried along with the rest —
     * `folderSubtree` never sees a row already in the bin, so restoring one whose ancestors moved
     * meanwhile is a stale path either way, and this is the one window where the move can still
     * keep it honest.
     */
    const { parent, child, grandchild, destination } = await tree();
    parkOn = `move:${parent.id}`;
    const base = turnstile.arm(1);

    const movingParent = asAdmin(() =>
      parking.moveFolder(parent.id, destination.id, parent.version),
    );
    await turnstile.reached[base];

    parkOn = null;
    await asAdmin(() => parking.deleteFolder(grandchild.id, grandchild.version));

    turnstile.release(base);
    const moved = await movingParent;

    expect(moved.path).toBe(`${destination.path}.${parent.id}`);
    const movedChild = await rowOf(child.id);
    expect(movedChild.path).toBe(`${moved.path}.${child.id}`);
    // Carried with the subtree even though it is in the bin, so a restore does not resurrect a row
    // describing where its ancestors used to be.
    const deleted = await rowOf(grandchild.id);
    expect(deleted.path).toBe(`${movedChild.path}.${grandchild.id}`);
    expect(deleted.depth).toBe(idsInPath(deleted.path).length);
    expect(await foldersDisagreeingWithTheirParent()).toEqual([]);
  });
});
