/**
 * A result that carries its failure in the type rather than throwing.
 *
 * Used where a failure is an expected outcome the caller must handle — a permission
 * decision, a parse, a lookup that may legitimately miss. Genuinely exceptional failures
 * still throw a `DomainError`; using `Result` for those only moves the crash later.
 */
export type Result<TValue, TError> =
  { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly error: TError };

export function ok<TValue>(value: TValue): Result<TValue, never> {
  return { ok: true, value };
}

export function err<TError>(error: TError): Result<never, TError> {
  return { ok: false, error };
}

export function isOk<TValue, TError>(
  result: Result<TValue, TError>,
): result is { ok: true; value: TValue } {
  return result.ok;
}

export function mapResult<TValue, TNext, TError>(
  result: Result<TValue, TError>,
  map: (value: TValue) => TNext,
): Result<TNext, TError> {
  return result.ok ? ok(map(result.value)) : result;
}

/** Unwraps, or falls back. For call sites that have already handled the failure path. */
export function unwrapOr<TValue, TError>(result: Result<TValue, TError>, fallback: TValue): TValue {
  return result.ok ? result.value : fallback;
}
