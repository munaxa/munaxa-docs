import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@edms/utils';

import { checkSchemaReadiness, expectedMigrations } from './schema-readiness';

/**
 * DC-01: the schema gate asked of real databases, as the roles that ask it in production.
 *
 * - The suite's migrated tenant database, as the application role (`edms_app`), the way provisioning
 *   and API start-up ask: ready, with every migration in prisma/migrations applied.
 * - A database made here and left unmigrated, then given a failed migration row and an unprotected
 *   tenant table: each refused for its own reason. Made and dropped by the owner role, so nothing the
 *   rest of the suite uses is touched.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';
const scratch = `schema_gate_${uuidv7().replaceAll('-', '').slice(-12)}`;

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

const admin = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
const app = new PrismaClient({ datasources: { db: { url: APP_URL } } });
let fresh: PrismaClient;

beforeAll(async () => {
  await admin.$executeRawUnsafe(`CREATE DATABASE ${scratch}`);
  fresh = new PrismaClient({ datasources: { db: { url: urlFor(OWNER_URL, scratch) } } });
});

afterAll(async () => {
  await fresh.$disconnect();
  await app.$disconnect();
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  await admin.$disconnect();
});

describe('schema readiness against PostgreSQL', () => {
  it('passes the migrated tenant database, read as the application role', async () => {
    const expected = expectedMigrations();
    const result = await checkSchemaReadiness(app, expected);
    expect(result.problems).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.applied).toBeGreaterThanOrEqual(expected.length);
    expect(result.unknown).toEqual([]);
  });

  it('refuses an empty database: no migration history', async () => {
    const result = await checkSchemaReadiness(fresh);
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual([
      'the database has no readable migration history (_prisma_migrations): it is not migrated',
    ]);
  });

  it('refuses a failed migration and a tenant table without row-level security', async () => {
    const [first, second] = expectedMigrations();
    // Prisma's own table, in Prisma's own shape, with the first migration finished and the second
    // recorded as started and never finished: what P3018 leaves behind.
    await fresh.$executeRawUnsafe(`
      CREATE TABLE _prisma_migrations (
        id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
        migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
        started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`);
    await fresh.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
       VALUES ('a', 'x', now(), $1, 1), ('b', 'y', NULL, $2, 0)`,
      first,
      second,
    );
    await fresh.$executeRawUnsafe('CREATE TABLE gate_probe (id int, tenant_id uuid)');

    const result = await checkSchemaReadiness(fresh);
    expect(result.ready).toBe(false);
    expect(result.applied).toBe(1);
    expect(result.problems[0]).toBe(`migration(s) failed or still running: ${second ?? ''}`);
    expect(result.problems.at(-1)).toMatch(/without forced row-level security.*gate_probe/);

    // Forcing row-level security and adding the policy is what the post-migration SQL does.
    await fresh.$executeRawUnsafe('ALTER TABLE gate_probe ENABLE ROW LEVEL SECURITY');
    await fresh.$executeRawUnsafe('ALTER TABLE gate_probe FORCE ROW LEVEL SECURITY');
    await fresh.$executeRawUnsafe('CREATE POLICY tenant_isolation ON gate_probe USING (true)');
    const after = await checkSchemaReadiness(fresh);
    expect(after.problems.join()).not.toMatch(/row-level security/);
    expect(after.ready).toBe(false);
  });
});
