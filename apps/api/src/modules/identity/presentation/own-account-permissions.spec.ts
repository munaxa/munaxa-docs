import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { Permission, type PermissionKey } from '@edms/domain';

import { REQUIRED_PERMISSIONS } from '../../../core/authorization/permission.decorator';
import { MfaController } from './mfa.controller';
import { UserAdminController } from './identity-admin.controller';

/**
 * Securing your own sign-in, which is the second thing `notification:manage` opens.
 *
 * `MfaController`'s own docstring explains the key, and the explanation is what makes the seed a
 * defect rather than a preference: 15 §5 asserts at boot that every mutating route declares a
 * permission, enrolling a second factor is neither a document act nor an administrative one, and
 * *"the only existing key whose meaning is 'this person's own arrangements about their own account,
 * held by everybody including `GUEST`' is `notification:manage`"*. Everybody who can sign in must
 * be able to secure their sign-in — and until Slice 21 the seeded document controller and auditor
 * held no such key, so neither could enrol.
 *
 * The notification half is `notification/presentation/notification-permissions.spec.ts`: two files
 * because they are two modules and the boundary lint refuses a spec that reaches into another
 * module's internals, the same split `directory-permissions.spec.ts` describes. Each names the
 * other.
 */
function declaredOn(target: object, method: string): readonly PermissionKey[] {
  const handler = (target as Record<string, unknown>)[method];
  return (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler as object) ??
    Reflect.getMetadata(REQUIRED_PERMISSIONS, target.constructor)) as readonly PermissionKey[];
}

describe('a person’s own authenticator is on the key every seeded role holds', () => {
  const mfa = MfaController.prototype;

  it.each(['status', 'begin', 'confirm'])('gates %s on notification:manage', (method) => {
    expect(declaredOn(mfa, method)).toEqual([Permission.NOTIFICATION_MANAGE]);
  });

  it('demands no management grant, or a role that may not administer cannot enrol', () => {
    const declared = declaredOn(mfa, 'begin');
    for (const key of [
      Permission.USER_MANAGE,
      Permission.SETTINGS_MANAGE,
      Permission.ROLE_MANAGE,
    ]) {
      expect(declared).not.toContain(key);
    }
  });
});

describe('un-enrolling somebody else stays an administrative act', () => {
  it('keeps the user administration routes on user:manage', () => {
    /*
     * The other half of the same boundary, and the reason the routes above can be open to everybody
     * without opening anything. `MfaController` takes no user identifier on any route, so the
     * `own` scope is enforced by absence; the lost-phone-and-lost-recovery-codes case is done
     * through user administration, "where it is a `user:manage` act with a name attached".
     */
    const declared = declaredOn(UserAdminController.prototype, 'update');
    expect(declared).toEqual([Permission.USER_MANAGE]);
    expect(declared).not.toContain(Permission.NOTIFICATION_MANAGE);
  });
});
