import { DomainError, ErrorCode, type ErrorCodeKey, type ErrorDetails } from '@edms/domain';

/**
 * The failures the application layer raises, expressed once so every use case reports the
 * same way and the HTTP filter has a single mapping to maintain.
 *
 * Two of these encode product decisions rather than mechanics:
 *
 * - `NotFoundError` is what a cross-scope read returns. A caller who may not see an object
 *   is told it does not exist, so the API never leaks the existence of another tenant's
 *   document (`docs/architecture/15-api-architecture.md` §4).
 * - `ForbiddenError` is reserved for objects the caller *may* know about but may not act on,
 *   and every one of them is audited as `ACCESS_DENIED`.
 */
export class NotFoundError extends DomainError {
  constructor(resource: string, details: ErrorDetails = {}) {
    super(ErrorCode.NOT_FOUND, `${resource} was not found.`, details);
  }
}

export class ForbiddenError extends DomainError {
  constructor(action: string, details: ErrorDetails = {}) {
    super(ErrorCode.FORBIDDEN, `You do not have permission to ${action}.`, details);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(reason = 'Authentication is required.') {
    super(ErrorCode.UNAUTHENTICATED, reason);
  }
}

export class ValidationError extends DomainError {
  constructor(
    message: string,
    readonly fieldErrors: readonly { field: string; message: string }[] = [],
  ) {
    super(ErrorCode.VALIDATION_FAILED, message);
  }
}

export class VersionConflictError extends DomainError {
  constructor(expected: number, actual: number) {
    super(
      ErrorCode.VERSION_CONFLICT,
      'This record changed since you loaded it. Reload and try again.',
      { expectedVersion: expected, actualVersion: actual },
    );
  }
}

export class DuplicateError extends DomainError {
  /**
   * `extra` carries what the duplicate *is*, where that is something the caller can act on.
   *
   * A code collision needs no detail — the caller typed the code. A document whose content is
   * already filed somewhere else does: "this is already QA-014 under Quality/Procedures" is
   * actionable and "that document already exists" is not. Scalars only, like every error detail,
   * so a refusal never becomes a second copy of the data it is refusing.
   */
  constructor(resource: string, field: string, extra: ErrorDetails = {}) {
    super(ErrorCode.DUPLICATE, `That ${resource} already exists.`, { field, ...extra });
  }
}

export class DocumentLockedError extends DomainError {
  constructor(holderUserId: string, expiresAt: Date) {
    super(ErrorCode.LOCKED, 'This document is checked out by somebody else.', {
      // The holder is named, which is what makes the refusal actionable: "ask them, wait for
      // the expiry, or force it" are all decisions that need to know who and until when.
      holderUserId,
      expiresAt: expiresAt.toISOString(),
    });
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(from: string, to: string) {
    // Both halves named, which is what `06-document-lifecycle.md` asks of an illegal
    // transition: "a 409 Conflict with the offending pair named".
    super(ErrorCode.INVALID_TRANSITION, `A document cannot move from ${from} to ${to}.`, {
      from,
      to,
    });
  }
}

export class TenantReadOnlyError extends DomainError {
  constructor() {
    super(ErrorCode.TENANT_READ_ONLY, 'Your organisation is currently read-only.');
  }
}

export class DependencyUnavailableError extends DomainError {
  constructor(dependency: string, details: ErrorDetails = {}) {
    super(ErrorCode.DEPENDENCY_UNAVAILABLE, `${dependency} is unavailable.`, details);
  }
}

/** Raised by an unconfigured provider so the failure names the missing configuration. */
export class ProviderNotConfiguredError extends DependencyUnavailableError {
  constructor(capability: string, envVar: string) {
    super(capability, { configure: envVar });
  }
}

/**
 * The object store could not be reached, or refused.
 *
 * Distinct from a defect in this product, and reported as one: `DEPENDENCY_UNAVAILABLE` maps to a
 * 503 with a retry hint, which is what an upload against a store that is down should get.
 * Answering 500 would tell an operator to look here, and a client never to try again — both wrong
 * (`11-storage-architecture.md` §8).
 *
 * The message never quotes the store's own error document. Those quote the request that produced
 * them, signed URL included, and an exception message is the shortest path from a credential to a
 * log file.
 */
export class StorageUnavailableError extends DependencyUnavailableError {
  constructor(reason: string, options: { readonly cause?: unknown } = {}) {
    super('Object storage', { reason });
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * The content is stored but not yet cleared by the malware scanner, or was cleared and failed.
 *
 * Its own code because it is its own answer: the document exists, the caller may see it, and the
 * bytes are deliberately unreachable until the verdict is `CLEAN`
 * (`17-security-architecture.md` §5). A 404 would be a lie and a 403 would suggest a permission
 * somebody could be granted.
 */
export class ContentNotScannedError extends DomainError {
  constructor(status: string) {
    super(
      ErrorCode.CONTENT_NOT_SCANNED,
      status === 'PENDING'
        ? 'This file is still being checked for malware. Try again shortly.'
        : 'This file did not pass the malware check and cannot be opened.',
      { scanStatus: status },
    );
  }
}

/** The declared type, the sniffed type, the size or the archive limits refused the upload. */
export class UnsupportedContentError extends DomainError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(ErrorCode.UNSUPPORTED_CONTENT, message, details);
  }
}

/** The tenant's storage allowance is spent. Checked before a target is issued, never after. */
export class QuotaExceededError extends DomainError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(ErrorCode.QUOTA_EXCEEDED, message, details);
  }
}

export const RETRYABLE_ERROR_CODES: readonly ErrorCodeKey[] = Object.freeze([
  ErrorCode.RATE_LIMITED,
  ErrorCode.DEPENDENCY_UNAVAILABLE,
  ErrorCode.VERSION_CONFLICT,
]);
