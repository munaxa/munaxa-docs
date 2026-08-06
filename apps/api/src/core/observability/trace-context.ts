import { randomBytes } from 'node:crypto';

/**
 * W3C Trace Context, as a pure function of the header.
 *
 * ## Why a trace exists here at all, and why it is one span
 *
 * Phase 0.5's debt row 9 names metrics *and* tracing together, and they turned out to be
 * different questions with different answers. A metric is a number a backend aggregates, so the
 * only decision it needs is which backend — which is what an exporter behind configuration
 * settles. A **trace is a tree**, and the size of the tree is the decision: a span per request is
 * one object per request and a field on a log line, and a span per repository call is a span for
 * every row a list draws, on the most-loaded route in the product, forwarded to a collector that
 * charges by the span.
 *
 * So this product traces at the request boundary and nowhere else. What that buys is the thing a
 * customer's own tracing actually needs — **their** trace id, arriving in `traceparent`, appearing
 * on every log line this deployment writes for that request, and travelling onward on any outbound
 * call — so a request that crosses from their gateway into this API and out to their webhook
 * receiver is one trace in their collector rather than three unrelated ones. What it does not buy
 * is a flame graph of this process's internals, and 20 §5 now says so rather than implying a
 * span tree that is not emitted.
 *
 * ## Why it is parsed rather than trusted
 *
 * `traceparent` is attacker-controlled on any public route. A malformed value must not propagate,
 * because it would be written into every log line for the request and forwarded to a third party's
 * collector — the same reasoning that makes `CorrelationIdMiddleware` accept a client-supplied id
 * only when it is a UUID. The grammar below is the whole of the version-00 format, and anything
 * that is not exactly it starts a new trace instead.
 *
 * @see https://www.w3.org/TR/trace-context/
 */

/** `00-<32 hex>-<16 hex>-<2 hex>` — version 00, the only version anything emits. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);

export interface TraceContext {
  /** 32 lowercase hex characters. The identity of the whole trace. */
  readonly traceId: string;
  /** 16 lowercase hex characters. This request's own span. */
  readonly spanId: string;
  /**
   * Whether the caller asked for this trace to be recorded.
   *
   * Honoured rather than re-decided: a deployment that sampled independently of its caller would
   * produce traces with holes in them, which is worse than not tracing at all because the hole
   * looks like a missing service.
   */
  readonly sampled: boolean;
  /**
   * The span this one is a child of, when the caller sent one.
   *
   * Null for a trace that starts here, which is what a browser request looks like.
   */
  readonly parentSpanId: string | null;
}

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The incoming header, or null when there is nothing usable in it.
 *
 * All-zero ids are refused explicitly: the specification defines both as invalid, and they are
 * exactly what a client library emits when it has been configured with tracing switched off — so
 * accepting them would give thousands of unrelated requests one trace id.
 */
export function parseTraceparent(header: string | undefined): TraceContext | null {
  if (header === undefined) {
    return null;
  }
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (match === null) {
    return null;
  }
  const [, traceId = '', parentSpanId = '', flags = '00'] = match;
  if (traceId === INVALID_TRACE_ID || parentSpanId === INVALID_SPAN_ID) {
    return null;
  }
  return {
    traceId,
    spanId: newSpanId(),
    // Bit 0 of the flags byte is `sampled`. The other seven bits are reserved, and a value that
    // sets one of them is still a valid header — so this masks rather than compares.
    sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01,
    parentSpanId,
  };
}

/**
 * A trace that begins at this deployment.
 *
 * Sampled, because the only consumer of the flag here is whatever the caller does with the header
 * this deployment emits, and a request nothing upstream had an opinion about is one this
 * deployment is willing to have recorded. A sampling *rate* would be a second thing to configure
 * for a signal that costs one log field.
 */
export function startTrace(): TraceContext {
  return { traceId: newTraceId(), spanId: newSpanId(), sampled: true, parentSpanId: null };
}

/** The header to send onward, naming *this* span as the parent of whatever receives it. */
export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

/** The incoming header if it is usable, and a new trace if it is not. */
export function continueOrStartTrace(header: string | undefined): TraceContext {
  return parseTraceparent(header) ?? startTrace();
}
