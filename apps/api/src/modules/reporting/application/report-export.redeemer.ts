import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  DOWNLOAD_REDEEMERS,
  DownloadLinkKind,
  type DownloadLinkGrantOf,
  type DownloadRedeemer,
  type DownloadRedeemerRegistry,
  type RedeemedDownload,
} from '../../storage/application/ports';
import { REPORTING_SERVICE, type ReportingService } from './ports';

/**
 * Reporting's answer to "may this report export link still be used" — registered for the
 * `REPORT_EXPORT` kind, so the one redemption route asks this module, and only this module, about
 * a report export. The questions themselves are the service's (`redeemExportDownload`), beside the
 * issuing half they mirror.
 */
@Injectable()
export class ReportExportRedeemer
  implements DownloadRedeemer<typeof DownloadLinkKind.REPORT_EXPORT>, OnModuleInit
{
  readonly kind = DownloadLinkKind.REPORT_EXPORT;

  constructor(
    @Inject(DOWNLOAD_REDEEMERS) private readonly registry: DownloadRedeemerRegistry,
    @Inject(REPORTING_SERVICE) private readonly reports: ReportingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  redeem(
    grant: DownloadLinkGrantOf<typeof DownloadLinkKind.REPORT_EXPORT>,
  ): Promise<RedeemedDownload> {
    return this.reports.redeemExportDownload(grant);
  }
}
