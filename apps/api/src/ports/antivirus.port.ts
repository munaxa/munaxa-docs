import type { ScanStatusKey } from '@edms/domain';

/**
 * The malware gate every uploaded byte passes through.
 *
 * A blob that is not `CLEAN` is unattachable and undownloadable — enforced in the use case
 * and by a database check constraint. Skipping the gate in any environment holding real data
 * is prohibited (`docs/architecture/17-security-architecture.md` §5, §10).
 */
export const ANTIVIRUS_PORT = Symbol('AntivirusPort');

export interface ScanRequest {
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly declaredMimeType: string;
  readonly timeoutMs: number;
}

export interface ScanVerdict {
  readonly status: ScanStatusKey;
  /** The signature name when infected; null otherwise. Recorded on the incident. */
  readonly threat: string | null;
  readonly scanner: string;
  readonly scannerVersion: string;
  readonly scannedAt: Date;
}

export interface AntivirusPort {
  readonly scanner: string;
  scan(request: ScanRequest): Promise<ScanVerdict>;
}
