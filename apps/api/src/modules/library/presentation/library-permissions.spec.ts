import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { Permission, type PermissionKey } from '@edms/domain';

import { REQUIRED_PERMISSIONS } from '../../../core/authorization/permission.decorator';
import { FolderAdminController, LibraryAdminController } from './library-admin.controller';

/**
 * Who may read the libraries, and who may change them — Phase 6.3.
 *
 * ## Why a test about decorator metadata
 *
 * `library:view` was in the catalogue and in `08-permission-model.md` §6's matrix from Phase 1,
 * granted to eight roles, and enforced by nothing: the only route that lists libraries declared
 * `library:manage`. Phase 6.0 found the permission unused by counting references; what it could not
 * see is that the *capability* existed and was gated on the wrong key.
 *
 * The consequence is the pair of assertions below, and it is the reason this is a test rather than a
 * note. `AUDITOR` is seeded with `library:view` and deliberately without `library:manage`, so before
 * this phase an auditor could not list the libraries at all — and the workspace document browser,
 * which fetches this route for its library selector, had nothing to show them.
 *
 * The declaration and the seed are two halves of one answer, and either alone can look right while
 * the pair is wrong — which is exactly what happened. They are asserted in **two** files because
 * the seed is Identity's and the boundary lint refuses a library spec that reaches into it: this
 * file owns the route declarations, and `role-seed.spec.ts` owns "what an auditor actually holds".
 * Each names the other.
 *
 * This is a *declaration* test. That the guard then enforces the declaration is `rbac.guard.spec.ts`'s,
 * and that the boot refuses an undeclared mutating route is `RoutePermissionRegistry`'s.
 */

function declaredOn(target: object, method: string): readonly PermissionKey[] {
  const handler = (target as Record<string, unknown>)[method];
  // Method metadata first, exactly as `RbacGuard` reads it — `getAllAndOverride([handler, class])`,
  // so a method-level declaration overrides the class's rather than adding to it.
  return (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler as object) ??
    Reflect.getMetadata(REQUIRED_PERMISSIONS, target.constructor)) as readonly PermissionKey[];
}

describe('the library routes declare the permission the matrix describes', () => {
  const library = LibraryAdminController.prototype;

  it('gates reading on library:view', () => {
    expect(declaredOn(library, 'list')).toEqual([Permission.LIBRARY_VIEW]);
    expect(declaredOn(library, 'get')).toEqual([Permission.LIBRARY_VIEW]);
  });

  it('keeps every write on library:manage', () => {
    for (const method of ['create', 'update', 'remove', 'restore']) {
      expect(declaredOn(library, method), `${method} must stay on library:manage`).toEqual([
        Permission.LIBRARY_MANAGE,
      ]);
    }
  });
});

/**
 * The folder routes, split the same way — and this **reverses** the decision above.
 *
 * Phase 6.3 asserted `folder:manage` on the folder list and called it "a different decision", on
 * the grounds that a library manager granted one permission on a node is frequently not meant to
 * have the other. That reasoning is about the two *management* grants and it survives intact: every
 * mutation below is still asserted on `folder:manage`, and nothing in this change lets a reader
 * create, rename, move, delete or restore anything.
 *
 * What it did not cover was reading, and the consequence surfaced later. An auditor holds
 * `document:view` and `library:view` and deliberately no management grant. It could open the
 * document workspace, list the libraries — and fail on the request for the folder *names*, which
 * `adminList` turns into a thrown 403 and a server component turns into the route's error boundary.
 * The one seeded role whose whole purpose is reading got a dead page.
 *
 * So folder structure now reads with the permission that already means "may see this library". The
 * audience does not widen: `library:view` is a tenant-wide grant, and the seeded roles holding it —
 * tenant administrator, document controller, auditor — are exactly the roles that can already list
 * the libraries these folders belong to.
 */
describe('the folder routes read with library:view and mutate with folder:manage', () => {
  const folder = FolderAdminController.prototype;

  it('gates reading on library:view', () => {
    expect(declaredOn(folder, 'list')).toEqual([Permission.LIBRARY_VIEW]);
    expect(declaredOn(folder, 'get')).toEqual([Permission.LIBRARY_VIEW]);
  });

  it('requires no management grant to read', () => {
    // Said from the other side, because the defect was precisely that a read demanded a management
    // permission. An auditor holds none, and must still be able to see the structure.
    for (const method of ['list', 'get']) {
      expect(declaredOn(folder, method), `${method} must not demand folder:manage`).not.toContain(
        Permission.FOLDER_MANAGE,
      );
    }
  });

  it('keeps every mutation on folder:manage', () => {
    /*
     * Asserted per method rather than left to the class decorator, and that is the point of this
     * test existing at all: the class guard is what the reads just stopped inheriting, so nothing
     * else may quietly stop inheriting it too. `library:view` alone reaches none of these.
     */
    for (const method of ['create', 'update', 'move', 'remove', 'restore']) {
      expect(declaredOn(folder, method), `${method} must stay on folder:manage`).toEqual([
        Permission.FOLDER_MANAGE,
      ]);
    }
  });
});
