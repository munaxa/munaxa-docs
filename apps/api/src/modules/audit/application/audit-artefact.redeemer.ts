import { Injectable, Inject, type OnModuleInit } from '@nestjs/common';

import {
  DOWNLOAD_REDEEMERS,
  DownloadLinkKind,
  type DownloadLinkGrantOf,
  type DownloadRedeemer,
  type DownloadRedeemerRegistry,
  type RedeemedDownload,
} from '../../storage/application/ports';
import { AuditExportService } from './audit-export.service';

/**
 * Audit's answer to "may this evidence artefact's link still be used" — registered for the
 * `AUDIT_ARTEFACT` kind, so the one redemption route asks this module, and only this module, about
 * an evidence bundle. The questions are the export service's (`redeemArtefactDownload`), beside the
 * issuing half they mirror.
 */
@Injectable()
export class AuditArtefactRedeemer
  implements DownloadRedeemer<typeof DownloadLinkKind.AUDIT_ARTEFACT>, OnModuleInit
{
  readonly kind = DownloadLinkKind.AUDIT_ARTEFACT;

  constructor(
    @Inject(DOWNLOAD_REDEEMERS) private readonly registry: DownloadRedeemerRegistry,
    private readonly exports: AuditExportService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  redeem(
    grant: DownloadLinkGrantOf<typeof DownloadLinkKind.AUDIT_ARTEFACT>,
  ): Promise<RedeemedDownload> {
    return this.exports.redeemArtefactDownload(grant);
  }
}
