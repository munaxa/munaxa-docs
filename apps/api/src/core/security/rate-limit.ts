/**
 * Rate limits, per surface rather than one global number.
 *
 * Login and presign are attacked in completely different ways from a document list, and a
 * single limit generous enough for browsing is useless against credential stuffing
 * (`docs/architecture/15-api-architecture.md` §7).
 *
 * Every limited response carries `Retry-After`; every login limit is enforced per IP *and*
 * per account, so distributing an attack across addresses does not lift it.
 */
export interface RateLimitRule {
  readonly name: string;
  readonly windowSeconds: number;
  readonly limit: number;
  readonly by: readonly ('ip' | 'identity' | 'tenant')[];
}

export const RATE_LIMIT_RULES: readonly RateLimitRule[] = Object.freeze([
  { name: 'auth.login', windowSeconds: 300, limit: 10, by: ['ip', 'identity'] },
  { name: 'auth.password-reset', windowSeconds: 3_600, limit: 5, by: ['ip', 'identity'] },
  { name: 'search', windowSeconds: 60, limit: 60, by: ['identity'] },
  { name: 'upload.presign', windowSeconds: 60, limit: 120, by: ['identity', 'tenant'] },
  { name: 'export', windowSeconds: 3_600, limit: 10, by: ['identity', 'tenant'] },
  /**
   * The signing ceremony — Phase 6.7B, and the one rule added rather than inherited.
   *
   * `POST /documents/:id/signatures` accepts a password and a TOTP code and answers one
   * deliberately-undifferentiated refusal (ADR-0017 §6). That uniformity stops a session thief
   * learning which half of the credentials they still need, and it is only a defence if the guesses
   * are bounded — which nothing bounded until this rule existed. Five attempts in fifteen minutes
   * is tight enough that guessing is infeasible and loose enough that a signer who mistypes twice
   * is not shut out of a compliance act.
   *
   * Keyed by tenant and identity here; the guard appends the revision and purpose from the request,
   * so one fumbled signature does not consume the budget for a different attestation. None of the
   * credential material ever reaches the key.
   */
  { name: 'document.sign', windowSeconds: 900, limit: 5, by: ['tenant', 'identity'] },
  { name: 'default', windowSeconds: 60, limit: 300, by: ['identity'] },
]);

/**
 * Which rule a request falls under — the route table the guard reads.
 *
 * A prefix match on the versioned path, longest first, so `POST /v1/documents/:id/signatures`
 * selects `document.sign` rather than `default`. Declared beside the rules because a rule and the
 * surface it governs are one decision, and the pair being in two files is how `auth.password-reset`
 * came to name a route that does not exist.
 *
 * `credentialSensitive` is what decides the Redis-failure policy: a route where accepting
 * credentials *is* the security decision must refuse rather than silently become unlimited, and
 * everything else keeps the availability it has today.
 */
export interface RouteRule {
  readonly method: string;
  /** Matched against the path with `/v1` stripped, `:id` segments already normalised. */
  readonly pattern: RegExp;
  readonly rule: string;
  readonly credentialSensitive: boolean;
}

export const ROUTE_RULES: readonly RouteRule[] = Object.freeze([
  { method: 'POST', pattern: /^\/auth\/login$/, rule: 'auth.login', credentialSensitive: true },
  {
    method: 'POST',
    pattern: /^\/documents\/[^/]+\/signatures$/,
    rule: 'document.sign',
    credentialSensitive: true,
  },
  { method: 'GET', pattern: /^\/search$/, rule: 'search', credentialSensitive: false },
  { method: 'POST', pattern: /^\/uploads$/, rule: 'upload.presign', credentialSensitive: false },
  {
    method: 'GET',
    pattern: /^\/audit\/export$/,
    rule: 'export',
    credentialSensitive: false,
  },
  {
    method: 'POST',
    pattern: /^\/reporting\/[^/]+\/run$/,
    rule: 'export',
    credentialSensitive: false,
  },
]);

/** The rule governing one request, or `default` when no route rule matches. */
export function ruleForRequest(method: string, path: string): RouteRule {
  // The global prefix and the version both come off. `configureApp` mounts everything under
  // `/api` and adds URI versioning, so a real request arrives as `/api/v1/auth/login` — stripping
  // only the version would leave `/api/auth/login`, which matches no pattern in the table and
  // would make every rule silently inert. Found by the HTTP test, not by reading the code.
  const normalised = path
    .replace(/^\/api/, '')
    .replace(/^\/v\d+/, '')
    .replace(/\/$/, '');
  return (
    ROUTE_RULES.find(
      (entry) => entry.method === method.toUpperCase() && entry.pattern.test(normalised),
    ) ?? { method, pattern: /.*/, rule: 'default', credentialSensitive: false }
  );
}

export function ruleFor(name: string): RateLimitRule {
  return (
    RATE_LIMIT_RULES.find((rule) => rule.name === name) ??
    RATE_LIMIT_RULES[RATE_LIMIT_RULES.length - 1]!
  );
}
