/**
 * Short-lived caching.
 *
 * Used for resolved permission decisions, configuration lookups and rate-limit counters. The
 * cache is an optimisation only: a cold cache must produce the same answer, never a
 * different one (`docs/architecture/08-permission-model.md` §8).
 */
export const CACHE_PORT = Symbol('CachePort');

export interface CachePort {
  get<TValue>(key: string): Promise<TValue | null>;
  set<TValue>(key: string, value: TValue, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Invalidation is by event — an ACL, role, delegation or membership change. */
  deleteByPrefix(prefix: string): Promise<number>;
  increment(key: string, ttlSeconds: number): Promise<number>;
}

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
