import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@edms/utils';

import {
  buildSchema,
  checkSchemaReadiness,
  expectedMigrations,
  expectedPostMigrate,
} from './schema-readiness';

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
    const build = buildSchema();
    const result = await checkSchemaReadiness(app, build);
    expect(result.problems).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.applied).toBeGreaterThanOrEqual(build.migrations.length);
    expect(result.unknown).toEqual([]);
  });

  it('refuses an empty database: no migration history', async () => {
    const result = await checkSchemaReadiness(fresh);
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual([
      'the database has no readable migration history (_prisma_migrations): it is not migrated',
    ]);
  });

  it('cannot write the post-migration record as the application role', async () => {
    await expect(
      app.$executeRawUnsafe(
        `INSERT INTO munaxa_meta.post_migrate_run (run, completed_at, files, migrations)
         VALUES (gen_random_uuid(), now(), '{}', '{}')`,
      ),
    ).rejects.toThrow(/permission denied/);
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
    expect(after.problems.join()).toMatch(/post-migration SQL is not recorded as applied/);
    expect(after.ready).toBe(false);

    // Row-level security alone is not the post-migration SQL: a run recorded with only 01 (and only
    // the first migration) names the files that did not apply.
    const [isolation, ...rest] = expectedPostMigrate();
    await fresh.$executeRawUnsafe('CREATE SCHEMA munaxa_meta');
    await fresh.$executeRawUnsafe(`
      CREATE TABLE munaxa_meta.post_migrate_run (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run uuid NOT NULL UNIQUE,
        started_at timestamptz DEFAULT now(), completed_at timestamptz,
        files text[] NOT NULL, migrations text[] NOT NULL)`);
    await fresh.$executeRawUnsafe(
      `INSERT INTO munaxa_meta.post_migrate_run (run, completed_at, files, migrations)
       VALUES (gen_random_uuid(), now(), $1, $2)`,
      [`${isolation?.file ?? ''}:${isolation?.sha256 ?? ''}`],
      [first],
    );
    const partial = await checkSchemaReadiness(fresh);
    expect(partial.problems.at(-1)).toBe(
      'post-migration SQL of this build not applied (never run, failed, or changed since): ' +
        rest.map((row) => row.file).join(', '),
    );

    // A migration finished after that run: the run no longer covers the schema.
    await fresh.$executeRawUnsafe(
      `UPDATE _prisma_migrations SET finished_at = now() WHERE migration_name = $1`,
      second,
    );
    const later = await checkSchemaReadiness(fresh);
    expect(later.problems).toContain(
      `the post-migration SQL has not completed since 1 migration(s) were applied, the first being ${second ?? ''}: the last migration run did not finish`,
    );

    // A newer run that opened and never closed (failed or stopped part-way).
    await fresh.$executeRawUnsafe(
      `INSERT INTO munaxa_meta.post_migrate_run (run, files, migrations)
       VALUES (gen_random_uuid(), '{}', '{}')`,
    );
    const open = await checkSchemaReadiness(fresh);
    expect(open.problems.join()).toMatch(/newer than the last completed one did not complete/);
  });
});
