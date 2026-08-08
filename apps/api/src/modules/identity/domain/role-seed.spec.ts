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
