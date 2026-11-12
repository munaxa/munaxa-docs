#!/usr/bin/env node
// Applies the schema and the post-migration SQL to **every tenant database** this deployment serves.
//
// Under ADR-0015 there is no "the database" to migrate. There are N, one per company, each holding the
// same schema — so a release that changes the schema has to visit all of them, and a release that
// visited some of them is worse than one that visited none: half the customers would be running against
// a schema the code no longer matches.
//
// Reads the same tenant catalogue the API reads, from the same environment variables, so the set of
// databases migrated is exactly the set the application will connect to. Deriving it any other way —
// a separate list, a directory scan — is how a tenant comes to be missed.
//
// Sequential and fail-fast. Migrations take locks, and running twenty in parallel against one PostgreSQL
// cluster is a good way to find out which of them deadlock. Stopping at the first failure leaves a known
// prefix migrated and names the tenant that stopped it, which is what makes the re-run safe: Prisma's
// migration table makes each one idempotent.
//
// ## Where it runs (DC-01)
//
// From a checkout (`node scripts/migrate-tenants.mjs`), and as the entry point of the `migrate` target
// of ./Dockerfile, which is what the hosted Docs runs as its one-off `docs-migrate` task. Both paths
// run this file unchanged: it starts the Prisma CLI by its own path rather than through pnpm, so it
// needs Node and the repository's `node_modules` and nothing else (migration-support.mjs).
//
// ## What it never does
//
// It runs `prisma migrate deploy` and nothing that can lose data: never `migrate reset`, `migrate
// dev`, `db push` or `--accept-data-loss`. A failed migration stays recorded as failed in
// `_prisma_migrations`, so `migrate deploy` refuses to continue past it on every later run until an
// operator has resolved it (docs/operations/deployment.md §2); nothing here marks it rolled back or
// rewrites the history.
//
// ## One run per database at a time (L-1)
//
// Before it reads or changes anything in a tenant database, the runner takes that database's
// migration lock (migration-support.mjs `MIGRATION_LOCK`, a PostgreSQL advisory lock on its own
// connection) and holds it until `migrate status` has passed. A second runner — another copy, or
// another release's — waits up to MIGRATION_LOCK_TIMEOUT_SECONDS (default 120, at most 3600) and
// then exits 3 having touched nothing in that database. If the database cannot be reached the run
// fails (exit 1) rather than going on unlocked. Every SQL step re-checks, inside its own
// transaction, that this run's session still holds the lock, and a heartbeat stops the run if that
// session is lost. SIGTERM or SIGINT stops the running child, then releases the lock, then exits 1.
//
// ## How it ends
//
// After the post-migration SQL, `prisma migrate status` must agree that nothing is pending or failed
// before a tenant counts as migrated. Exit 0 only when every tenant passed all four steps; exit 1 on a
// migration failure (the database needs attention); exit 2 on a configuration error (nothing was
// touched); exit 3 when another run held a tenant's migration lock for the whole wait (nothing was
// read or changed in that tenant's database). No connection string is ever printed: output is
// streamed as the commands produce it, redacted before it is written.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXIT,
  MigrationLockLost,
  MigrationLockTimeout,
  acquireMigrationLock,
  assertLockHeldSql,
  childEnvironment,
  describeConnectionError,
  lockWaitSeconds,
  repositoryRoot,
  runPrisma,
  runStreaming,
  stopRunningChildren,
} from './migration-support.mjs';

/**
 * The per-database SQL: grants, default privileges, and the tenant discriminator function the
 * row-level security policies read.
 *
 * Applied before the first migration of every tenant database, and idempotent, so it is applied before
 * every migration rather than tracked. That is what makes a fresh tenant database self-provisioning:
 * an operator creates it empty, adds it to the catalogue, and runs this — rather than remembering a
 * separate step whose omission surfaces as `function current_tenant_id() does not exist` from a
 * post-migration script three commands later.
 *
 * The cluster's roles are *not* here. A role is cluster-scoped, so creating it per database would fail
 * on the second one (`infra/sql/README.md`).
 */
const DATABASE_SQL = join(repositoryRoot, 'infra', 'sql', 'database');

/**
 * The catalogue, resolved the way `ConfigTenantRegistry` resolves it.
 *
 * Deliberately duplicated in JavaScript rather than imported from the API's build output: this script
 * has to run before anything is built, on a fresh checkout, in a release pipeline whose first step is
 * migrating. Importing compiled TypeScript would make migration depend on a successful build of the
 * application it is migrating *for*.
 *
 * The duplication is bounded to reading a document and substituting one placeholder. Everything that
 * decides whether a placement is *valid* stays in one place, and the API refuses to start on a catalogue
 * this script accepted but it would not.
 */
function tenantsToMigrate() {
  const inline = process.env.TENANT_CATALOGUE;
  const path = process.env.TENANT_CATALOGUE_PATH;

  if (inline && path) {
    fail('Give the catalogue inline or as a file, not both.');
  }

  if (!inline && !path) {
    // The single-tenant shape: an on-premise installation whose one database is DATABASE_MIGRATION_URL.
    const url = process.env.DATABASE_MIGRATION_URL;
    if (!url) {
      fail(
        'DATABASE_MIGRATION_URL is not set. Migrations run as the schema owner (edms_owner), not as ' +
          'the application role — see .env.example.',
      );
    }
    return [{ slug: process.env.TENANT_SLUG ?? 'default', url }];
  }

  const document = inline ?? readCatalogue(path);
  const catalogue = parse(document);
  const defaults = catalogue.defaults ?? {};
  const template = defaults.migrationUrlTemplate;

  return (catalogue.tenants ?? []).map((tenant) => {
    const url =
      tenant.database?.migrationUrl ?? (template ? fill(template, tenant.slug) : undefined);
    if (!url) {
      // Named, and refused before any database is touched: a partial run is the thing this avoids.
      fail(
        `Tenant '${tenant.slug}' has no migration URL. Give it one, or set ` +
          'defaults.migrationUrlTemplate in the catalogue.',
      );
    }
    return { slug: tenant.slug, url };
  });
}

function readCatalogue(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    // The path, never the contents: a catalogue holds credentials.
    fail(`Cannot read the tenant catalogue at ${path} (${error.code ?? error.message}).`);
  }
}

function parse(document) {
  try {
    return JSON.parse(document);
  } catch {
    fail('The tenant catalogue is not valid JSON.');
  }
}

function fill(template, slug) {
  return template.replaceAll('{slug}', slug);
}

function fail(message) {
  console.error(message);
  process.exit(EXIT.CONFIGURATION);
}

function sqlFilesIn(directory) {
  // Enumerated rather than listed, so adding a file is adding a file.
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => join(directory, name));
}

/**
 * The steps for one tenant, in the only order that works: the per-database SQL (the schema is still
 * empty), the migrations, the post-migration SQL (it references the tables the migrations made), and
 * a status check that the migrations really are all applied — all under the tenant database's
 * migration lock, taken before the first step and released after the last.
 */
async function migrate(tenant) {
  const lock = await acquireMigrationLock(tenant.url, {
    waitSeconds: lockWait,
    onWait: () =>
      process.stdout.write(
        `  waiting up to ${lockWait}s for the migration lock: another migration run holds it\n`,
      ),
    // A lost lock stops the running SQL step; the step then fails and names the reason. A running
    // `prisma migrate deploy` is left to finish (it holds Prisma's own advisory lock, and killing it
    // mid-migration leaves a failed migration that needs `migrate resolve`); the run fails right
    // after it instead.
    onLost: () => {
      if (current.step !== 'prisma migrate deploy') void stopRunningChildren();
    },
    signal: cancellation.signal,
  });
  process.stdout.write('  migration lock held\n');
  try {
    for (const file of sqlFilesIn(DATABASE_SQL)) {
      // Through stdin, after a check in the same transaction that this run still holds the lock.
      await step(lock, `database SQL ${file.slice(DATABASE_SQL.length + 1)}`, () =>
        runPrisma(['db', 'execute', '--stdin'], tenant.url, {
          input: `${assertLockHeldSql(lock.pid)}\n${readFileSync(file, 'utf8')}\n`,
        }),
      );
    }
    await step(lock, 'prisma migrate deploy', () => runPrisma(['migrate', 'deploy'], tenant.url));
    // The post-migration SQL is not optional and not separate: it is the row-level security policies
    // and the audit append-only trigger, and `01-tenant-isolation.sql` raises if a tenant-scoped table
    // is missing a policy. A tenant migrated without it is a tenant whose isolation backstop is absent.
    await step(lock, 'post-migration SQL', () =>
      runStreaming(process.execPath, [join(repositoryRoot, 'scripts', 'apply-post-migrate.mjs')], {
        // The URL in the environment only, never on the command line; the lock's backend, so every
        // statement it runs first checks that this run still holds the lock.
        env: childEnvironment(tenant.url, { MIGRATION_LOCK_BACKEND_PID: String(lock.pid) }),
        urls: [tenant.url],
        prefix: '',
      }),
    );
    // Exit 0 only when every migration in prisma/migrations is applied and none is failed.
    await step(lock, 'prisma migrate status', () => runPrisma(['migrate', 'status'], tenant.url));
    current.step = 'releasing the migration lock';
    await lock.assertHeld();
  } finally {
    await lock.release();
  }
}

async function step(lock, name, work) {
  current.step = name;
  if (cancelled) {
    throw new Cancelled();
  }
  await lock.assertHeld();
  process.stdout.write(`  ${name}\n`);
  const status = await work();
  if (cancelled) {
    throw new Cancelled();
  }
  if (status !== 0) {
    // A step that failed because the lock's session went away (its own guard refused) says so.
    await lock.assertHeld();
    throw new StepFailed(name);
  }
  if (lock.lost) {
    throw lock.lost;
  }
}

class StepFailed extends Error {}

class Cancelled extends Error {}

const lockWait = lockWaitSeconds();
if (lockWait === null) {
  fail('MIGRATION_LOCK_TIMEOUT_SECONDS must be a whole number of seconds from 0 to 3600.');
}

const tenants = tenantsToMigrate();
if (tenants.length === 0) {
  fail('The tenant catalogue lists no tenants, so there is nothing to migrate.');
}

// Where the run is, so a failure or a cancellation can name it.
const current = { step: undefined };
const cancellation = new AbortController();
let cancelled;

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    cancelled = signal;
    cancellation.abort();
    process.stderr.write(`\nReceived ${signal}: stopping the running step.\n`);
    // The step's failure path reports and exits once its child has exited and the lock is released.
    void stopRunningChildren();
    // If nothing is running (waiting for the lock, between steps), end anyway: the lock's session
    // ends with this process.
    setTimeout(() => {
      process.stderr.write(`MIGRATION CANCELLED by ${signal}.\n`);
      process.exit(EXIT.MIGRATION_FAILED);
    }, 20_000).unref();
  });
}

process.stdout.write(`Migrating ${tenants.length} tenant database(s).\n\n`);

for (const [index, tenant] of tenants.entries()) {
  const position = `[${index + 1}/${tenants.length}]`;
  process.stdout.write(`${position} ${tenant.slug}\n`);
  current.step = 'acquiring the migration lock';

  try {
    await migrate(tenant);
  } catch (error) {
    if (error instanceof MigrationLockTimeout) {
      console.error(
        `\nMIGRATION LOCKED: ${position} ${tenant.slug}: ${error.message}. Nothing was read or ` +
          "changed in this tenant's database; earlier tenants are migrated. Let the other run finish, " +
          'then re-run.',
      );
      process.exit(EXIT.LOCKED);
    }
    if (cancelled) {
      console.error(
        `\nMIGRATION CANCELLED by ${cancelled}: ${position} ${tenant.slug} at '${current.step}'. ` +
          'The running step was stopped and the lock released. Earlier tenants are migrated; ' +
          'nothing was rolled back or reset. Re-run to finish.',
      );
      process.exit(EXIT.MIGRATION_FAILED);
    }
    // The child already wrote its own (redacted) diagnostics; this names the tenant and the step.
    const why =
      error instanceof StepFailed
        ? ''
        : `: ${error instanceof MigrationLockLost ? error.message : describeConnectionError(error, [tenant.url])}`;
    console.error(
      `\nMIGRATION FAILED: ${position} ${tenant.slug} at '${current.step}'${why}. ` +
        'Earlier tenants are migrated; nothing was rolled back or reset. Fix the cause, then re-run.',
    );
    process.exit(EXIT.MIGRATION_FAILED);
  }

  process.stdout.write('\n');
}

process.stdout.write(`Migrated ${tenants.length} tenant database(s).\n`);
