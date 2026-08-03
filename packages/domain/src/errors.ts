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
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeKey = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Extra, non-sensitive facts about a failure. Never a stack trace, SQL or another user's data. */
export type ErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export class DomainError extends Error {
  readonly code: ErrorCodeKey;
  readonly details: ErrorDetails;

  constructor(code: ErrorCodeKey, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
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
