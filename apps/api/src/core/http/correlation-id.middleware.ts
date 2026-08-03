import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { Header } from '@edms/contracts';
import { correlationId as newCorrelationId, isUuid } from '@edms/utils';

/**
 * Gives every request an identity that survives into logs, audit events, outbox rows and
 * background jobs — so one support question can be answered across five systems.
 *
 * A client-supplied id is accepted only if it is a UUID: it is echoed back and stored, and
 * an unvalidated value would put attacker-chosen text into log lines and audit records.
 */
const CORRELATION_ID = Symbol('correlationId');

interface RequestWithCorrelationId extends Request {
  [CORRELATION_ID]?: string;
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: RequestWithCorrelationId, response: Response, next: NextFunction): void {
    const supplied = request.header(Header.CORRELATION_ID);
    const id = supplied && isUuid(supplied) ? supplied : newCorrelationId();
    request[CORRELATION_ID] = id;
    response.setHeader(Header.CORRELATION_ID, id);
    next();
  }
}

export function correlationIdOf(request: Request): string {
  return (request as RequestWithCorrelationId)[CORRELATION_ID] ?? 'unknown';
}
