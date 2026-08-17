import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { Permission, type PermissionKey } from '@edms/domain';

import { REQUIRED_PERMISSIONS } from '../../../core/authorization/permission.decorator';
import { ConfigurationController, SettingsAdminController } from './administration.controller';
import { ConfigurationReadController } from './configuration-read.controller';

/**
 * Consuming the tenant's configuration, and administering it — two controllers, two keys.
 *
 * ## Why this is a test rather than a comment
 *
 * `library-permissions.spec.ts` records why. `library:view` was in the catalogue, seeded to eight
 * roles and enforced by nothing, because the only route that listed libraries declared
 * `library:manage`. The declaration and the seed are two halves of one answer, and either alone can
 * look right while the pair is wrong.
 *
 * The same shape of gap is what this phase closes, one layer out: a document controller holds
 * `document:create` and could not read a document type. What makes it *this* file's business is the
 * second half — that closing it must not open anything else. Nothing below lets a caller holding
 * `configuration:view` create, rename, deactivate or delete a single thing, and nothing lets it
 * read the tenant's settings.
 *
 * The seed's half is `identity/domain/role-seed.spec.ts`; the DTOs' half — what these routes may
 * and may not *return* — is `@edms/contracts`'s `operations/read-models.spec.ts`. Each names the
 * others.
 */

function declaredOn(target: object, method: string): readonly PermissionKey[] {
  const handler = (target as Record<string, unknown>)[method];
  // Method metadata first, exactly as `RbacGuard` reads it — `getAllAndOverride([handler, class])`,
  // so a method-level declaration overrides the class's rather than adding to it.
  return (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler as object) ??
    Reflect.getMetadata(REQUIRED_PERMISSIONS, target.constructor)) as readonly PermissionKey[];
}

describe('the operational read routes require configuration:view and nothing else', () => {
  const read = ConfigurationReadController.prototype;

  it.each(['documentTypes', 'categories', 'confidentialityLevels'])('gates %s', (method) => {
    expect(declaredOn(read, method)).toEqual([Permission.CONFIGURATION_VIEW]);
  });

  it('demands no management grant', () => {
    // Said from the other side, because the defect was precisely that consuming the vocabulary
    // demanded the permission that *defines* it. `RbacGuard` requires every declared permission,
    // so one management key on this list would put the whole read back behind the tenant
    // administrator and quietly restore the error boundary this phase removed.
    for (const method of ['documentTypes', 'categories', 'confidentialityLevels']) {
      expect(
        declaredOn(read, method),
        `${method} must not demand a management grant`,
      ).not.toContain(Permission.SETTINGS_MANAGE);
    }
  });
});

describe('the administrative configuration routes are untouched', () => {
  const admin = ConfigurationController.prototype;

  it.each([
    'listConfidentiality',
    'getConfidentiality',
    'listCategories',
    'getCategory',
    'listFields',
    'getField',
    'listDocumentTypes',
    'getDocumentType',
  ])('keeps %s on settings:manage', (method) => {
    /*
     * The administrative *reads* stay where they were, and that is the decision this phase makes
     * differently from Phase 6.3 and `588d851`. Both of those relaxed the existing read, because
     * the administrative response was also the right response for a reader. Here it is not: a
     * document type carries the numbering rule and the retention schedule, and a confidentiality
     * level carries the handling policy. The narrow routes above exist so these can stay shut.
     */
    expect(declaredOn(admin, method)).toEqual([Permission.SETTINGS_MANAGE]);
  });

  it.each([
    'createConfidentiality',
    'updateConfidentiality',
    'deleteConfidentiality',
    'restoreConfidentiality',
    'createCategory',
    'updateCategory',
    'moveCategory',
    'deleteCategory',
    'restoreCategory',
    'createField',
    'updateField',
    'deleteField',
    'restoreField',
    'createDocumentType',
    'updateDocumentType',
    'deleteDocumentType',
    'restoreDocumentType',
  ])('keeps the mutation %s on settings:manage', (method) => {
    const declared = declaredOn(admin, method);
    expect(declared).toEqual([Permission.SETTINGS_MANAGE]);
    // And explicitly not the new key, so a future refactor cannot make a read grant a write one.
    expect(declared).not.toContain(Permission.CONFIGURATION_VIEW);
    expect(declared).not.toContain(Permission.DIRECTORY_VIEW);
  });
});

describe('the tenant settings stay behind settings:manage', () => {
  const settings = SettingsAdminController.prototype;

  it('is not reachable with the new read key', () => {
    /*
     * The reason the key is `configuration:view` rather than `settings:view`. `/admin/settings`
     * carries the password policy, the session idle timeout and the confidentiality rank above
     * which reads are audited — tenant security policy, not filing vocabulary. A key named for
     * settings that deliberately did not read them would have promised the wrong thing.
     */
    for (const method of ['all', 'set', 'reset']) {
      const declared = declaredOn(settings, method);
      expect(declared, `${method} must stay administrative`).toEqual([Permission.SETTINGS_MANAGE]);
    }
  });
});
