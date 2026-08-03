/**
 * Header names the API defines. Constants rather than string literals, because both sides
 * of the wire read them and a typo on one side is otherwise silent.
 */
export const Header = {
  /** Replays the stored response of a mutating request instead of performing it twice. */
  IDEMPOTENCY_KEY: 'Idempotency-Key',
  /** Optimistic concurrency: the aggregate `version` the caller believes it is changing. */
  IF_MATCH: 'If-Match',
  /** Accepted or generated, echoed on every response, stored on every audit event. */
  CORRELATION_ID: 'X-Correlation-Id',
  /** Seconds to wait after a 429. Always set when one is returned. */
  RETRY_AFTER: 'Retry-After',
} as const;

export type HeaderName = (typeof Header)[keyof typeof Header];
