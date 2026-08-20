import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { Permission, type PermissionKey } from '@edms/domain';

import { REQUIRED_PERMISSIONS } from '../../../core/authorization/permission.decorator';
import { NotificationAdminController } from './notification-admin.controller';
import { NotificationController } from './notification.controller';

/**
 * Reading your own inbox, and administering the tenant's notifications — two controllers, two keys.
 *
 * ## Why the route half needs asserting as well as the seed half
 *
 * `identity/domain/role-seed.spec.ts` says why in its own header: a seed and a route declaration
 * are two files, and "either alone can look right while the pair is wrong". That is not
 * hypothetical here. Slice 21 fixed the seed — `notification:manage` was granted to six of the
 * eight roles `08-permission-model.md` §6 marks `own` in every column — and nothing in this
 * repository asserted what the key actually opens, so a later reading of "notification:manage" as
 * "may administer notifications" would have handed every role the tenant's templates and
 * suppressions with no test in the way.
 *
 * The two halves are different questions and different owners. `/v1/notifications` is the caller's
 * own inbox and preferences, scoped `own` by **absence** — no route on it takes a recipient
 * identifier, so there is no request by which one person could reach another's inbox, whatever they
 * hold. `/v1/admin/notifications` edits the templates every tenant user receives and releases
 * suppressed addresses; it is `settings:manage`, which §6 marks `—` for six of the eight columns
 * including the two the seed fix was about.
 */
function declaredOn(target: object, method: string): readonly PermissionKey[] {
  const handler = (target as Record<string, unknown>)[method];
  return (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler as object) ??
    Reflect.getMetadata(REQUIRED_PERMISSIONS, target.constructor)) as readonly PermissionKey[];
}

describe('a person’s own inbox is on the key every seeded role holds', () => {
  const inbox = NotificationController.prototype;

  it.each([
    'inbox',
    'unreadCount',
    'markRead',
    'markAllRead',
    'preferences',
    'savePreference',
    'saveQuietHours',
  ])('gates %s on notification:manage and nothing else', (method) => {
    expect(declaredOn(inbox, method)).toEqual([Permission.NOTIFICATION_MANAGE]);
  });

  it.each(['inbox', 'unreadCount', 'preferences'])(
    'demands no management grant on %s',
    (method) => {
      // `RbacGuard` requires *every* declared permission rather than any, so one of these here would
      // put a person's own inbox behind the tenant administrator — which is the defect Slice 21
      // removed, arriving from the other direction.
      const declared = declaredOn(inbox, method);
      for (const key of [
        Permission.SETTINGS_MANAGE,
        Permission.USER_MANAGE,
        Permission.ORG_MANAGE,
        Permission.ROLE_MANAGE,
      ]) {
        expect(declared).not.toContain(key);
      }
    },
  );
});

describe('the tenant’s notification configuration stays on settings:manage', () => {
  const admin = NotificationAdminController.prototype;

  it.each([
    'types',
    'templates',
    'shipped',
    'saveTemplate',
    'deleteTemplate',
    'suppressions',
    'release',
  ])('keeps %s on settings:manage', (method) => {
    expect(declaredOn(admin, method)).toEqual([Permission.SETTINGS_MANAGE]);
  });

  it('is not reachable with the inbox key', () => {
    /*
     * The assertion the seed fix makes necessary. Every seeded role now holds
     * `notification:manage`, so if this controller ever accepted it, the templates every tenant
     * user receives — and the suppression list, which carries addresses — would be editable by a
     * guest. Asserted as an absence rather than left to the reading of a name that could plausibly
     * mean either thing.
     */
    for (const method of ['templates', 'saveTemplate', 'suppressions', 'release']) {
      expect(declaredOn(admin, method)).not.toContain(Permission.NOTIFICATION_MANAGE);
    }
  });
});
