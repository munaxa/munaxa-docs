/**
 * Domain failure codes and the base error every domain and application failure extends.
 *
 * The domain layer is pure: it knows that publishing a draft is illegal, not that the
 * answer is HTTP 409. The mapping from code to status lives in the API's error filter, and
 * the same code is what `@edms/contracts` publishes to clients.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  DUPLICATE: 'DUPLICATE',
  LOCKED: 'LOCKED',
  LEGAL_HOLD: 'LEGAL_HOLD',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  CONTENT_NOT_SCANNED: 'CONTENT_NOT_SCANNED',
  TENANT_READ_ONLY: 'TENANT_READ_ONLY',
  /**
   * The password was right and a second factor is owed — Phase 14.
   *
   * Its own code rather than `UNAUTHENTICATED`, because it is the one authentication outcome a
   * client must be able to act on differently: it renders the code field. `UNAUTHENTICATED` means
   * "start again"; this means "you are halfway". It is only ever returned *after* the password has
   * been verified, so it discloses nothing about which addresses hold accounts.
   */
  MFA_REQUIRED: 'MFA_REQUIRED',
  /**
   * The same request, under the same `Idempotency-Key`, is still being performed — RC validation,
   * D-20.
   *
   * Not a refusal of the request and not a conflict with somebody else's change: the first attempt
   * owns the key and has not answered yet. Retrying after it has answered replays that answer, so
   * the code is retryable and the client's next move is to ask again, not to change anything.
   */
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeKey = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Extra, non-sensitive facts about a failure. Never a stack trace, SQL or another user's data. */
export type ErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Why a refusal happened, in words the caller may be shown — ADR-0026 §10, Phase A.
 *
 * A code says what kind of failure it is and decides the status; a reason narrows the *message*
 * when the cause is known and safe to state. Phase A found every upload refusal answering "That file
 * type is not accepted." — for a file that was too large, one whose fingerprint was never sent, and
 * one whose link had expired — and an integrity quarantine described as a malware check still in
 * progress. Each reason has its own sentence in every catalogue (`errorReason.*`); the status and
 * the code stay those of the error's class, so a client that branches on `code` sees no change.
 */
export const ErrorReason = {
  TYPE_NOT_ALLOWED: 'TYPE_NOT_ALLOWED',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  TOO_LARGE: 'TOO_LARGE',
  EMPTY: 'EMPTY',
  FILENAME_UNUSABLE: 'FILENAME_UNUSABLE',
  SIZE_MISMATCH: 'SIZE_MISMATCH',
  DIGEST_UNCONFIRMED: 'DIGEST_UNCONFIRMED',
  UPLOAD_EXPIRED: 'UPLOAD_EXPIRED',
  UPLOAD_NOT_RECEIVED: 'UPLOAD_NOT_RECEIVED',
  UPLOAD_FINISHED: 'UPLOAD_FINISHED',
  SCAN_PENDING: 'SCAN_PENDING',
  SCAN_INFECTED: 'SCAN_INFECTED',
  SCAN_FAILED: 'SCAN_FAILED',
  SCAN_SKIPPED: 'SCAN_SKIPPED',
  INTEGRITY_FAILED: 'INTEGRITY_FAILED',
  SCANNER_BUSY: 'SCANNER_BUSY',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

export type ErrorReasonKey = (typeof ErrorReason)[keyof typeof ErrorReason];

/** A reason, and the values its sentence names (a size limit, say). Never anything sensitive. */
export interface PublicReason {
  readonly reason: ErrorReasonKey;
  readonly values?: Readonly<Record<string, string | number>>;
}

export class DomainError extends Error {
  readonly code: ErrorCodeKey;
  readonly details: ErrorDetails;
  /** What the caller is told when the cause is known; absent, the code's own sentence is used. */
  readonly publicReason: PublicReason | null;

  constructor(
    code: ErrorCodeKey,
    message: string,
    details: ErrorDetails = {},
    publicReason: PublicReason | null = null,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    this.publicReason = publicReason;
  }
}

export class InvariantViolation extends DomainError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(ErrorCode.VALIDATION_FAILED, message, details);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
