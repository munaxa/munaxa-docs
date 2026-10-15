import { Inject, Injectable } from '@nestjs/common';

import { type TenantId, asId, isDomainError, ErrorCode } from '@edms/domain';

import {
  BULK_REQUESTER_DIRECTORY,
  type BulkRequesterDirectory,
} from '../../../core/bulk/bulk.port';
import { NotFoundError } from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import {
  DOWNLOAD_REDEEMERS,
  type DownloadLinkGrant,
  type DownloadRedeemerRegistry,
} from '../../storage/application/ports';

/**
 * Whether a verified download link may still be used, asked as if the person were asking now —
 * ADR-0026 §10, the download-integrity proposal §3.1, the export design §2.2.
 *
 * A link is followed by navigation, which carries no bearer token, so its redemption cannot lean
 * on the request guards. It does what they do instead, from the database:
 *
 * 1. **The person, for every kind.** Looked up again (`BULK_REQUESTER_DIRECTORY`, the bulk lane's
 *    own source of a requester's current authority). Gone or disabled refuses; so does a
 *    permission version other than the one the link was issued under, exactly as
 *    `AuthenticationGuard` refuses an access token — a sign-out everywhere, a password reset, a
 *    disabled account or a role change since the link was issued all move it.
 * 2. **The kind's own questions**, by the redeemer the owning module registered for it
 *    (`DOWNLOAD_REDEEMERS`), run inside the person's context built from that authority: a
 *    document's permission, ACL, confidentiality and current file; a report export's ownership,
 *    state and the report's permissions; an evidence bundle's `audit:export` and artefact; and so
 *    on. A kind no module registered is refused.
 *
 * Every refusal is the same `NotFoundError`, as at the guards: the difference between "revoked",
 * "not yours", "not finished" and "never existed" is nobody's business at this door. A document's
 * confidentiality refusal is the one exception that predates this split and is kept as it was (a
 * 403). Each refusal is logged for the operator.
 */
@Injectable()
export class DownloadRedemptionService {
  constructor(
    @Inject(BULK_REQUESTER_DIRECTORY) private readonly requesters: BulkRequesterDirectory,
    @Inject(DOWNLOAD_REDEEMERS) private readonly redeemers: DownloadRedeemerRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The person's context, if the link may be used now — to run the download and its audit under —
   * and the correlation fields its redeemer wants on `FILE_DOWNLOAD_SERVED`.
   */
  async redeem(
    grant: DownloadLinkGrant,
    correlationId: string,
  ): Promise<{
    readonly context: RequestContext;
    readonly audit: Readonly<Record<string, string>>;
  }> {
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
    const redeemer = this.redeemers.for(grant.subject.kind);
    if (redeemer === null) {
      return this.refuse(grant, 'no module redeems links of this kind');
    }

    const context: RequestContext = {
      ...base,
      userId: grant.userId,
      roles: [...authority.roleIds],
      permissions: [...authority.permissions],
      permissionVersion: authority.permissionVersion,
    } as unknown as RequestContext;

    try {
      // The registry hands back the redeemer registered for exactly this kind.
      const redeem = redeemer.redeem.bind(redeemer);
      const redeemed = await runWithContext(context, () => redeem(grant));
      return { context, audit: redeemed.audit };
    } catch (error) {
      if (isDomainError(error) && error.code === ErrorCode.NOT_FOUND) {
        // The redeemer's own sentence names what it looked for, which is a way of saying whether
        // it was there; the one the door answers does not.
        return this.refuse(grant, error.message);
      }
      throw error;
    }
  }

  private refuse(grant: DownloadLinkGrant, why: string): never {
    this.logger.warn('A download link was refused at redemption', {
      tenantId: grant.tenantId,
      userId: grant.userId,
      kind: grant.subject.kind,
      subject: grant.subject,
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
