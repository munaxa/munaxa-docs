import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { type Observable, catchError, tap, throwError } from 'rxjs';

import { CLOCK_PORT, type ClockPort } from '../../ports/clock.port';
import { correlationIdOf, traceContextOf } from '../http/correlation-id.middleware';
import { currentContext } from '../tenancy/tenant-context';
import { LOGGER, type Logger } from './logger';
import { METRICS, MetricName, statusClass, type Metrics } from './metrics';

/**
 * The request span, and the one HTTP metric — Phase 18.
 *
 * ## One span per request, and no span below it
 *
 * 20 §5's Traces row promises "request → use case → repository → adapter, and the outbox hop into
 * workers", and that is the row this phase had to decide rather than implement as written. A span
 * per repository call is a span for every row a list draws on the most-loaded route in the
 * product, forwarded to a collector that charges per span; a span per request is one object and
 * one log line. So the request boundary is instrumented and nothing below it is, 20 §5 now says
 * so, and `MetricName.MESSAGE_DURATION` carries the use-case layer as a *histogram* instead —
 * which answers "is this handler slow" without emitting a tree.
 *
 * The span is emitted as a structured log record rather than to a collector, because this build
 * contains no OTLP encoder and `OTEL_EXPORTER_OTLP_ENDPOINT` is refused at boot rather than
 * accepted and ignored. The record carries the trace and span ids in the field names every log
 * pipeline already correlates on, so a customer joining it to their own traces has one
 * configuration line rather than a new dependency here.
 *
 * ## Why the route *template*
 *
 * `request.route.path` is the pattern Express registered — `/api/v1/documents/:id` — not the path
 * that was requested. The distinction is the whole of the label rule: a path label is the document
 * identifier wearing another name, and it is the single most likely way this product's metrics
 * cardinality gets broken. A request that reached no route at all (a 404) is labelled `unmatched`
 * rather than by its path, for exactly the same reason.
 */
@Injectable()
export class RequestObservabilityInterceptor implements NestInterceptor {
  constructor(
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = this.clock.timestamp();

    return next.handle().pipe(
      tap({
        next: () => {
          this.record(request, routeOf(request), response.statusCode, startedAt);
        },
      }),
      catchError((error: unknown) => {
        // Read from the error rather than from the response: the exception filter has not run
        // yet, so `response.statusCode` is still 200 at this point and would report every
        // refusal in the product as a success.
        this.record(request, routeOf(request), statusOf(error), startedAt);
        return throwError(() => error);
      }),
    );
  }

  private record(request: Request, route: string, status: number, startedAt: number): void {
    const durationMs = this.clock.elapsedMs(startedAt);
    const trace = traceContextOf(request);
    const labels = { method: request.method, route, status: statusClass(status) };

    this.metrics.observe(MetricName.HTTP_REQUEST_DURATION, durationMs, labels);

    // The span. `traceId`/`spanId` rather than a nested object, because every log pipeline
    // correlates on flat fields and a nested one needs a transform nobody writes.
    this.logger.info('Request completed', {
      ...labels,
      status,
      durationMs,
      traceId: trace.traceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentSpanId,
      sampled: trace.sampled,
      correlationId: correlationIdOf(request),
      // The tenant, never the user: 17 §7 permits a tenant id on a log line and a personal
      // identifier is a different question, answered by the audit trail.
      tenantId: currentContext()?.tenantId ?? null,
    });
  }
}

/**
 * The route *template* Express matched, or `unmatched`.
 *
 * `Request['route']` is typed `any` by `@types/express`, so it is narrowed through an explicit
 * shape here rather than read off the request — a metrics label built from an `any` is exactly
 * where a document identifier would enter the series set unnoticed.
 */
interface RoutedRequest {
  readonly route?: { readonly path?: unknown };
}

function routeOf(request: Request): string {
  const { route } = request as unknown as RoutedRequest;
  return typeof route?.path === 'string' ? route.path : 'unmatched';
}

function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
}
