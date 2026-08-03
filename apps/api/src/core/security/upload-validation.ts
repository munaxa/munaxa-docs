import type { ScanStatusKey } from '@edms/domain';

/**
 * The upload validation pipeline, declared as a contract before anything can upload.
 *
 * Order is the security property: the declared type is checked against the *sniffed* type,
 * then size and quota, then the malware scan — and content is unreachable until the scan
 * says `CLEAN`. A pipeline that scans last, or that trusts a file extension, is the standard
 * way document systems ship malware to their own users
 * (`docs/architecture/17-security-architecture.md` §5).
 */
export const UPLOAD_VALIDATOR = Symbol('UploadValidator');

export interface UploadCandidate {
  readonly filename: string;
  readonly declaredMimeType: string;
  readonly sizeBytes: number;
  /** The leading bytes, for content sniffing. Never the whole file. */
  readonly magicBytes: Uint8Array;
}

export interface UploadPolicy {
  readonly allowedMimeTypes: readonly string[];
  readonly maxBytesByMimeType: Readonly<Record<string, number>>;
  readonly maxBytesDefault: number;
  readonly archiveLimits: {
    readonly maxDepth: number;
    readonly maxEntries: number;
    /** Uncompressed-to-compressed ratio above which the archive is refused. */
    readonly maxExpansionRatio: number;
  };
}

export interface UploadRejection {
  readonly reason:
    'TYPE_NOT_ALLOWED' | 'TYPE_MISMATCH' | 'TOO_LARGE' | 'QUOTA_EXCEEDED' | 'ARCHIVE_LIMITS';
  readonly detail: string;
}

export interface UploadValidator {
  /** Runs before a presigned target is issued: nothing is stored to find out it is refused. */
  validate(candidate: UploadCandidate, policy: UploadPolicy): Promise<UploadRejection | null>;
  /** The gate every read path consults; only `CLEAN` content is reachable. */
  isReachable(scanStatus: ScanStatusKey): boolean;
}
