import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { Header } from '@edms/contracts';
import { correlationId as newCorrelationId, isUuid } from '@edms/utils';

import {
  continueOrStartTrace,
  formatTraceparent,
  startTrace,
  type TraceContext,
} from '../observability/trace-context';

/**
 * Gives every request an identity that survives into logs, audit events, outbox rows and
 * background jobs — so one support question can be answered across five systems.
 *
 * A client-supplied id is accepted only if it is a UUID: it is echoed back and stored, and
 * an unvalidated value would put attacker-chosen text into log lines and audit records.
 *
 * ## Phase 18 — and the W3C trace beside it
 *
 * The correlation id is **this product's** identifier and it stays exactly as it was. The trace
 * context is the *caller's*, and the two answer different questions: a correlation id joins a
 * request to the audit rows, outbox rows and jobs it caused inside this deployment, and a trace id
 * joins it to the gateway in front and the receiver behind. A deployment sitting between a
 * customer's ingress and a customer's webhook collector is one trace in their tooling because of
 * this header, and three unrelated ones without it.
 *
 * Both are established here, in the first middleware, so that a request rejected by
 * authentication is still traceable — which is the property that made this middleware first in
 * the chain in the first place.
 */
const CORRELATION_ID = Symbol('correlationId');
const TRACE = Symbol('traceContext');

/** The response header a caller reads to learn which span this deployment recorded. */
const TRACEPARENT = 'traceparent';

interface RequestWithCorrelationId extends Request {
  [CORRELATION_ID]?: string;
  [TRACE]?: TraceContext;
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: RequestWithCorrelationId, response: Response, next: NextFunction): void {
    const supplied = request.header(Header.CORRELATION_ID);
    const id = supplied && isUuid(supplied) ? supplied : newCorrelationId();
    request[CORRELATION_ID] = id;
    response.setHeader(Header.CORRELATION_ID, id);

    const trace = continueOrStartTrace(request.header(TRACEPARENT));
    request[TRACE] = trace;
    response.setHeader(TRACEPARENT, formatTraceparent(trace));

    next();
  }
}

export function correlationIdOf(request: Request): string {
  return (request as RequestWithCorrelationId)[CORRELATION_ID] ?? 'unknown';
}

/**
 * The request's trace, or a fresh one.
 *
 * The fallback exists for the same reason `correlationIdOf`'s does: a caller that reached a
 * handler without passing through this middleware — a test constructing a request by hand — must
 * get a usable value rather than an exception from the telemetry layer.
 */
export function traceContextOf(request: Request): TraceContext {
  return (request as RequestWithCorrelationId)[TRACE] ?? startTrace();
}
