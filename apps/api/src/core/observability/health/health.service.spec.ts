import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../../config';
import type { AntivirusPort } from '../../../ports/antivirus.port';
import type { CachePort } from '../../../ports/cache.port';
import type { TenantDatabase } from '../../prisma/tenant-database';
import type { Logger } from '../logger';
import { HealthService } from './health.service';

/**
 * The readiness report names no tenant — R-11 of the Hetzner readiness report.
 *
 * `/api/health` and `/api/health/ready` are public routes (a load balancer holds no credentials),
 * kept off the internet only by the proxy. They used to name each tenant database by slug, so that
 * one routing rule was all that kept the customer list private. Probes are now named by catalogue
 * position, and the slug of a failing one goes to the API's own log.
 */
const TENANTS = [
  { id: '0199f5a1-5a9e-7000-8000-0000000000a1', slug: 'acme-industries' },
  { id: '0199f5a1-5a9e-7000-8000-0000000000b2', slug: 'rival-holdings' },
];

function serviceWith(down: ReadonlySet<string>, maxTenantClients = 25) {
  const warnings: { message: string; context: Readonly<Record<string, unknown>> | undefined }[] =
    [];
  const service = new HealthService(
    {
      database: { maxTenantClients },
      providers: { antivirus: 'NONE' },
      app: { version: '1.0.0' },
    } as unknown as AppConfig,
    {
      now: () => new Date('2026-10-15T00:00:00Z'),
      timestamp: () => 0,
      elapsedMs: () => 1,
    },
    {
      placements: () => Promise.resolve(TENANTS),
      ping: (id: string) =>
        down.has(id) ? Promise.reject(new Error('connection refused')) : Promise.resolve(),
    } as unknown as TenantDatabase,
    { get: () => Promise.resolve(null) } as unknown as CachePort,
    {} as AntivirusPort,
    {
      warn: (message: string, context?: Readonly<Record<string, unknown>>) =>
        warnings.push({ message, context }),
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as Logger,
  );
  return { service, warnings };
}

describe('the readiness report', () => {
  it('names each tenant database by catalogue position, and no tenant anywhere in the body', async () => {
    const { service, warnings } = serviceWith(new Set());

    const report = await service.report();

    expect(report.dependencies.map((dependency) => dependency.name)).toEqual([
      'database:1',
      'database:2',
      'cache',
    ]);
    const body = JSON.stringify(report);
    for (const tenant of TENANTS) {
      expect(body).not.toContain(tenant.slug);
      expect(body).not.toContain(tenant.id);
    }
    expect(warnings).toEqual([]);
  });

  it('reports a down database by position, and logs which tenant it is', async () => {
    const { service, warnings } = serviceWith(new Set([TENANTS[1]?.id ?? '']));

    const report = await service.report();

    expect(report.status).toBe('DOWN');
    expect(report.dependencies.find((dependency) => dependency.status === 'DOWN')?.name).toBe(
      'database:2',
    );
    expect(JSON.stringify(report)).not.toContain('rival-holdings');
    expect(warnings).toEqual([
      {
        message: 'A tenant database failed its health probe',
        context: { probe: 'database:2', tenant: 'rival-holdings', detail: 'Error' },
      },
    ]);
  });

  it('still says when it sampled, without names', async () => {
    const { service } = serviceWith(new Set(), 1);

    const report = await service.report();

    expect(report.dependencies[0]?.name).toBe('database:1 (sampled 1 of 2)');
  });
});
