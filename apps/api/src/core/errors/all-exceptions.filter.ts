import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { type ProblemDetails, problemTypeFor } from '@edms/contracts';
import { DomainError, ErrorCode, type ErrorCodeKey, isDomainError } from '@edms/domain';
import { negotiateLocale, translate } from '@edms/i18n';

import { LOGGER, type Logger } from '../observability/logger';
import { correlationIdOf } from '../http/correlation-id.middleware';
import { ValidationError } from './application-errors';

/** `problem.status` is a plain number on the wire, so the thresholds it is compared against
 *  are numbers too rather than enum members that only look comparable. */
const SERVER_ERROR_THRESHOLD: number = HttpStatus.INTERNAL_SERVER_ERROR;
const NOT_FOUND_STATUS: number = HttpStatus.NOT_FOUND;

/**
 * The one place an exception becomes a response.
 *
 * Every failure leaves as RFC 7807 problem details carrying the correlation id, in the
 * caller's language. What never leaves: stack traces, SQL, file paths, and any data
 * belonging to someone else — those go to the log, keyed by the same correlation id
 * (`docs/architecture/15-api-architecture.md` §4).
 */
const STATUS_BY_CODE: Readonly<Record<ErrorCodeKey, number>> = {
  [ErrorCode.VALIDATION_FAILED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ErrorCode.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.INVALID_TRANSITION]: HttpStatus.CONFLICT,
  [ErrorCode.VERSION_CONFLICT]: HttpStatus.CONFLICT,
  [ErrorCode.DUPLICATE]: HttpStatus.CONFLICT,
  [ErrorCode.LOCKED]: HttpStatus.LOCKED,
  [ErrorCode.LEGAL_HOLD]: HttpStatus.CONFLICT,
  [ErrorCode.QUOTA_EXCEEDED]: HttpStatus.CONFLICT,
  [ErrorCode.RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.UNSUPPORTED_CONTENT]: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  [ErrorCode.CONTENT_NOT_SCANNED]: HttpStatus.CONFLICT,
  [ErrorCode.TENANT_READ_ONLY]: HttpStatus.FORBIDDEN,
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorCode.INTERNAL]: HttpStatus.INTERNAL_SERVER_ERROR,
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const correlationId = correlationIdOf(request);
    const locale = negotiateLocale(request.headers['accept-language']);

    const problem = this.toProblem(exception, correlationId, locale);

    if (problem.status >= SERVER_ERROR_THRESHOLD) {
      this.logger.error('Unhandled request failure', {
        correlationId,
        path: request.path,
        method: request.method,
        error: exception instanceof Error ? exception.stack : String(exception),
      });
    } else {
      this.logger.warn('Request rejected', {
        correlationId,
        path: request.path,
        method: request.method,
        code: problem.code,
      });
    }

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(
    exception: unknown,
    correlationId: string,
    locale: ReturnType<typeof negotiateLocale>,
  ): ProblemDetails {
    if (isDomainError(exception)) {
      return this.fromDomainError(exception, correlationId, locale);
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === NOT_FOUND_STATUS ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_FAILED;
      return {
        type: problemTypeFor(code),
        title: exception.name,
        status,
        code,
        detail: translate(locale, `error.${code}`),
        correlationId,
      };
    }
    return {
      type: problemTypeFor(ErrorCode.INTERNAL),
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL,
      detail: translate(locale, 'error.INTERNAL'),
      correlationId,
    };
  }

  private fromDomainError(
    error: DomainError,
    correlationId: string,
    locale: ReturnType<typeof negotiateLocale>,
  ): ProblemDetails {
    const status = STATUS_BY_CODE[error.code];
    const problem: ProblemDetails = {
      type: problemTypeFor(error.code),
      title: error.code
        .toLowerCase()
        .split('_')
        .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
        .join(' '),
      status,
      code: error.code,
      detail: translate(locale, `error.${error.code}`),
      correlationId,
    };
    if (error instanceof ValidationError && error.fieldErrors.length > 0) {
      return { ...problem, errors: [...error.fieldErrors] };
    }
    return problem;
  }
}
