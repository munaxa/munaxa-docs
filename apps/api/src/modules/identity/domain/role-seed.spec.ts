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
    //
    // The exception this test has been *named* for since it was written is `notification:manage`,
    // and until Slice 21 the body allowed for none: it asserted the empty list, which passed only
    // because the seed had the hole §6 says it must not have. The name was the intent and the
    // assertion was the accident. Marking your own notification read is not a mutation of anything
    // of the tenant's — the scope is `own` and enforced by there being no route under
    // `/notifications` or `/auth/mfa` that takes anybody's identifier — so it belongs on this row
    // and every other one, and the suffix is what makes it need saying out loud here.
    const managing = [...auditor].filter((permission) => permission.endsWith(':manage'));
    expect(managing).toEqual([Permission.NOTIFICATION_MANAGE]);
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

/**
 * The one row `08-permission-model.md` §6 marks `own` in every column — Slice 21.
 *
 * ## Why this is asserted as a row rather than per role
 *
 * Because the defect was a row with two holes in it, and every per-role assertion in this file
 * passed while it was there. Six of the eight are spelled inline in the map below
 * `DEFAULT_ROLE_PERMISSIONS`; the document controller's and the auditor's are named constants
 * hoisted above it, and those two were the ones that missed out. A comment on the library manager
 * said "every role below holds it", which was true of the four beneath it and quietly false of the
 * two above — the shape of an omission that reads as a decision.
 *
 * ## What it cost, which is why the row matters
 *
 * `MfaController` declares this key, for the reason its own docstring gives: it is the only
 * existing permission meaning "this person's own arrangements about their own account, held by
 * everybody including `GUEST`", and *everybody who can sign in must be able to secure their
 * sign-in*. So the two roles without it could not enrol a second factor.
 *
 * Worse, both are notification *recipients* the product resolves by permission rather than by role.
 * `NotificationEventService.chainBroken` sends the audit-chain-broken alert to
 * `holdersOfPermission(AUDIT_VIEW)` — the administrator, the controller and the auditor — and
 * `retentionDue` sends to `holdersOfPermission(RETENTION_MANAGE)`. Rows were being written to two
 * inboxes whose owners were refused `/notifications`, and 18 §3 makes the in-app inbox the
 * authoritative one.
 *
 * The assertion is `it.each` over **every** member of `SystemRole` rather than a list typed out
 * here, so a ninth seeded role cannot be added without either holding this key or failing.
 */
describe('every seeded role can read its own inbox and secure its own sign-in', () => {
  it.each(Object.values(SystemRole))('%s holds notification:manage', (role) => {
    expect(
      new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]).has(Permission.NOTIFICATION_MANAGE),
    ).toBe(true);
  });

  it('is the only permission every one of them holds', () => {
    /*
     * Stated as a property rather than left implicit, because "grant it to everybody" is a habit
     * rather than a rule and this is the one row where it is right. If a second key ever appears in
     * every column, that is either a new deliberate row — in which case §6 names it and this test
     * is updated with the reasoning — or somebody widening the seed to make a screen work, which is
     * the move Slices 12 and 20 both refused.
     */
    const everywhere = Object.values(Permission).filter((permission) =>
      Object.values(SystemRole).every((role) =>
        new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]).has(permission),
      ),
    );

    expect(everywhere).toEqual([Permission.NOTIFICATION_MANAGE]);
  });

  it('does not make the auditor or the controller an administrator on the way past', () => {
    // The grant is `own`-scoped and enforced by absence — no route under `/notifications` or
    // `/auth/mfa` takes a recipient or a user identifier. `/admin/notifications`, which edits the
    // tenant's templates and suppressions, is a different controller on `settings:manage`, and
    // neither role holds that. Asserted so a future reading of "notification:manage" as
    // "administers notifications" fails here rather than in production.
    for (const role of [SystemRole.AUDITOR, SystemRole.DOCUMENT_CONTROLLER]) {
      const held = new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]);
      expect(held.has(Permission.SETTINGS_MANAGE)).toBe(false);
      expect(held.has(Permission.USER_MANAGE)).toBe(false);
    }
  });

  it('leaves the auditor mutating nothing of the tenant’s', () => {
    // The row this file already guards for that column, restated against the new grant. An inbox
    // and an authenticator are the auditor's own; everything below is the tenant's.
    const auditor = new Set<string>(DEFAULT_ROLE_PERMISSIONS[SystemRole.AUDITOR]);
    for (const key of [
      Permission.DOCUMENT_CREATE,
      Permission.DOCUMENT_EDIT,
      Permission.DOCUMENT_DELETE,
      Permission.LIBRARY_MANAGE,
      Permission.FOLDER_MANAGE,
      Permission.DOCUMENT_PERMISSION_MANAGE,
      Permission.DELEGATION_MANAGE,
    ]) {
      expect(auditor.has(key)).toBe(false);
    }
  });
});
