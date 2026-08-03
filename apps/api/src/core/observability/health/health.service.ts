import { Inject, Injectable } from '@nestjs/common';

import type { DependencyCheck, DependencyStatus, HealthReport } from '@edms/contracts';

import { APP_CONFIG, type AppConfig } from '../../config';
import { CACHE_PORT, type CachePort } from '../../../ports/cache.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { TenantDatabase } from '../../prisma/tenant-database';

/**
 * The dependency probes behind readiness.
 *
 * Each probe is bounded by its own timeout: a health endpoint that hangs because the
 * database is hanging tells an orchestrator nothing, and takes the whole deployment with it.
 * A check reports what it found and never why in operator-only detail — no connection
 * strings, no credentials.
 */
const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(TenantDatabase) private readonly databases: TenantDatabase,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
  ) {}

  async report(): Promise<HealthReport> {
    const dependencies = await Promise.all([
      ...(await this.databaseProbes()),
      this.probe('cache', async () => {
        await this.cache.get('health:probe');
      }),
    ]);

    return {
      status: worstOf(dependencies),
      version: this.config.app.version,
      checkedAt: this.clock.now().toISOString(),
      dependencies,
    };
  }

  /**
   * One probe per tenant database, named by slug.
   *
   * There is no single "the database" any more, and collapsing them into one check would answer the
   * question an orchestrator is actually asking — *can this instance serve traffic* — with "no"
   * whenever any one customer's database was unreachable. Reported separately, the aggregate is still
   * `DOWN`, and the detail says which tenant to look at.
   *
   * Bounded by `maxTenantClients`: a deployment with four hundred tenants must not open four hundred
   * pools to answer a readiness probe. Beyond the bound the check is honest about being a sample —
   * `databases (sampled 25 of 400)` — rather than quietly implying it covered everything.
   */
  private async databaseProbes(): Promise<readonly Promise<DependencyCheck>[]> {
    let placements: readonly { id: string; slug: string }[];
    try {
      placements = await this.databases.placements();
    } catch (error) {
      // A registry that cannot answer is a process that cannot serve anybody, and saying so is more
      // useful than reporting zero databases as healthy.
      return [
        Promise.resolve({
          name: 'tenant-registry',
          status: 'DOWN' as const,
          latencyMs: 0,
          detail: error instanceof Error ? error.name : 'unknown failure',
        }),
      ];
    }

    const limit = this.config.database.maxTenantClients;
    const sampled = placements.slice(0, limit);
    const suffix =
      placements.length > sampled.length
        ? ` (sampled ${String(sampled.length)} of ${String(placements.length)})`
        : '';

    return sampled.map((placement) =>
      this.probe(`database:${placement.slug}${suffix}`, () => this.databases.ping(placement.id)),
    );
  }

  private async probe(name: string, check: () => Promise<unknown>): Promise<DependencyCheck> {
    const startedAt = this.clock.timestamp();
    try {
      await withTimeout(check(), PROBE_TIMEOUT_MS);
      return { name, status: 'UP', latencyMs: this.clock.elapsedMs(startedAt) };
    } catch (error) {
      return {
        name,
        status: 'DOWN',
        latencyMs: this.clock.elapsedMs(startedAt),
        detail: error instanceof Error ? error.name : 'unknown failure',
      };
    }
  }
}

function worstOf(checks: readonly DependencyCheck[]): DependencyStatus {
  if (checks.some((check) => check.status === 'DOWN')) {
    return 'DOWN';
  }
  return checks.some((check) => check.status === 'DEGRADED') ? 'DEGRADED' : 'UP';
}

async function withTimeout<TResult>(work: Promise<TResult>, timeoutMs: number): Promise<TResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ProbeTimeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
