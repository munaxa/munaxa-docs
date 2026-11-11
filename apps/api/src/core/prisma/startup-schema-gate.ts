import type { INestApplicationContext } from '@nestjs/common';

import { LOGGER, type Logger } from '../observability/logger';
import { expectedMigrations, SchemaNotReadyError } from './schema-readiness';
import { TenantDatabase } from './tenant-database';

/**
 * The API does not start against a database the migration has not finished (DC-01).
 *
 * Run by `main.ts` before the process listens, so on ECS a task started against an unmigrated or
 * half-migrated database exits non-zero before its first health check, never becomes healthy, and
 * the deployment's circuit breaker keeps the previous revision serving. The log line names the
 * tenant and what is missing — never a connection string — which is how an operator tells "the
 * migration did not run" (this) from "the application is broken" (any later failure).
 *
 * - **Reachable and not ready** (no history, a pending or failed migration, or the post-migration
 *   row-level security missing): refused, always.
 * - **Ahead of this build** (migrations it does not know): allowed and logged — the rollback shape of
 *   docs/operations/deployment.md §6.
 * - **Unreachable**: refused when the deployment serves one tenant, because then "cannot check" is
 *   "cannot serve" anyway; logged and skipped when it serves several, so one customer's database
 *   outage does not stop everybody else's service (tenant-database.ts connects lazily for the same
 *   reason). That tenant's requests fail until its database answers.
 */
export async function assertSchemasReady(app: INestApplicationContext): Promise<void> {
  const databases = app.get(TenantDatabase);
  const logger = app.get<Logger>(LOGGER);
  const expected = expectedMigrations();
  const placements = await databases.placements();
  const refusals: SchemaNotReadyError[] = [];
  const unreachable: string[] = [];

  for (const placement of placements) {
    let readiness;
    try {
      readiness = await databases.schemaReadiness(placement.id, expected);
    } catch (error) {
      unreachable.push(placement.slug);
      logger.warn('Tenant database schema could not be checked at start-up', {
        tenantSlug: placement.slug,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      continue;
    }
    if (!readiness.ready) {
      refusals.push(new SchemaNotReadyError(placement.slug, readiness));
      continue;
    }
    if (readiness.unknown.length > 0) {
      logger.warn('Tenant database is ahead of this build (expand-only rollback)', {
        tenantSlug: placement.slug,
        unknownMigrations: readiness.unknown.length,
      });
    }
  }

  for (const refusal of refusals) {
    logger.error('Tenant database is not migrated for this build; refusing to start', {
      tenantSlug: refusal.tenantSlug,
      applied: refusal.readiness.applied,
      expected: refusal.readiness.expected,
      problems: refusal.readiness.problems.join('; '),
    });
  }
  const [refused] = refusals;
  if (refused !== undefined) {
    throw refused;
  }
  if (placements.length === 1 && unreachable.length === 1) {
    throw new Error(
      `The database of '${unreachable[0] ?? ''}' could not be reached to check its schema; refusing to start.`,
    );
  }
}
