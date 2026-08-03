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
  constructor(resource: string, field: string) {
    super(ErrorCode.DUPLICATE, `That ${resource} already exists.`, { field });
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

export const RETRYABLE_ERROR_CODES: readonly ErrorCodeKey[] = Object.freeze([
  ErrorCode.RATE_LIMITED,
  ErrorCode.DEPENDENCY_UNAVAILABLE,
  ErrorCode.VERSION_CONFLICT,
]);
