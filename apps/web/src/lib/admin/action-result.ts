import { DomainError, ErrorCode, type ErrorCodeKey } from '@edms/domain';

/**
 * What a write reports back to the screen that asked for it.
 *
 * Server actions return this rather than throwing. A thrown error in a server action reaches the
 * client as an opaque digest with the message stripped — deliberately, so a server-side failure
 * cannot leak — which means a rejected save would tell an administrator nothing except that
 * something broke. A returned result carries the *code*, and the code is what the catalogue already
 * has a sentence for.
 *
 * `detail` is the API's own explanation, and it is shown only alongside a `VALIDATION_FAILED`:
 * that is the one code where the server knows something the client's own schema did not catch —
 * a duplicate rank, an unreachable stage — and where a generic "some details are not valid" wastes
 * the one useful thing the server said.
 */
export type ActionResult<TValue = void> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly code: ErrorCodeKey; readonly detail: string | null };

export function succeeded<TValue>(value: TValue): ActionResult<TValue> {
  return { ok: true, value };
}

export function failed<TValue = void>(
  code: ErrorCodeKey,
  detail: string | null = null,
): ActionResult<TValue> {
  return { ok: false, code, detail };
}

/**
 * Turns whatever a write threw into a result.
 *
 * Anything that is not a `DomainError` is `INTERNAL`, and its message is dropped. An unexpected
 * error's message is the one place a stack frame, a connection string or another tenant's data can
 * appear, and a screen has no use for it that is worth that risk.
 */
export function toActionResult<TValue = void>(error: unknown): ActionResult<TValue> {
  if (error instanceof DomainError) {
    return failed(error.code, error.code === ErrorCode.VALIDATION_FAILED ? error.message : null);
  }
  return failed(ErrorCode.INTERNAL);
}
