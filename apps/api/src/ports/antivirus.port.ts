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
  /**
   * Has the configured scanner just scanned something? For readiness — RC D-3.
   *
   * Absent when no scanner is configured, so nothing can report a gate that is off as healthy.
   */
  probe?(timeoutMs: number): Promise<void>;
}

/**
 * A configured scanner was asked and gave no verdict — RC D-3.
 *
 * Unreachable, timed out, answered with an error, answered in a way this product cannot read as a
 * verdict, or was handed content it cannot scan. Every one of those is the same fact for the gate:
 * nothing has cleared these bytes. The storage service records it as `FAILED`, which is not `CLEAN`
 * and therefore not reachable — and is distinct from `SKIPPED`, which says no scanner was configured.
 *
 * The message is for the operator's log. It never reaches a client.
 */
export class AntivirusScanError extends Error {
  override readonly name = 'AntivirusScanError';

  constructor(
    message: string,
    readonly reason: 'UNREACHABLE' | 'TIMEOUT' | 'PROTOCOL' | 'SCANNER_ERROR' | 'UNSCANNABLE',
  ) {
    super(message);
  }
}
