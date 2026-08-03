import { API_PREFIX, Header, type ProblemDetails, problemDetailsSchema } from '@edms/contracts';
import { DomainError, ErrorCode } from '@edms/domain';
import { correlationId } from '@edms/utils';

/**
 * The typed client every screen calls.
 *
 * It does three things the caller should never repeat: it attaches the bearer token and a
 * correlation id, it turns an RFC 7807 body into a `DomainError` so a component branches on
 * a code rather than a status number, and it refuses to swallow a failure silently.
 */
export interface ApiRequest {
  readonly path: string;
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly accessToken?: string;
  readonly locale?: string;
  /** Set on every mutating call the user could retry — the API replays rather than repeats. */
  readonly idempotencyKey?: string;
  /** The aggregate version being changed; a mismatch is a 409, never a silent overwrite. */
  readonly ifMatch?: number;
  readonly signal?: AbortSignal;
}

export function apiBaseUrl(): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  return `${base.replace(/\/$/, '')}/${API_PREFIX}`;
}

export async function apiFetch<TResult>(request: ApiRequest): Promise<TResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [Header.CORRELATION_ID]: correlationId(),
  };
  if (request.accessToken) {
    headers.Authorization = `Bearer ${request.accessToken}`;
  }
  if (request.locale) {
    headers['Accept-Language'] = request.locale;
  }
  if (request.idempotencyKey) {
    headers[Header.IDEMPOTENCY_KEY] = request.idempotencyKey;
  }
  if (request.ifMatch !== undefined) {
    headers[Header.IF_MATCH] = String(request.ifMatch);
  }

  const init: RequestInit = {
    method: request.method ?? 'GET',
    headers,
    credentials: 'include',
  };
  if (request.body !== undefined) {
    init.body = JSON.stringify(request.body);
  }
  if (request.signal) {
    init.signal = request.signal;
  }

  const response = await fetch(`${apiBaseUrl()}${request.path}`, init);

  if (response.status === 204) {
    return undefined as TResult;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw toDomainError(payload, response.status);
  }
  return payload as TResult;
}

function toDomainError(payload: unknown, status: number): DomainError {
  const parsed = problemDetailsSchema.safeParse(payload);
  if (parsed.success) {
    const problem: ProblemDetails = parsed.data;
    return new DomainError(problem.code, problem.detail, { correlationId: problem.correlationId });
  }
  // An unparseable body means something between here and the API answered — a proxy, a
  // gateway, a captive portal. Reporting it as INTERNAL is honest; guessing is not.
  return new DomainError(ErrorCode.INTERNAL, 'The server returned an unexpected response.', {
    status,
  });
}
