import { describe, expect, it } from 'vitest';

import { Permission, type PermissionKey } from '@edms/domain';

import type { AclResolver } from '../../../core/authorization/acl-resolver.port';
import { ForbiddenError } from '../../../core/errors/application-errors';
import type { Logger } from '../../../core/observability/logger';
import { currentContext } from '../../../core/tenancy/tenant-context';
import type { DownloadLinkGrant } from '../../storage/application/ports';
import type { DefaultDocumentService } from './document.service';
import { DownloadRedemptionService } from './download-redemption.service';
import type { RevisionControlService } from './revision-control.service';

/**
 * Redeeming a verified download link asks every question again — ADR-0026 §10.
 *
 * The person, their permission version, the tenant-wide permission, the document's ACL, the use
 * case (confidentiality, which file is current). Each refusal is a 404, whatever the reason.
 */

const GRANT: DownloadLinkGrant = {
  tenantId: '0199f5a1-5a9e-7000-8000-00000000a001',
  userId: '0199f5a1-5a9e-7000-8000-00000000b001',
  permissionVersion: 4,
  documentId: '0199f5a1-5a9e-7000-8000-00000000d001',
  revisionId: null,
  fileObjectId: '0199f5a1-5a9e-7000-8000-00000000f001',
  disposition: 'attachment',
  filename: 'p.pdf',
  mimeType: 'application/pdf',
  expiresAt: new Date('2026-10-14T12:01:00Z'),
};

interface Situation {
  authority?: {
    roleIds: string[];
    roleKeys: string[];
    permissions: PermissionKey[];
    permissionVersion: number;
  } | null;
  aclAllows?: (permission: PermissionKey) => boolean;
  current?: () => Promise<{ fileObjectId: string; filename: string }>;
  revision?: () => Promise<{ fileObjectId: string; filename: string }>;
}

function redemption(situation: Situation = {}) {
  const asked: { permissions: PermissionKey[]; userInContext: unknown[] } = {
    permissions: [],
    userInContext: [],
  };
  const authority =
    situation.authority === undefined
      ? {
          roleIds: ['role-1'],
          roleKeys: ['READER'],
          permissions: [Permission.DOCUMENT_DOWNLOAD, Permission.DOCUMENT_HISTORY_VIEW],
          permissionVersion: 4,
        }
      : situation.authority;
  const service = new DownloadRedemptionService(
    { currentAuthority: () => Promise.resolve(authority) },
    {
      resolve: (_subject: unknown, _scope: unknown, permission: PermissionKey) => {
        asked.permissions.push(permission);
        asked.userInContext.push(currentContext()?.userId);
        return Promise.resolve({ allowed: situation.aclAllows?.(permission) ?? true });
      },
    } as unknown as AclResolver,
    { run: <T>(work: () => Promise<T>) => work() },
    {
      currentDownloadTarget: () =>
        situation.current?.() ??
        Promise.resolve({ fileObjectId: GRANT.fileObjectId, filename: 'p.pdf' }),
    } as unknown as DefaultDocumentService,
    {
      revisionDownloadTarget: () =>
        situation.revision?.() ??
        Promise.resolve({ fileObjectId: GRANT.fileObjectId, filename: 'p.pdf' }),
    } as unknown as RevisionControlService,
    { warn: () => undefined } as unknown as Logger,
  );
  return { service, asked };
}

describe('redeeming a verified download link', () => {
  it('answers the person’s current context when every question still holds', async () => {
    const { service, asked } = redemption();
    const context = await service.redeem(GRANT, 'c-1');
    expect(context).toMatchObject({
      tenantId: GRANT.tenantId,
      userId: GRANT.userId,
      roles: ['role-1'],
      permissionVersion: 4,
    });
    expect(asked.permissions).toEqual([Permission.DOCUMENT_DOWNLOAD]);
    // The ACL is asked as the person, not as the system.
    expect(asked.userInContext).toEqual([GRANT.userId]);
  });

  it('asks for history access too for a revision’s link', async () => {
    const { service, asked } = redemption();
    await service.redeem({ ...GRANT, revisionId: '0199f5a1-5a9e-7000-8000-00000000e001' }, 'c');
    expect(asked.permissions).toEqual([
      Permission.DOCUMENT_HISTORY_VIEW,
      Permission.DOCUMENT_DOWNLOAD,
    ]);
  });

  it.each<[string, Situation]>([
    ['the person is gone or disabled', { authority: null }],
    [
      'the person’s permission version moved (signed out everywhere, reset, role change)',
      {
        authority: {
          roleIds: ['role-1'],
          roleKeys: ['READER'],
          permissions: [Permission.DOCUMENT_DOWNLOAD],
          permissionVersion: 5,
        },
      },
    ],
    [
      'the person no longer holds document:download',
      {
        authority: {
          roleIds: ['role-1'],
          roleKeys: ['READER'],
          permissions: [Permission.DOCUMENT_VIEW],
          permissionVersion: 4,
        },
      },
    ],
    ['the document’s ACL now denies it', { aclAllows: () => false }],
    [
      'the document’s current content is another file now',
      {
        current: () =>
          Promise.resolve({ fileObjectId: '0199f5a1-5a9e-7000-8000-00000000f002', filename: 'p' }),
      },
    ],
  ])('refuses with a 404 when %s', async (_case, situation) => {
    await expect(redemption(situation).service.redeem(GRANT, 'c')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('passes on the use case’s own refusal (a confidentiality level that forbids download)', async () => {
    const { service } = redemption({
      current: () => Promise.reject(new ForbiddenError('download this document')),
    });
    await expect(service.redeem(GRANT, 'c')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
