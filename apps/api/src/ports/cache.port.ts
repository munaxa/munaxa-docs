/**
 * Short-lived caching.
 *
 * Used for resolved permission decisions, configuration lookups and rate-limit counters. The
 * cache is an optimisation only: a cold cache must produce the same answer, never a
 * different one (`docs/architecture/08-permission-model.md` §8).
 *
 * The interface is the platform's, not this product's. Munaxa Docs used to declare its own
 * near-identical `CachePort`, which meant two abstractions over the same Redis and — more to the
 * point — the local one lacked `setIfAbsent` and `compareAndSet`. Those are not conveniences:
 * every at-most-once guarantee in the platform reduces to them, so a product on the narrower
 * interface cannot wire MFA replay protection, one-time codes or notification deduplication at
 * all. Re-exported rather than re-declared so the DI token keeps its name and the compiler
 * enforces the platform's contract.
 *
 * Note the units: the platform takes `{ ttl }` in **milliseconds**, where the retired local port
 * took seconds positionally.
 */
export type { CachePort } from '@munaxa/interfaces';

export const CACHE_PORT = Symbol('CachePort');

export const LOCK_PORT = Symbol('LockPort');

export interface Lease {
  readonly key: string;
  readonly token: string;
  readonly expiresAt: Date;
  release(): Promise<void>;
}

/**
 * A distributed mutex for work that must not run twice across processes — a retention run,
 * an index rebuild. Aggregate-level contention uses the database (`version`, row locks),
 * not this.
 */
export interface LockPort {
  acquire(key: string, ttlSeconds: number): Promise<Lease | null>;
}
