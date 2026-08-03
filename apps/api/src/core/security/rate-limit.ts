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
  { name: 'default', windowSeconds: 60, limit: 300, by: ['identity'] },
]);

export function ruleFor(name: string): RateLimitRule {
  return (
    RATE_LIMIT_RULES.find((rule) => rule.name === name) ??
    RATE_LIMIT_RULES[RATE_LIMIT_RULES.length - 1]!
  );
}
