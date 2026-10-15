import { DomainError, ErrorCode, type ErrorCodeKey } from '@edms/domain';
import { DEFAULT_LOCALE, type LocaleKey, translate } from '@edms/i18n';

/**
 * What a write reports back to the screen that asked for it.
 *
 * Server actions return this rather than throwing. A thrown error in a server action reaches the
 * client as an opaque digest with the message stripped — deliberately, so a server-side failure
 * cannot leak — which means a rejected save would tell an administrator nothing except that
 * something broke. A returned result carries the *code*, and the code is what the catalogue already
 * has a sentence for.
 *
 * `detail` is set in two cases, and screens show it in place of the code's sentence:
 *
 * - alongside a `VALIDATION_FAILED`, the API's own explanation: the one code where the server knows
 *   something the client's own schema did not catch — a duplicate rank, an unreachable stage — and
 *   where a generic "some details are not valid" wastes the one useful thing the server said;
 * - when the API named the cause (`reason`), that reason's catalogue sentence in the person's
 *   language. A code is shared by unlike causes — `CONTENT_NOT_SCANNED` covers a scan in progress
 *   and a quarantined file, `DEPENDENCY_UNAVAILABLE` covers an outage the person should retry —
 *   and the code's sentence alone told a quarantined file "still being checked for malware" and a
 *   storage outage nothing about trying again (Hetzner Phase B).
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
 * `locale` is the person's (`currentLocale()`), for a reason's sentence. Anything that is not a
 * `DomainError` is `INTERNAL`, and its message is dropped. An unexpected
 * error's message is the one place a stack frame, a connection string or another tenant's data can
 * appear, and a screen has no use for it that is worth that risk.
 */
export function toActionResult<TValue = void>(
  error: unknown,
  locale: LocaleKey = DEFAULT_LOCALE,
): ActionResult<TValue> {
  if (error instanceof DomainError) {
    if (error.code === ErrorCode.VALIDATION_FAILED) {
      return failed(error.code, error.message);
    }
    if (error.publicReason !== null) {
      // A catalogue sentence chosen by key, never the error's message: the message of a
      // non-validation error is the server's own English and is not shown.
      const { reason, values } = error.publicReason;
      return failed(error.code, translate(locale, `errorReason.${reason}`, values ?? {}));
    }
    return failed(error.code, null);
  }
  return failed(ErrorCode.INTERNAL);
}
