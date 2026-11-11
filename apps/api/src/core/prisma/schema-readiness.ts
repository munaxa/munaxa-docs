import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
 * 4. the post-migration SQL in `infra/sql/post-migrate` completed *after* the last migration, per
 *    `munaxa_meta.post_migrate_run` (`scripts/apply-post-migrate.mjs` opens a row before its first
 *    file with the migrations applied at that moment, and closes it after its last): the latest
 *    closed run began after every migration now applied; no newer run is still open (failed,
 *    stopped or running); and some closed run applied this build's version of every file (any
 *    closed run, so the previous build still starts after a release that changed a file). So a run
 *    that failed in any file, or was skipped after a new migration, is seen, not only the row-level
 *    security of 01-tenant-isolation.sql;
 * 5. every tenant-scoped table has row-level security enabled and forced, with its
 *    `tenant_isolation` policy (checked directly as well, because it is the isolation boundary).
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

export interface PostMigrateFile {
  readonly file: string;
  readonly sha256: string;
}

export interface PostMigrateRun {
  /** `<file>:<sha256>` of each file the run applied. */
  readonly files: readonly string[];
  /** The Prisma migrations applied when the run began, before its first file. */
  readonly migrations: readonly string[];
}

export interface SchemaFacts {
  /** `_prisma_migrations` exists and is readable by the connecting role. */
  readonly historyReadable: boolean;
  readonly rows: readonly MigrationRow[];
  /** `munaxa_meta.post_migrate_run` exists and is readable by the connecting role. */
  readonly postMigrateReadable: boolean;
  /** The latest completed post-migration run, if any. */
  readonly latestRun: PostMigrateRun | undefined;
  /** A run newer than the latest completed one never completed (failed, killed, or running). */
  readonly openRun: boolean;
  /** `<file>:<sha256>` of every file version any completed run applied. */
  readonly everApplied: readonly string[];
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

export const POST_MIGRATE_READABLE_SQL = `
  SELECT EXISTS (SELECT 1 FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'munaxa_meta' AND c.relname = 'post_migrate_run'
                    AND has_schema_privilege(n.oid, 'USAGE')
                    AND has_table_privilege(c.oid, 'SELECT')) AS readable`;

export const LATEST_RUN_SQL = `
  SELECT files, migrations FROM munaxa_meta.post_migrate_run
   WHERE completed_at IS NOT NULL ORDER BY id DESC LIMIT 1`;

/** A run opened after the latest closed one and never closed: failed, killed, or still running. */
export const OPEN_RUN_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM munaxa_meta.post_migrate_run
     WHERE completed_at IS NULL
       AND id > COALESCE((SELECT max(id) FROM munaxa_meta.post_migrate_run
                           WHERE completed_at IS NOT NULL), 0)) AS open`;

export const EVER_APPLIED_SQL = `
  SELECT DISTINCT unnest(files) AS entry FROM munaxa_meta.post_migrate_run
   WHERE completed_at IS NOT NULL`;

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
  const [marker] =
    await db.$queryRawUnsafe<{ readable: boolean | null }[]>(POST_MIGRATE_READABLE_SQL);
  const postMigrateReadable = marker?.readable === true;
  const [latestRun] = postMigrateReadable
    ? await db.$queryRawUnsafe<PostMigrateRun[]>(LATEST_RUN_SQL)
    : [];
  const [open] = postMigrateReadable
    ? await db.$queryRawUnsafe<{ open: boolean | null }[]>(OPEN_RUN_SQL)
    : [];
  const openRun = open?.open === true;
  const everApplied = postMigrateReadable
    ? (await db.$queryRawUnsafe<{ entry: string }[]>(EVER_APPLIED_SQL)).map((row) => row.entry)
    : [];
  const unprotected = await db.$queryRawUnsafe<{ name: string }[]>(UNPROTECTED_TABLES_SQL);
  return {
    historyReadable,
    rows,
    postMigrateReadable,
    latestRun,
    openRun,
    everApplied,
    unprotectedTables: unprotected.map((row) => row.name),
  };
}

/** What this build carries: its Prisma migrations and its post-migration SQL files. */
export interface BuildSchema {
  readonly migrations: readonly string[];
  readonly postMigrate: readonly PostMigrateFile[];
}

/** The pure decision, from the facts and what this build carries. */
export function evaluateSchema(facts: SchemaFacts, build: BuildSchema): SchemaReadiness {
  const problems: string[] = [];
  const expected = build.migrations;

  if (expected.length === 0) {
    // A build with no migrations is a broken build, not an empty schema: refuse rather than pass.
    problems.push('this build carries no migrations (prisma/migrations is missing or empty)');
  }
  if (build.postMigrate.length === 0) {
    problems.push(
      'this build carries no post-migration SQL (infra/sql/post-migrate is missing or empty)',
    );
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

  const known = new Set(expected);
  const unknown = [...applied].filter((name) => !known.has(name)).sort();

  const run = facts.postMigrateReadable ? facts.latestRun : undefined;
  if (run === undefined) {
    problems.push(
      'the post-migration SQL is not recorded as applied (munaxa_meta.post_migrate_run is missing, ' +
        'empty or unreadable): the migration did not finish',
    );
  } else {
    const covered = new Set(run.migrations);
    const since = [...applied].filter((name) => !covered.has(name)).sort();
    if (since.length > 0) {
      problems.push(
        `the post-migration SQL has not completed since ${String(since.length)} migration(s) were ` +
          `applied, the first being ${since[0] ?? ''}: the last migration run did not finish`,
      );
    }
    if (facts.openRun) {
      problems.push(
        'a post-migration run newer than the last completed one did not complete (it failed, was ' +
          'stopped, or is still running): run the migration again',
      );
    }
    // Any completed run of this build's file versions counts, so the previous build still starts
    // after a release that changed a file (a rollback). A later run of other versions that failed
    // is the open run above.
    const reference = new Set(facts.everApplied);
    const missing = build.postMigrate
      .filter((row) => !reference.has(`${row.file}:${row.sha256}`))
      .map((row) => row.file);
    if (missing.length > 0) {
      problems.push(
        'post-migration SQL of this build not applied (never run, failed, or changed since): ' +
          missing.join(', '),
      );
    }
  }

  if (facts.unprotectedTables.length > 0) {
    problems.push(
      'tenant-scoped table(s) without forced row-level security (the post-migration SQL has not ' +
        `run): ${facts.unprotectedTables.join(', ')}`,
    );
  }

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
  return locateUpwards(['prisma', 'migrations'], 'migration_lock.toml');
}

/**
 * The post-migration SQL this build carries, with the SHA-256 of each file's bytes: exactly what
 * `scripts/apply-post-migrate.mjs` applies and records.
 */
export function expectedPostMigrate(directory = locatePostMigrate()): PostMigrateFile[] {
  if (directory === undefined || !existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((file) => ({
      file,
      sha256: createHash('sha256')
        .update(readFileSync(join(directory, file)))
        .digest('hex'),
    }));
}

export function locatePostMigrate(): string | undefined {
  const override = process.env['POST_MIGRATE_SQL_DIR'];
  if (override) {
    return resolve(override);
  }
  return locateUpwards(['infra', 'sql', 'post-migrate'], '01-tenant-isolation.sql');
}

/** Walks up from the running script and from the working directory to `<segments>/<sentinel>`. */
function locateUpwards(segments: readonly string[], sentinel: string): string | undefined {
  const starts = [process.argv[1] ? dirname(resolve(process.argv[1])) : undefined, process.cwd()];
  for (const start of starts) {
    let current = start;
    while (current !== undefined) {
      const candidate = join(current, ...segments);
      if (existsSync(join(candidate, sentinel))) {
        return candidate;
      }
      const parent = dirname(current);
      current = parent === current ? undefined : parent;
    }
  }
  return undefined;
}

/** What the running build carries. */
export function buildSchema(): BuildSchema {
  return { migrations: expectedMigrations(), postMigrate: expectedPostMigrate() };
}

/** Checks one database against this build. */
export async function checkSchemaReadiness(
  db: RawQuerier,
  build: BuildSchema = buildSchema(),
): Promise<SchemaReadiness> {
  return evaluateSchema(await readSchemaFacts(db), build);
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
