import { describe, expect, it } from 'vitest';

import { Permission, SystemRole } from '@edms/domain';

import { DEFAULT_ROLE_PERMISSIONS } from './role-seed';

/**
 * What the seeded roles actually hold — Phase 6.3.
 *
 * The other half of `library/presentation/library-permissions.spec.ts`, which owns the route
 * declarations. They are two files because the seed is this module's and the boundary lint refuses
 * a library spec that reaches into it; together they answer one question, and either alone can look
 * right while the pair is wrong.
 *
 * That is not hypothetical. `library:view` was declared, seeded to eight roles, and gated nothing,
 * because the route that lists libraries demanded `library:manage` instead — so `AUDITOR`, which
 * holds the first and deliberately not the second, could not list a library at all. Reading the
 * seed alone showed a role with the permission; reading the route alone showed a permission with a
 * plausible gate. Only the pair showed the gap.
 */
describe('the auditor seed, which is what makes library:view meaningful', () => {
  const auditor = new Set<string>(DEFAULT_ROLE_PERMISSIONS[SystemRole.AUDITOR]);

  it('holds library:view', () => {
    expect(auditor.has(Permission.LIBRARY_VIEW)).toBe(true);
  });

  it('does not hold library:manage, and must not gain it', () => {
    // `AUDITOR` "reads everything in scope and may never mutate anything, at any scope" (§6). If
    // this ever flips, the read fix in the library controller silently becomes a write grant.
    expect(auditor.has(Permission.LIBRARY_MANAGE)).toBe(false);
  });

  it('holds no permission that ends in :manage except its own inbox', () => {
    // The invariant behind the row above, stated once rather than per key — a mutating grant
    // arriving in this set is the thing worth failing a build over.
    const managing = [...auditor].filter((permission) => permission.endsWith(':manage'));
    expect(managing).toEqual([]);
  });
});

describe('the document controller keeps both library keys', () => {
  const controller = new Set<string>(DEFAULT_ROLE_PERMISSIONS[SystemRole.DOCUMENT_CONTROLLER]);

  it('reads and manages, so moving the reads to the narrower key took nothing away', () => {
    expect(controller.has(Permission.LIBRARY_VIEW)).toBe(true);
    expect(controller.has(Permission.LIBRARY_MANAGE)).toBe(true);
  });
});

/**
 * Consuming the tenant's configuration, without administering it.
 *
 * The same shape of gap as `library:view`'s, one layer out and measured the same way. A document
 * controller holds `document:create` and `document:edit`; exercising either means choosing a
 * document type, a category and a confidentiality level, and filling in whatever metadata fields
 * the type defines. Every one of those lists was behind `settings:manage`, `user:manage` or
 * `org:manage` — the three keys §6 marks `—` for this column — so the role whose whole job is
 * filing documents got the route's error boundary instead of the workspace.
 *
 * The read keys close that. What they must **not** do is close it by moving the column's four `—`
 * cells, which is what the second block below exists to fail over.
 */
describe('the document controller may consume configuration without administering it', () => {
  const controller = new Set<string>(DEFAULT_ROLE_PERMISSIONS[SystemRole.DOCUMENT_CONTROLLER]);

  it('holds both operational read keys', () => {
    expect(controller.has(Permission.CONFIGURATION_VIEW)).toBe(true);
    expect(controller.has(Permission.DIRECTORY_VIEW)).toBe(true);
  });

  it.each([
    ['settings:manage', Permission.SETTINGS_MANAGE],
    ['user:manage', Permission.USER_MANAGE],
    ['org:manage', Permission.ORG_MANAGE],
    ['role:manage', Permission.ROLE_MANAGE],
  ])('still holds no %s — the read keys replace it, they do not open the door to it', (_n, key) => {
    expect(controller.has(key)).toBe(false);
  });
});

describe('the auditor gains nothing from this phase', () => {
  const auditor = new Set<string>(DEFAULT_ROLE_PERMISSIONS[SystemRole.AUDITOR]);

  it('holds neither read key', () => {
    // Reading documents does not require the catalogue they were filed against, and the fix for
    // one role must not be a widening of another. Asserted rather than assumed, because "we did
    // not add it" is not something a future seed edit has to respect.
    expect(auditor.has(Permission.CONFIGURATION_VIEW)).toBe(false);
    expect(auditor.has(Permission.DIRECTORY_VIEW)).toBe(false);
  });
});

describe('the tenant administrator keeps everything it could already reach', () => {
  const admin = new Set<string>(DEFAULT_ROLE_PERMISSIONS[SystemRole.TENANT_ADMIN]);

  it('holds the read keys as well as the management ones', () => {
    // `RbacGuard` requires *all* declared permissions rather than any, so holding `settings:manage`
    // is not by itself enough to call a route declaring `configuration:view`.
    expect(admin.has(Permission.CONFIGURATION_VIEW)).toBe(true);
    expect(admin.has(Permission.DIRECTORY_VIEW)).toBe(true);
    expect(admin.has(Permission.SETTINGS_MANAGE)).toBe(true);
    expect(admin.has(Permission.USER_MANAGE)).toBe(true);
    expect(admin.has(Permission.ORG_MANAGE)).toBe(true);
  });
});

describe('no other seeded role receives the read keys', () => {
  it.each([
    SystemRole.LIBRARY_MANAGER,
    SystemRole.AUTHOR,
    SystemRole.APPROVER,
    SystemRole.READER,
    SystemRole.GUEST,
  ])('%s holds neither', (role) => {
    const held = new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]);
    expect(held.has(Permission.CONFIGURATION_VIEW)).toBe(false);
    expect(held.has(Permission.DIRECTORY_VIEW)).toBe(false);
  });
});
