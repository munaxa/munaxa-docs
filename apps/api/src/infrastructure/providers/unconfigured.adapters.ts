import { Injectable } from '@nestjs/common';

import type { NotificationChannelKey, ScanStatusKey, StorageDriverKey } from '@edms/domain';

import { ProviderNotConfiguredError } from '../../core/errors/application-errors';
import type { AntivirusPort, ScanRequest, ScanVerdict } from '../../ports/antivirus.port';
import type {
  DeliveryReceipt,
  NotificationMessage,
  NotificationPort,
} from '../../ports/notification.port';
import type { OcrPort, OcrRequest, OcrResult } from '../../ports/ocr.port';
import type { SearchQuery, SearchResults, SearchSubject } from '../../ports/search.port';
import type { PlacedSearchPort } from '../tenancy/tenant-scoped-search';
import type {
  BlobMetadata,
  DownloadOptions,
  SignedUrl,
  StorageKey,
  StoragePort,
  UploadPart,
  UploadTarget,
  UploadTargetInput,
} from '../../ports/storage.port';

/**
 * What each port is bound to when its driver is `NONE`.
 *
 * A development environment can boot without object storage, an OCR engine or a mail
 * provider — but the moment something needs one, it fails loudly, naming the environment
 * variable that would fix it. The alternative, a no-op adapter that quietly succeeds, is
 * worse than an outage: it produces a document whose file was never stored, and nothing
 * says so until someone opens it.
 *
 * Production cannot reach this code: `loadConfig` refuses to start when a driver is `NONE`
 * (`core/config/configuration.ts`).
 */
@Injectable()
export class UnconfiguredStorageAdapter implements StoragePort {
  readonly driver: StorageDriverKey = 'LOCAL';

  createUploadTarget(_input: UploadTargetInput): Promise<UploadTarget> {
    return Promise.reject(this.failure());
  }

  completeUpload(_key: StorageKey, _parts: readonly UploadPart[]): Promise<BlobMetadata> {
    return Promise.reject(this.failure());
  }

  createDownloadUrl(_key: StorageKey, _options: DownloadOptions): Promise<SignedUrl> {
    return Promise.reject(this.failure());
  }

  head(_key: StorageKey): Promise<BlobMetadata | null> {
    return Promise.reject(this.failure());
  }

  copy(_from: StorageKey, _to: StorageKey): Promise<void> {
    return Promise.reject(this.failure());
  }

  delete(_key: StorageKey): Promise<void> {
    return Promise.reject(this.failure());
  }

  private failure(): ProviderNotConfiguredError {
    return new ProviderNotConfiguredError('Object storage', 'STORAGE_DRIVER');
  }
}

@Injectable()
export class UnconfiguredOcrAdapter implements OcrPort {
  readonly engine = 'unconfigured';

  supports(_mimeType: string): boolean {
    return false;
  }

  extract(_request: OcrRequest): Promise<OcrResult> {
    return Promise.reject(new ProviderNotConfiguredError('OCR', 'OCR_DRIVER'));
  }
}

@Injectable()
export class UnconfiguredNotificationAdapter implements NotificationPort {
  readonly channel: NotificationChannelKey = 'EMAIL';

  send(_message: NotificationMessage): Promise<DeliveryReceipt> {
    return Promise.reject(new ProviderNotConfiguredError('Email delivery', 'MAIL_DRIVER'));
  }
}

/**
 * The antivirus gate has no permissive default, in any environment.
 *
 * Returning `SKIPPED` here would make "upload works locally" mean "the gate is off", and
 * that difference between environments is exactly how unscanned content reaches production
 * (`docs/architecture/17-security-architecture.md` §10).
 */
@Injectable()
export class UnconfiguredAntivirusAdapter implements AntivirusPort {
  readonly scanner = 'unconfigured';

  scan(_request: ScanRequest): Promise<ScanVerdict> {
    return Promise.reject(new ProviderNotConfiguredError('Malware scanning', 'AV_DRIVER'));
  }
}

/**
 * Search, until the phase that builds it.
 *
 * Bound rather than left unbound, and the difference matters: an unbound port is a container that fails
 * to resolve at boot, which reads as a broken deployment. A bound one that refuses is a deployment that
 * works and tells you, when something searches, that no engine is configured.
 *
 * It implements `PlacedSearchPort` rather than `SearchPort`, so it sits underneath the tenant scoping
 * like every real adapter will — the isolation layer is exercised in every environment rather than only
 * once an engine exists.
 */
@Injectable()
export class UnconfiguredSearchAdapter implements PlacedSearchPort {
  query(_index: string, _subject: SearchSubject, _query: SearchQuery): Promise<SearchResults> {
    return Promise.reject(new ProviderNotConfiguredError('Search', 'SEARCH_DRIVER'));
  }
}

/** Every scan status other than CLEAN keeps content unreachable; the constant is here so the
 *  gate's meaning is defined next to the adapters that produce it. */
export const REACHABLE_SCAN_STATUS: ScanStatusKey = 'CLEAN';
