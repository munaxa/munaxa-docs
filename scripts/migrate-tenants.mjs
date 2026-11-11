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
// rewrites the history. Prisma's advisory lock serialises only `migrate deploy`; the SQL around it is
// idempotent but not serialised, so two runners at once can fail (a deadlock in the post-migration
// SQL, for one) or leave an unfinished post-migration run that keeps the API and provisioning
// refusing until a single run completes. Run one copy at a time.
//
// ## How it ends
//
// After the post-migration SQL, `prisma migrate status` must agree that nothing is pending or failed
// before a tenant counts as migrated. Exit 0 only when every tenant passed all four steps; exit 1 on a
// migration failure (the database needs attention); exit 2 on a configuration error (nothing was
// touched). No connection string is ever printed: output is redacted before it is written.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT, repositoryRoot, runPrisma } from './migration-support.mjs';

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
 * a status check that the migrations really are all applied.
 */
function migrate(tenant) {
  for (const file of sqlFilesIn(DATABASE_SQL)) {
    step(`database SQL ${file.slice(DATABASE_SQL.length + 1)}`, () =>
      runPrisma(['db', 'execute', '--file', file], tenant.url, { quiet: true }),
    );
  }
  step('prisma migrate deploy', () => runPrisma(['migrate', 'deploy'], tenant.url));
  // The post-migration SQL is not optional and not separate: it is the row-level security policies and
  // the audit append-only trigger, and `01-tenant-isolation.sql` raises if a tenant-scoped table is
  // missing a policy. A tenant migrated without it is a tenant whose isolation backstop is absent.
  step('post-migration SQL', () => {
    const child = spawnSync(
      process.execPath,
      [join(repositoryRoot, 'scripts', 'apply-post-migrate.mjs')],
      {
        cwd: repositoryRoot,
        stdio: ['ignore', 'inherit', 'inherit'],
        // The URL in the environment only, never on the command line.
        env: { ...process.env, DATABASE_URL: tenant.url, DATABASE_MIGRATION_URL: tenant.url },
      },
    );
    return child.status ?? 1;
  });
  // Exit 0 only when every migration in prisma/migrations is applied and none is failed.
  step('prisma migrate status', () =>
    runPrisma(['migrate', 'status'], tenant.url, { quiet: true }),
  );
}

function step(name, work) {
  process.stdout.write(`  ${name}\n`);
  const status = work();
  if (status !== 0) {
    throw new StepFailed(name);
  }
}

class StepFailed extends Error {}

const tenants = tenantsToMigrate();
if (tenants.length === 0) {
  fail('The tenant catalogue lists no tenants, so there is nothing to migrate.');
}

process.stdout.write(`Migrating ${tenants.length} tenant database(s).\n\n`);

for (const [index, tenant] of tenants.entries()) {
  const position = `[${index + 1}/${tenants.length}]`;
  process.stdout.write(`${position} ${tenant.slug}\n`);

  try {
    migrate(tenant);
  } catch (error) {
    // The child already wrote its own (redacted) diagnostics; this names the tenant and the step.
    const where = error instanceof StepFailed ? ` at '${error.message}'` : '';
    console.error(
      `\nMIGRATION FAILED: ${position} ${tenant.slug}${where}. Earlier tenants are migrated; ` +
        'nothing was rolled back or reset. Fix the cause, then re-run.',
    );
    process.exit(EXIT.MIGRATION_FAILED);
  }

  process.stdout.write('\n');
}

process.stdout.write(`Migrated ${tenants.length} tenant database(s).\n`);
