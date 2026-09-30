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

/**
 * The password was accepted and the account has a second factor that has not been presented.
 *
 * `401` like every other authentication outcome, with its own code in the body — see
 * `ErrorCode.MFA_REQUIRED` for why it is distinguishable and why that is not a disclosure.
 */
export class MfaRequiredError extends DomainError {
  constructor() {
    super(ErrorCode.MFA_REQUIRED, 'A verification code from your authenticator is required.');
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

/**
 * A drawn number that another series already issued — NUM-1.
 *
 * Two series render the same text: two rules whose formats overlap, or one rule whose counter
 * restarts per scope while its text omits that scope. The database refuses the second
 * `uq_number_reservation_formatted` row, which is what keeps numbers unique; this is the refusal the
 * caller gets instead of the unique violation, raised *before* the insert so the transaction is
 * still sound and rolls back whole. `DUPLICATE` (409) rather than a new code, because the copy a
 * client shows for `DUPLICATE` already says the right thing; what is specific is in the field
 * error, which names the rule and the value so an administrator can find the overlap.
 *
 * Retrying cannot succeed: the counter's advance rolls back with the refusal, so the next attempt
 * draws the same value. The series needs its rule changed.
 */
export class NumberSeriesCollisionError extends DomainError {
  readonly fieldErrors: readonly { field: string; message: string }[];

  constructor(input: {
    readonly formatted: string;
    readonly numberingRuleId: string;
    readonly numberingRuleKey: string;
    readonly issuedByRuleId: string;
  }) {
    super(
      ErrorCode.DUPLICATE,
      `Numbering rule "${input.numberingRuleKey}" drew ${input.formatted}, which is already issued. ` +
        'Two numbering series produce the same text; an administrator must change a numbering rule.',
      {
        reason: 'NUMBER_SERIES_COLLISION',
        formatted: input.formatted,
        numberingRuleId: input.numberingRuleId,
        numberingRuleKey: input.numberingRuleKey,
        issuedByRuleId: input.issuedByRuleId,
      },
    );
    this.fieldErrors = [
      {
        field: 'documentNumber',
        message:
          `NUMBER_SERIES_COLLISION: numbering rule "${input.numberingRuleKey}" drew ` +
          `${input.formatted}, which is already issued`,
      },
    ];
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

/**
 * A legal hold refuses, and it refuses absolutely.
 *
 * ADR-0010 §5: a hold blocks disposition and deletion "regardless of policy or permission, until it
 * is explicitly released by a `legal-hold:manage` holder". So this is not a permission failure and
 * must not read as one — nothing the caller could be granted would let the operation through, and
 * `403` would send somebody to an administrator for a grant that does not exist. `ErrorCode.LEGAL_HOLD`
 * has been in the catalogue with a sentence in both locales since Phase 0.5, mapped to `409`, and
 * thrown by nothing until Phase 10.
 *
 * The count is named rather than the holds themselves: how many matters are holding a record is a
 * fact worth having at the point of refusal, and who placed them is behind `legal-hold:manage` on
 * the document's own holds endpoint.
 */
export class LegalHoldError extends DomainError {
  constructor(documentId: string, holds: number) {
    super(ErrorCode.LEGAL_HOLD, 'This document is under legal hold and cannot be removed.', {
      documentId,
      holds,
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

/**
 * The bytes are no longer the bytes that were stored — Phase 18's quarantine, enforced at the gate.
 *
 * The same code as an unscanned or infected file, deliberately: `17-security-architecture.md` §8
 * makes a mismatched blob "unreachable through the same gate an infected one fails", and a client
 * handles both the same way — it cannot open the file. The integrity finding travels as a detail
 * so the two remedies (a rescan, a restore) stay distinguishable in the log.
 */
export class ContentQuarantinedError extends DomainError {
  constructor(integrityStatus: string) {
    super(
      ErrorCode.CONTENT_NOT_SCANNED,
      'This file failed its integrity check and cannot be opened.',
      { integrityStatus },
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

/**
 * The first request under this `Idempotency-Key` still owns it — RC validation, D-20.
 *
 * Answered at once rather than by holding this request open until the owner finishes: waiting would
 * tie up a connection per duplicate for as long as the slowest owner takes, and the answer a retry
 * gets a moment later — the owner's own, replayed — is the one this request would have waited for.
 */
export class RequestInProgressError extends DomainError {
  constructor() {
    super(
      ErrorCode.REQUEST_IN_PROGRESS,
      'The same request is still being processed. Retry it to receive its result.',
    );
  }
}

export const RETRYABLE_ERROR_CODES: readonly ErrorCodeKey[] = Object.freeze([
  ErrorCode.RATE_LIMITED,
  ErrorCode.DEPENDENCY_UNAVAILABLE,
  ErrorCode.VERSION_CONFLICT,
  ErrorCode.REQUEST_IN_PROGRESS,
]);
