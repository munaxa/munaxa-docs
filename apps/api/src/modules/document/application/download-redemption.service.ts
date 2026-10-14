import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  Permission,
  type PermissionKey,
  ScopeType,
  type TenantId,
  asId,
} from '@edms/domain';

import { ACL_RESOLVER, type AclResolver } from '../../../core/authorization/acl-resolver.port';
import {
  BULK_REQUESTER_DIRECTORY,
  type BulkRequesterDirectory,
} from '../../../core/bulk/bulk.port';
import { NotFoundError } from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import type { DownloadLinkGrant } from '../../storage/application/ports';
import { DefaultDocumentService } from './document.service';
import { RevisionControlService } from './revision-control.service';

/**
 * Whether a verified download link may still be used, asked as if the person were asking now —
 * ADR-0026 §10, the download-integrity proposal §3.1.
 *
 * A link is followed by navigation, which carries no bearer token, so its redemption cannot lean
 * on the request guards. It does what they do instead, in their order, from the database:
 *
 * 1. **The person.** Looked up again (`BULK_REQUESTER_DIRECTORY`, the bulk lane's own source of a
 *    requester's current authority). Gone or disabled refuses; so does a permission version other
 *    than the one the link was issued under, exactly as `AuthenticationGuard` refuses an access
 *    token — a sign-out everywhere, a password reset, a disabled account or a role change since
 *    the link was issued all move it.
 * 2. **The tenant-wide permission** (`RbacGuard`): `document:download`, and for a revision also
 *    `document:history:view`, as the issuing routes require.
 * 3. **The document's own reach** (`AclGuard`): the ACL resolver on the document's scope chain,
 *    deny-wins, for each of those permissions.
 * 4. **The use case** (`downloadTarget`): the document still exists for them, the confidentiality
 *    level still allows download, and the file the link names is still the file a download of it
 *    serves now — a newer current revision makes an older link refuse, never serve the old bytes
 *    in its name.
 *
 * Every refusal is the same `NotFoundError`, as at the guards: the difference between "revoked"
 * and "never existed" is nobody's business at this door. Each is logged for the operator.
 */
@Injectable()
export class DownloadRedemptionService {
  constructor(
    @Inject(BULK_REQUESTER_DIRECTORY) private readonly requesters: BulkRequesterDirectory,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    private readonly documents: DefaultDocumentService,
    private readonly revisions: RevisionControlService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The person's context, if the link may be used now — to run the download and its audit under.
   * Throws `NotFoundError` otherwise; may rethrow the use case's own refusals (403 for a
   * confidentiality level that forbids download).
   */
  async redeem(grant: DownloadLinkGrant, correlationId: string): Promise<RequestContext> {
    const base = tenantContext(grant.tenantId, correlationId);
    const authority = await runWithContext(base, () =>
      this.requesters.currentAuthority(grant.userId),
    );
    if (authority === null) {
      return this.refuse(grant, 'the person is gone or disabled');
    }
    if (authority.permissionVersion !== grant.permissionVersion) {
      return this.refuse(grant, 'the person’s sessions or permissions changed since it was issued');
    }
    const required: PermissionKey[] =
      grant.revisionId === null
        ? [Permission.DOCUMENT_DOWNLOAD]
        : [Permission.DOCUMENT_HISTORY_VIEW, Permission.DOCUMENT_DOWNLOAD];
    if (!required.every((permission) => authority.permissions.includes(permission))) {
      return this.refuse(grant, 'the person no longer holds the permission');
    }

    const context: RequestContext = {
      ...base,
      userId: grant.userId,
      roles: [...authority.roleIds],
      permissions: [...authority.permissions],
      permissionVersion: authority.permissionVersion,
    } as unknown as RequestContext;

    await runWithContext(context, async () => {
      for (const permission of required) {
        const decision = await this.unitOfWork.run(() =>
          this.acl.resolve(
            {
              userId: asId<AnyId>(grant.userId),
              roleIds: authority.roleIds.map((role) => asId<AnyId>(role)),
              departmentIds: [],
              delegationIds: [],
            } as Parameters<AclResolver['resolve']>[0],
            { type: ScopeType.DOCUMENT, id: asId<AnyId>(grant.documentId) },
            permission,
          ),
        );
        if (!decision.allowed) {
          this.refuse(grant, 'the document’s access control no longer allows it');
        }
      }
      const target =
        grant.revisionId === null
          ? await this.documents.currentDownloadTarget(grant.documentId)
          : await this.revisions.revisionDownloadTarget(grant.documentId, grant.revisionId);
      if (target.fileObjectId !== grant.fileObjectId) {
        this.refuse(grant, 'the document’s content changed since it was issued');
      }
    });
    return context;
  }

  private refuse(grant: DownloadLinkGrant, why: string): never {
    this.logger.warn('A download link was refused at redemption', {
      tenantId: grant.tenantId,
      userId: grant.userId,
      documentId: grant.documentId,
      revisionId: grant.revisionId,
      why,
    });
    throw new NotFoundError('The requested file');
  }
}

function tenantContext(tenantId: string, correlationId: string): RequestContext {
  return {
    tenantId: asId<TenantId>(tenantId),
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId,
    permissionVersion: 0,
    locale: 'en',
  };
}
