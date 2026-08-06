import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { CachePort as PlatformCachePort, CacheSetOptions } from '@munaxa/interfaces';

import { APP_CONFIG, type AppConfig } from '../../core/config';

/**
 * The platform's `CachePort`, over Redis.
 *
 * Munaxa Docs already had a Redis cache, but it exposed only `get`/`set`/`delete`/`increment`.
 * The platform needs two operations that one did not have, and they are the two that carry
 * security properties rather than performance ones:
 *
 * - **`setIfAbsent`** — `SET key value NX PX ttl`. Exactly one caller across the whole fleet may
 *   be told `true`. Every at-most-once guarantee in the platform reduces to it: TOTP step
 *   consumption, one-time-code redemption, notification deduplication, distributed locks. A
 *   `has()` followed by a `set()` is not an implementation of it — it passes every sequential
 *   test and fails the moment two requests arrive together.
 * - **`compareAndSet`** — a Lua script, because `WATCH`/`MULTI` cannot be expressed on a single
 *   `ioredis` connection that is also serving other callers. Without it `TokenBucket` degrades to
 *   `best-effort` and over-admits under concurrency.
 *
 * `increment` keeps the existing semantics deliberately: `EXPIRE … NX` sets the window only when
 * the key is new, so a counter's window does not slide on every hit. A sliding window is a rate
 * limit that a steady stream of requests keeps alive forever.
 *
 * Proven by `@munaxa/conformance`'s `runCacheConformance` against a real Redis in
 * `platform-redis-cache.conformance.spec.ts`. A mock cannot fail the way Redis can, so it is not
 * used here.
 */
const SCAN_BATCH = 500;

/**
 * Replace `key` only if it still holds `expected`. `ARGV[3]` distinguishes "expected absent"
 * from "expected this value", which is what lets the platform use `undefined` to mean
 * "only if absent".
 */
const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if ARGV[3] == 'absent' then
  if current then return 0 end
elseif current ~= ARGV[2] then
  return 0
end
if tonumber(ARGV[4]) > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[4]))
else
  redis.call('SET', KEYS[1], ARGV[1])
end
return 1
`;

@Injectable()
export class PlatformRedisCacheAdapter implements PlatformCachePort, OnModuleDestroy {
  private readonly client: Redis;
  private readonly owned: boolean;

  /**
   * `client` is `@Optional()` because Nest would otherwise try to resolve `Redis` as a provider
   * and fail to construct the module — it reads the second constructor parameter as a dependency
   * regardless of the `?`. It exists only so a test can supply a key-prefixed client; in the
   * application the adapter always builds its own from configuration.
   */
  constructor(@Inject(APP_CONFIG) config: AppConfig, @Optional() client?: Redis) {
    this.client = client ?? new Redis(config.redis.url, { maxRetriesPerRequest: 3 });
    this.owned = client === undefined;
  }

  async get<TValue>(key: string): Promise<TValue | undefined> {
    const raw = await this.client.get(key);
    // `undefined` rather than `null`: the platform distinguishes a stored null from a miss.
    return raw === null ? undefined : (JSON.parse(raw) as TValue);
  }

  async set<TValue>(key: string, value: TValue, options: CacheSetOptions = {}): Promise<void> {
    const encoded = JSON.stringify(value);
    if (options.ttl === undefined) {
      await this.client.set(key, encoded);
      return;
    }
    if (options.keepTtl === true) {
      await this.client.set(key, encoded, 'KEEPTTL');
      return;
    }
    await this.client.set(key, encoded, 'PX', Math.max(1, Math.ceil(options.ttl)));
  }

  async setIfAbsent<TValue>(
    key: string,
    value: TValue,
    options: CacheSetOptions = {},
  ): Promise<boolean> {
    const encoded = JSON.stringify(value);
    const result =
      options.ttl === undefined
        ? await this.client.set(key, encoded, 'NX')
        : await this.client.set(key, encoded, 'PX', Math.max(1, Math.ceil(options.ttl)), 'NX');
    // Redis answers 'OK' when it set the key and nil when it did not. That is the whole
    // compare-and-swap, decided by the server rather than by this process.
    return result === 'OK';
  }

  async compareAndSet<TValue>(
    key: string,
    expected: TValue | undefined,
    next: TValue,
    options: CacheSetOptions = {},
  ): Promise<boolean> {
    const result = await this.client.eval(
      COMPARE_AND_SET,
      1,
      key,
      JSON.stringify(next),
      expected === undefined ? '' : JSON.stringify(expected),
      expected === undefined ? 'absent' : 'value',
      String(options.ttl === undefined ? 0 : Math.max(1, Math.ceil(options.ttl))),
    );
    return result === 1;
  }

  async delete(key: string): Promise<boolean> {
    return (await this.client.del(key)) > 0;
  }

  async has(key: string): Promise<boolean> {
    return (await this.client.exists(key)) > 0;
  }

  async increment(key: string, by = 1, options: CacheSetOptions = {}): Promise<number> {
    const pipeline = this.client.multi().incrby(key, by);
    if (options.ttl !== undefined && options.keepTtl !== false) {
      // `NX` is the important flag: set the window when the key is created and never again, or
      // a counter's window slides on every hit and the limit never resets.
      pipeline.expire(key, Math.max(1, Math.ceil(options.ttl / 1_000)), 'NX');
    } else if (options.ttl !== undefined) {
      pipeline.expire(key, Math.max(1, Math.ceil(options.ttl / 1_000)));
    }
    const results = await pipeline.exec();
    return Number(results?.[0]?.[1] ?? 0);
  }

  async ttl(key: string): Promise<number | undefined> {
    const remaining = await this.client.pttl(key);
    // -2 is "no such key", -1 is "no expiry"; the platform reports both as undefined.
    return remaining < 0 ? undefined : remaining;
  }

  /**
   * Drop every key under a namespace, by SCAN rather than `KEYS`.
   *
   * `KEYS` blocks the whole server on a large keyspace, and the permission cache is invalidated
   * by prefix on every ACL change — so this runs on a path that is neither rare nor quiet.
   */
  async clear(namespace?: string): Promise<void> {
    // `SCAN` is one of the few commands ioredis does not apply `keyPrefix` to — the pattern goes
    // to the server verbatim and the keys come back fully qualified — while `del` *does* apply it.
    // Passing scanned keys straight to `del` therefore prefixes them twice and deletes nothing,
    // which is a cache that silently never invalidates. Prefix the pattern, strip the results.
    const prefix = this.client.options.keyPrefix ?? '';
    const pattern = namespace === undefined ? `${prefix}*` : `${prefix}${namespace}:*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_BATCH);
      cursor = next;
      if (keys.length > 0) {
        await this.client.del(...keys.map((key) => key.slice(prefix.length)));
      }
    } while (cursor !== '0');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.client.quit();
  }
}
