import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, map } from 'rxjs';

/**
 * Serialisation rules that hold for every response.
 *
 * `Date` becomes an ISO-8601 UTC string, `bigint` becomes a decimal string (sizes are bytes
 * and can exceed `Number.MAX_SAFE_INTEGER`; `JSON.stringify` would otherwise throw), and
 * `undefined` is dropped so it is never rendered as `null`. Collections are already shaped
 * by the query service — this interceptor does not invent an envelope, because single
 * resources are returned bare (`docs/architecture/15-api-architecture.md` §3).
 */
@Injectable()
export class SerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value) => normalize(value)));
  }
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) {
        result[key] = normalize(entry);
      }
    }
    return result;
  }
  return value;
}
