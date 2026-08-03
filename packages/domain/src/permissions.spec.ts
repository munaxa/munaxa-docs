import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSIONS,
  Permission,
  isPermissionKey,
  survivesBrokenInheritance,
} from './permissions';

describe('permission catalogue', () => {
  it('has no duplicate keys', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('uses resource:action form throughout', () => {
    for (const key of ALL_PERMISSIONS) {
      expect(key).toMatch(/^[a-z][a-z-]*(:[a-z][a-z-]*)+$/);
    }
  });

  it('recognises only catalogued keys', () => {
    expect(isPermissionKey(Permission.DOCUMENT_VIEW)).toBe(true);
    expect(isPermissionKey('document:incinerate')).toBe(false);
  });

  it('keeps administrative permissions immune to broken ACL inheritance', () => {
    expect(survivesBrokenInheritance(Permission.SETTINGS_MANAGE)).toBe(true);
    expect(survivesBrokenInheritance(Permission.AUDIT_VIEW)).toBe(true);
    expect(survivesBrokenInheritance(Permission.DOCUMENT_VIEW)).toBe(false);
  });
});
