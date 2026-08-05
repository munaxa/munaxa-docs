import { describe, expect, it } from 'vitest';

import { Permission, asId, type UserId } from '@edms/domain';

import {
  aclFingerprint,
  callerSubjectTokens,
  grantSubjectToken,
  indexAclSubjects,
} from './acl-subjects';

describe('acl subject tokens', () => {
  it('types every token by prefix, so identities of different kinds cannot collide', () => {
    const tokens = callerSubjectTokens({
      userId: asId<UserId>('u1'),
      roleIds: [asId('r1')],
      departmentIds: [asId('d1')],
      grantedPermissions: [Permission.DOCUMENT_VIEW],
    });
    expect(tokens).toEqual(['user:u1', 'role:r1', 'department:d1', 'grant:document:view']);
  });

  it('omits the user token for the system subject', () => {
    const tokens = callerSubjectTokens({
      userId: asId<UserId>(''),
      roleIds: [],
      departmentIds: [],
      grantedPermissions: [],
    });
    expect(tokens).toEqual([]);
  });

  it('materialises exactly the grant token for an index entry, in this generation', () => {
    expect(indexAclSubjects(Permission.DOCUMENT_VIEW)).toEqual({
      allowSubjects: [grantSubjectToken(Permission.DOCUMENT_VIEW)],
      denySubjects: [],
    });
  });

  it('a caller with the grant overlaps the entry; one without does not', () => {
    const entry = indexAclSubjects(Permission.DOCUMENT_VIEW);
    const granted = callerSubjectTokens({
      userId: asId<UserId>('u1'),
      roleIds: [asId('r1')],
      departmentIds: [],
      grantedPermissions: [Permission.DOCUMENT_VIEW],
    });
    const ungranted = callerSubjectTokens({
      userId: asId<UserId>('u2'),
      roleIds: [asId('r2')],
      departmentIds: [],
      grantedPermissions: [],
    });
    const overlaps = (subjects: readonly string[]): boolean =>
      entry.allowSubjects.some((token) => subjects.includes(token));
    expect(overlaps(granted)).toBe(true);
    expect(overlaps(ungranted)).toBe(false);
  });
});

describe('aclFingerprint', () => {
  it('is order-insensitive', () => {
    expect(aclFingerprint(['a', 'b'], ['x'])).toBe(aclFingerprint(['b', 'a'], ['x']));
  });

  it('distinguishes allow from deny', () => {
    expect(aclFingerprint(['a', 'b'], [])).not.toBe(aclFingerprint(['a'], ['b']));
  });

  it('is stable for equal input', () => {
    expect(aclFingerprint(['a'], ['b'])).toBe(aclFingerprint(['a'], ['b']));
  });
});
