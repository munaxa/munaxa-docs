import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../../core/config';
import type { CachePort } from '../../ports/cache.port';

/**
 * Redis-backed cache.
 *
 * Two decisions worth stating: every entry is written with a TTL, because a cache without
 * expiry is a second database with no migrations; and `deleteByPrefix` scans in batches
 * rather than issuing `KEYS`, which blocks the whole server on a large keyspace — and the
 * permission cache is invalidated by prefix on every ACL change.
 */
const SCAN_BATCH = 500;

@Injectable()
export class RedisCacheAdapter implements CachePort, OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.redis.url, { maxRetriesPerRequest: 3, lazyConnect: false });
  }

  async get<TValue>(key: string): Promise<TValue | null> {
    const raw = await this.client.get(key);
    return raw === null ? null : (JSON.parse(raw) as TValue);
  }

  async set<TValue>(key: string, value: TValue, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.client.scan(
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        SCAN_BATCH,
      );
      cursor = next;
      if (keys.length > 0) {
        removed += await this.client.del(...keys);
      }
    } while (cursor !== '0');
    return removed;
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const [count] = await this.client
      .multi()
      .incr(key)
      .expire(key, ttlSeconds, 'NX')
      .exec()
      .then((results) => (results ?? []).map(([, value]) => value as number));
    return count ?? 0;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
