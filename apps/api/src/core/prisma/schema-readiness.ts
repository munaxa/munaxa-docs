import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Is a tenant database migrated far enough for this build to use it (DC-01)?
 *
 * The migration runner (`scripts/migrate-tenants.mjs`, the `migrate` image) and the API are separate
 * processes, and in the hosted Docs separate one-off tasks. Nothing used to connect them: the API
 * would start against an empty database and fail on its first query, and provisioning would fail
 * half-way with a Prisma error that named a missing table. This is the check both now run first, so
 * the order *migrate, then provision, then serve* is enforced rather than documented.
 *
 * A database is ready when, and only when:
 *
 * 1. `_prisma_migrations` exists and the connecting role can read it;
 * 2. every migration this build carries in `prisma/migrations` has finished and was not rolled back;
 * 3. no migration is failed or still running (finished_at and rolled_back_at both empty) — Prisma's
 *    own definition, the one `migrate deploy` refuses to continue past;
 * 4. every tenant-scoped table has row-level security enabled and forced, with its
 *    `tenant_isolation` policy — which is how the post-migration SQL is seen to have run.
 *
 * A database may be *ahead* of this build (it knows migrations this build does not). That is the
 * rollback shape in docs/operations/deployment.md §6 — the previous images against an expand-only
 * migrated schema — so it is reported, not refused.
 *
 * Nothing here writes, and nothing here reports a connection string.
 */
export interface SchemaReadiness {
  readonly ready: boolean;
  /** Plain-language reasons the database is not ready; empty when it is. */
  readonly problems: readonly string[];
  readonly expected: number;
  readonly applied: number;
  /** Applied migrations this build does not know: the database is ahead of the image. */
  readonly unknown: readonly string[];
}

export interface MigrationRow {
  readonly migration_name: string;
  readonly finished: boolean;
  readonly rolled_back: boolean;
}

export interface SchemaFacts {
  /** `_prisma_migrations` exists and is readable by the connecting role. */
  readonly historyReadable: boolean;
  readonly rows: readonly MigrationRow[];
  /** Tenant-scoped tables without forced row-level security and their isolation policy. */
  readonly unprotectedTables: readonly string[];
}

/** The minimum of a Prisma client this needs, so it can be tested without one. */
export interface RawQuerier {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export const HISTORY_READABLE_SQL = `
  SELECT to_regclass('public._prisma_migrations') IS NOT NULL
     AND has_table_privilege('public._prisma_migrations', 'SELECT') AS readable`;

export const MIGRATION_ROWS_SQL = `
  SELECT migration_name,
         finished_at IS NOT NULL AS finished,
         rolled_back_at IS NOT NULL AS rolled_back
    FROM public._prisma_migrations`;

/**
 * The tables 01-tenant-isolation.sql protects, discovered the same way (every `public` table with a
 * `tenant_id` column except `tenant` and Prisma's own), from the catalogue rather than from
 * information_schema, so the answer does not depend on the connecting role's table privileges.
 */
export const UNPROTECTED_TABLES_SQL = `
  SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname <> 'tenant'
     AND c.relname NOT LIKE '\\_prisma%'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity
              AND EXISTS (SELECT 1 FROM pg_policy p
                           WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'))
   ORDER BY c.relname`;

/** Reads the facts. Throws only when the database itself cannot be reached. */
export async function readSchemaFacts(db: RawQuerier): Promise<SchemaFacts> {
  const [readable] = await db.$queryRawUnsafe<{ readable: boolean | null }[]>(HISTORY_READABLE_SQL);
  const historyReadable = readable?.readable === true;
  const rows = historyReadable ? await db.$queryRawUnsafe<MigrationRow[]>(MIGRATION_ROWS_SQL) : [];
  const unprotected = await db.$queryRawUnsafe<{ name: string }[]>(UNPROTECTED_TABLES_SQL);
  return { historyReadable, rows, unprotectedTables: unprotected.map((row) => row.name) };
}

/** The pure decision, from the facts and the migrations this build carries. */
export function evaluateSchema(facts: SchemaFacts, expected: readonly string[]): SchemaReadiness {
  const problems: string[] = [];

  if (expected.length === 0) {
    // A build with no migrations is a broken build, not an empty schema: refuse rather than pass.
    problems.push('this build carries no migrations (prisma/migrations is missing or empty)');
  }

  if (!facts.historyReadable) {
    problems.push(
      'the database has no readable migration history (_prisma_migrations): it is not migrated',
    );
    return { ready: false, problems, expected: expected.length, applied: 0, unknown: [] };
  }

  const applied = new Set(
    facts.rows.filter((row) => row.finished && !row.rolled_back).map((row) => row.migration_name),
  );
  const failed = facts.rows
    .filter((row) => !row.finished && !row.rolled_back)
    .map((row) => row.migration_name)
    .sort();
  if (failed.length > 0) {
    problems.push(`migration(s) failed or still running: ${failed.join(', ')}`);
  }

  const pending = expected.filter((name) => !applied.has(name));
  if (pending.length > 0) {
    problems.push(
      `${String(pending.length)} of ${String(expected.length)} migration(s) not applied, the first being ${pending[0] ?? ''}`,
    );
  }

  if (facts.unprotectedTables.length > 0) {
    problems.push(
      'tenant-scoped table(s) without forced row-level security (the post-migration SQL has not ' +
        `run): ${facts.unprotectedTables.join(', ')}`,
    );
  }

  const known = new Set(expected);
  const unknown = [...applied].filter((name) => !known.has(name)).sort();

  return {
    ready: problems.length === 0,
    problems,
    expected: expected.length,
    applied: applied.size,
    unknown,
  };
}

/**
 * The migrations this build carries: the directory names under `prisma/migrations` that hold a
 * `migration.sql`, which is exactly what `prisma migrate deploy` applies.
 *
 * `PRISMA_MIGRATIONS_DIR` overrides the search; otherwise the directory is found by walking up from
 * the running script and from the working directory, so it is found in the images (`/app/prisma`), in
 * a checkout and under the test runner alike.
 */
export function expectedMigrations(directory = locateMigrations()): string[] {
  if (directory === undefined || !existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'migration.sql')),
    )
    .map((entry) => entry.name)
    .sort();
}

export function locateMigrations(): string | undefined {
  const override = process.env['PRISMA_MIGRATIONS_DIR'];
  if (override) {
    return resolve(override);
  }
  const starts = [process.argv[1] ? dirname(resolve(process.argv[1])) : undefined, process.cwd()];
  for (const start of starts) {
    let current = start;
    while (current !== undefined) {
      const candidate = join(current, 'prisma', 'migrations');
      if (existsSync(join(candidate, 'migration_lock.toml'))) {
        return candidate;
      }
      const parent = dirname(current);
      current = parent === current ? undefined : parent;
    }
  }
  return undefined;
}

/** Checks one database against this build. */
export async function checkSchemaReadiness(
  db: RawQuerier,
  expected: readonly string[] = expectedMigrations(),
): Promise<SchemaReadiness> {
  return evaluateSchema(await readSchemaFacts(db), expected);
}

/** Thrown when a database is reachable but not migrated for this build. */
export class SchemaNotReadyError extends Error {
  constructor(
    readonly tenantSlug: string,
    readonly readiness: SchemaReadiness,
  ) {
    super(
      `The database of '${tenantSlug}' is not migrated for this build: ${readiness.problems.join('; ')}. ` +
        'Run the migration (the docs-migrate task, or scripts/migrate-tenants.mjs) first.',
    );
    this.name = 'SchemaNotReadyError';
  }
}
