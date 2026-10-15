import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { downloadLimitWarnings } from '../domain/download-limits';

/** Says at start-up what the configured limits allow to exist that no download can verify. */
@Injectable()
export class DownloadLimitsCheck implements OnApplicationBootstrap {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    for (const warning of downloadLimitWarnings({
      maxFileBytes: this.config.download.maxFileBytes,
      maxUploadBytes: this.config.storage.maxUploadBytes,
      antivirus: this.config.providers.antivirus,
      icapMaxBytes: this.config.antivirus.maxBytes,
      reportMaxRows: this.config.reporting.exportMaxRows,
    })) {
      this.logger.warn(warning);
    }
  }
}
