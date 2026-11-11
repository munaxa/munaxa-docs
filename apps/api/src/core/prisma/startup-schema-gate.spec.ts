import type { INestApplicationContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { LOGGER } from '../observability/logger';
import type { SchemaReadiness } from './schema-readiness';
import { assertSchemasReady } from './startup-schema-gate';
import { TenantDatabase } from './tenant-database';

/** DC-01: the API never listens against a database the migration has not finished. */

const READY: SchemaReadiness = { ready: true, problems: [], expected: 2, applied: 2, unknown: [] };
const EMPTY: SchemaReadiness = {
  ready: false,
  problems: [
    'the database has no readable migration history (_prisma_migrations): it is not migrated',
  ],
  expected: 2,
  applied: 0,
  unknown: [],
};

function context(answers: Record<string, SchemaReadiness | Error>) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const databases = {
    placements: () =>
      Promise.resolve(Object.keys(answers).map((slug) => ({ id: `id-${slug}`, slug }))),
    schemaReadiness: (id: string) => {
      const answer = answers[id.slice(3)];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  const app = {
    get: (token: unknown) =>
      token === TenantDatabase ? databases : token === LOGGER ? logger : undefined,
  } as unknown as INestApplicationContext;
  return { app, logger };
}

describe('assertSchemasReady', () => {
  it('lets a migrated deployment start', async () => {
    const { app } = context({ acme: READY });
    await expect(assertSchemasReady(app)).resolves.toBeUndefined();
  });

  it('refuses when any reachable tenant database is not migrated, and says which', async () => {
    const { app, logger } = context({ acme: READY, rival: EMPTY });
    await expect(assertSchemasReady(app)).rejects.toThrow(/'rival' is not migrated for this build/);
    expect(logger.error).toHaveBeenCalledWith(
      'Tenant database is not migrated for this build; refusing to start',
      expect.objectContaining({ tenantSlug: 'rival', applied: 0, expected: 2 }),
    );
  });

  it('allows a database ahead of this build and logs it', async () => {
    const { app, logger } = context({ acme: { ...READY, unknown: ['20990101000000_future'] } });
    await expect(assertSchemasReady(app)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Tenant database is ahead of this build (expand-only rollback)',
      expect.objectContaining({ tenantSlug: 'acme', unknownMigrations: 1 }),
    );
  });

  it('refuses a single-tenant deployment whose database cannot be checked', async () => {
    const { app } = context({ acme: new Error('ECONNREFUSED') });
    await expect(assertSchemasReady(app)).rejects.toThrow(/could not be reached/);
  });

  it('does not let one unreachable tenant stop a multi-tenant deployment', async () => {
    const { app, logger } = context({ acme: READY, rival: new Error('ECONNREFUSED') });
    await expect(assertSchemasReady(app)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Tenant database schema could not be checked at start-up',
      expect.objectContaining({ tenantSlug: 'rival', reason: 'Error' }),
    );
  });
});
