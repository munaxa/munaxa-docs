import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { type AnyId, Permission, type PermissionKey, ScopeType, asId } from '@edms/domain';

import { ACL_RESOLVER, type AclResolver } from '../../../core/authorization/acl-resolver.port';
import { NotFoundError } from '../../../core/errors/application-errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  DOWNLOAD_REDEEMERS,
  DownloadLinkKind,
  type DownloadLinkGrantOf,
  type DownloadRedeemer,
  type DownloadRedeemerRegistry,
  type RedeemedDownload,
} from '../../storage/application/ports';
import { DefaultDocumentService } from './document.service';
import { RevisionControlService } from './revision-control.service';

/**
 * A document link's own questions, asked again at redemption — what the guards and the use case
 * would ask of the person now, in their order:
 *
 * 1. **The tenant-wide permission** (`RbacGuard`): `document:download`, and for a revision also
 *    `document:history:view`, as the issuing routes require.
 * 2. **The document's own reach** (`AclGuard`): the ACL resolver on the document's scope chain,
 *    deny-wins, for each of those permissions.
 * 3. **The use case** (`downloadTarget`): the document still exists for them, the confidentiality
 *    level still allows download (a 403, as at issue), and the file the link names is still the
 *    file a download of it serves now — a newer current revision makes an older link refuse, never
 *    serve the old bytes in its name.
 *
 * Runs in the person's context, which `DownloadRedemptionService` built after re-reading them.
 */
@Injectable()
export class DocumentDownloadRedeemer
  implements DownloadRedeemer<typeof DownloadLinkKind.DOCUMENT>, OnModuleInit
{
  readonly kind = DownloadLinkKind.DOCUMENT;

  constructor(
    @Inject(DOWNLOAD_REDEEMERS) private readonly registry: DownloadRedeemerRegistry,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    private readonly documents: DefaultDocumentService,
    private readonly revisions: RevisionControlService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async redeem(
    grant: DownloadLinkGrantOf<typeof DownloadLinkKind.DOCUMENT>,
  ): Promise<RedeemedDownload> {
    const { documentId, revisionId } = grant.subject;
    const required: PermissionKey[] =
      revisionId === null
        ? [Permission.DOCUMENT_DOWNLOAD]
        : [Permission.DOCUMENT_HISTORY_VIEW, Permission.DOCUMENT_DOWNLOAD];
    await requireDocumentReach(this.acl, this.unitOfWork, documentId, required);
    const target =
      revisionId === null
        ? await this.documents.currentDownloadTarget(documentId)
        : await this.revisions.revisionDownloadTarget(documentId, revisionId);
    if (target.fileObjectId !== grant.fileObjectId) {
      throw new NotFoundError('the document’s content changed since it was issued');
    }
    return { audit: {} };
  }
}

/**
 * The person in the current context holds every one of `permissions` tenant-wide, and the
 * document's ACL allows each of them to that person. `NotFoundError` otherwise.
 */
export async function requireDocumentReach(
  acl: AclResolver,
  unitOfWork: UnitOfWork,
  documentId: string,
  permissions: readonly PermissionKey[],
): Promise<void> {
  const context = requireContext();
  if (!permissions.every((permission) => context.permissions.includes(permission))) {
    throw new NotFoundError('the person no longer holds the permission');
  }
  for (const permission of permissions) {
    const decision = await unitOfWork.run(() =>
      acl.resolve(
        {
          userId: asId<AnyId>(context.userId ?? ''),
          roleIds: context.roles.map((role) => asId<AnyId>(role)),
          departmentIds: [],
          delegationIds: [],
        } as Parameters<AclResolver['resolve']>[0],
        { type: ScopeType.DOCUMENT, id: asId<AnyId>(documentId) },
        permission,
      ),
    );
    if (!decision.allowed) {
      throw new NotFoundError('the document’s access control no longer allows it');
    }
  }
}
