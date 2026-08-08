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

  it('leaves the folder routes on folder:manage, which is a different decision', () => {
    // Two controllers because they are two permissions — the file says so, and this phase did not
    // change it. A library manager granted one on a node frequently is not meant to have the other.
    expect(declaredOn(FolderAdminController.prototype, 'list')).toEqual([Permission.FOLDER_MANAGE]);
  });
});
