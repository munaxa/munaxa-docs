import type { RateLimitRule, RateLimitTarget } from '@munaxa/security';

/**
 * Rate limits, per surface rather than one global number.
 *
 * Login and presign are attacked in completely different ways from a document list, and a
 * single limit generous enough for browsing is useless against credential stuffing
 * (`docs/architecture/15-api-architecture.md` §7).
 *
 * Every limited response carries `Retry-After`; every login limit is enforced per IP *and*
 * per account, so distributing an attack across addresses does not lift it.
 *
 * ## What Phase 5 changed
 *
 * These numbers are Phase 0.5's, unchanged. What changed is that **something reads them**. Until
 * this phase `RATE_LIMIT_RULES` and `ruleFor` had no call site anywhere in the codebase and
 * `@nestjs/throttler` was a dependency nothing imported: the limits above were a description of
 * an intent, not a control. `RateLimitGuard` enforces them now, through `@munaxa/security`'s
 * `RateLimiter` over the Redis `CachePort` — so a limit is a limit across every replica, rather
 * than per process multiplied by however many are running.
 *
 * ## Why each rule appears once per dimension
 *
 * The platform evaluates every applicable rule and the first denial wins, so "per IP *and* per
 * account" is two rules with the same `match` and different dimensions rather than one rule with
 * a list. That is also what makes the anonymous case correct: a rule whose dimension is absent
 * from the request does not apply, so the per-user login rule simply does not fire on a request
 * with no session, and the per-IP one carries it.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const isPost = (target: RateLimitTarget, suffix: string): boolean =>
  target.method === 'POST' && target.path.endsWith(suffix);

export const RATE_LIMIT_RULES: readonly RateLimitRule[] = Object.freeze([
  // Authentication. Tighter than everything else by an order of magnitude, and adaptive: repeated
  // violations lengthen the penalty window, because credential stuffing looks exactly like a lot
  // of failed logins from a few addresses.
  {
    id: 'auth.login.ip',
    match: (target) => isPost(target, '/auth/login'),
    dimension: 'ip',
    limit: 10,
    window: 5 * MINUTE,
    adaptiveFactor: 2,
  },
  {
    id: 'auth.login.user',
    match: (target) => isPost(target, '/auth/login'),
    dimension: 'user',
    limit: 10,
    window: 5 * MINUTE,
    adaptiveFactor: 2,
  },
  {
    id: 'auth.password-reset.ip',
    match: (target) => target.path.includes('/auth/password'),
    dimension: 'ip',
    limit: 5,
    window: HOUR,
    adaptiveFactor: 2,
  },
  {
    id: 'auth.password-reset.user',
    match: (target) => target.path.includes('/auth/password'),
    dimension: 'user',
    limit: 5,
    window: HOUR,
  },
  // The second factor. Per session rather than per user: the session is what a code is being
  // guessed against, and a six-digit code has a million possibilities that ten attempts per
  // fifteen minutes does not meaningfully explore.
  {
    id: 'auth.mfa.session',
    match: (target) => target.path.includes('/mfa/'),
    dimension: 'session',
    limit: 10,
    window: 15 * MINUTE,
  },

  // Expensive surfaces. A presign mints a credential; an export reads the whole trail.
  {
    id: 'search.user',
    match: (target) => target.path.includes('/search'),
    dimension: 'user',
    limit: 60,
    window: MINUTE,
  },
  {
    id: 'upload.presign.user',
    match: (target) => target.path.includes('/uploads'),
    dimension: 'user',
    limit: 120,
    window: MINUTE,
  },
  {
    id: 'upload.presign.tenant',
    match: (target) => target.path.includes('/uploads'),
    dimension: 'tenant',
    limit: 600,
    window: MINUTE,
  },
  {
    id: 'export.user',
    match: (target) => target.path.includes('/exports'),
    dimension: 'user',
    limit: 10,
    window: HOUR,
  },
  {
    id: 'export.tenant',
    match: (target) => target.path.includes('/exports'),
    dimension: 'tenant',
    limit: 50,
    window: HOUR,
  },

  // The floor, applied to everything. The per-IP rule is what stands between an unauthenticated
  // flood and the database; the per-user one is generous because a busy screen makes many calls.
  { id: 'default.user', dimension: 'user', limit: 300, window: MINUTE },
  { id: 'default.ip', dimension: 'ip', limit: 300, window: MINUTE },
]);
