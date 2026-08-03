import { Inject, Injectable } from '@nestjs/common';

import type { DependencyCheck, DependencyStatus, HealthReport } from '@edms/contracts';

import { APP_CONFIG, type AppConfig } from '../../config';
import { CACHE_PORT, type CachePort } from '../../../ports/cache.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { PrismaService } from '../../prisma/prisma.service';

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
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
  ) {}

  async report(): Promise<HealthReport> {
    const dependencies = await Promise.all([
      this.probe('database', () => this.prisma.ping()),
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
