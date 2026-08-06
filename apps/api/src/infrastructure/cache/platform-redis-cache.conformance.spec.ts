import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { runCacheConformance } from '@munaxa/conformance';

import { PlatformRedisCacheAdapter } from './platform-redis-cache.adapter';

/**
 * The platform's conformance suite, run against this product's Redis adapter.
 *
 * This is the step the platform's adapter guide calls the one that matters: it distinguishes a
 * `setIfAbsent` that is a real compare-and-swap from one that is a hopeful `SET`. The properties
 * under test are properties of Redis, so a mock cannot fail the way the real server can and is
 * not used.
 *
 * Skipped rather than failed when there is no Redis to talk to, so a laptop without the compose
 * stack still gets a useful `pnpm test`. CI runs the stack, so CI runs these.
 */
const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/**
 * Whether Redis answered, decided once and awaited inside each suite rather than at module
 * scope: this app compiles to CommonJS, where a top-level `await` is a compile error.
 */
let reachable: boolean | undefined;

async function redisAvailable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  reachable = await probe
    .connect()
    .then(() => true)
    .catch(() => false);
  if (reachable) await probe.quit();
  else probe.disconnect();
  return reachable;
}

// A fresh keyspace per adapter, so one test's keys cannot answer another's questions.
const adapters: PlatformRedisCacheAdapter[] = [];
const config = { redis: { url } } as never;

runCacheConformance(
  { describe, it, expect },
  {
    createCache: async () => {
      if (!(await redisAvailable())) {
        // Reported rather than silently green: a suite that quietly tests nothing is worse than
        // one that fails, because it is indistinguishable from one that passed.
        throw new Error(
          `No Redis at ${url}. Start the compose stack, or set REDIS_URL, to run adapter conformance.`,
        );
      }
      const prefixed = new Redis(url, { keyPrefix: `conformance:${randomUUID()}:` });
      const adapter = new PlatformRedisCacheAdapter(config, prefixed);
      adapters.push(adapter);
      return adapter;
    },
    // No `advance`: this is a real server with real TTLs, so the expiry tests skip themselves
    // rather than pretending a fake clock moved Redis's.
    concurrency: 100,
  },
);

afterAll(async () => {
  await Promise.all(adapters.map((adapter) => adapter.onModuleDestroy()));
});
