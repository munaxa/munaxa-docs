/**
 * Who owns an `Idempotency-Key`, and what it answered — RC validation, D-20.
 *
 * The interceptor asks one question before a request runs — "may I?" — and gets one of three
 * answers. The store's job is to make that answer atomic across every process serving the tenant:
 * two requests asking at once must not both be told `OWNER`.
 */
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

/** A request, as the idempotency record identifies it: one row per distinct request. */
export interface IdempotentRequest {
  readonly tenantId: string;
  readonly key: string;
  readonly method: string;
  readonly path: string;
  /** SHA-256 of the parsed body. The same key with another body is another request (Slice 56). */
  readonly bodyHash: string;
}

export type IdempotencyClaim =
  /** This request holds the key. `token` proves it when completing or releasing. */
  | { readonly kind: 'OWNER'; readonly token: string }
  /** The same request already completed; this is its answer. */
  | { readonly kind: 'REPLAY'; readonly statusCode: number; readonly body: unknown }
  /** The same request is being performed by its owner right now. */
  | { readonly kind: 'IN_PROGRESS' };

export interface IdempotencyStore {
  claim(request: IdempotentRequest): Promise<IdempotencyClaim>;
  /** Stores the owner's answer. A token that no longer owns the claim changes nothing. */
  complete(
    request: IdempotentRequest,
    token: string,
    statusCode: number,
    body: unknown,
  ): Promise<void>;
  /** Gives the key back after a failure, so a retry performs the request again. */
  release(request: IdempotentRequest, token: string): Promise<void>;
}
