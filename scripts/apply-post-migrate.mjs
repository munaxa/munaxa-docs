#!/usr/bin/env node
// Applies every SQL file in infra/sql/post-migrate, in filename order, as the migration owner.
//
// These are the statements that cannot run at provisioning time because they reference tables:
// row-level security policies and the audit append-only trigger. They must run after every
// `prisma migrate deploy`, not once — a migration that adds a tenant-scoped table needs a
// policy on it, and 01-tenant-isolation.sql raises if one is missing.
//
// The directory is enumerated rather than listed, so adding a file is adding a file.
//
// When every file has applied, the last step adds a row to `munaxa_meta.post_migrate_run` (DC-01):
// each file's name and SHA-256, and the Prisma migrations applied at that moment. The API's start-up
// gate and provisioning refuse a database unless the latest run covers every applied migration and
// carries this build's file versions, so a post-migration run that failed, was skipped after a new
// migration, or predates a changed file is seen, not only missing row-level security. Rows are only
// added. The application role may read them and nothing else.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT, repositoryRoot, runPrisma } from './migration-support.mjs';

const directory = join(repositoryRoot, 'infra', 'sql', 'post-migrate');

// The owner role, not the application role: these statements are DDL, and edms_app has no
// rights to alter a table. Naming the variable is the convention the API config follows too.
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error(
    'DATABASE_MIGRATION_URL is not set. Post-migration SQL runs as the schema owner ' +
      '(edms_owner), not as the application role — see .env.example.',
  );
  process.exit(EXIT.CONFIGURATION);
}

const files = readdirSync(directory)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error(`No .sql files found in ${directory}.`);
  process.exit(EXIT.CONFIGURATION);
}

// Each entry of the record is `<file>:<sha256>`. The names are checked before anything runs, so a
// configuration error touches nothing.
const NAME = /^[0-9A-Za-z._-]+$/;
const entries = files.map((file) => {
  if (!NAME.test(file)) {
    console.error(`Unexpected post-migration file name ${JSON.stringify(file)}.`);
    process.exit(EXIT.CONFIGURATION);
  }
  const sha256 = createHash('sha256')
    .update(readFileSync(join(directory, file)))
    .digest('hex');
  return `${file}:${sha256}`;
});

// The Prisma CLI by its own path, the URL in its environment only, and its output redacted
// (migration-support.mjs): this runs inside the migration image, which has no pnpm and no shell.
for (const file of files) {
  process.stdout.write(`applying ${file} … `);
  const status = runPrisma(['db', 'execute', '--file', join(directory, file)], url, {
    quiet: true,
  });
  if (status !== 0) {
    process.stdout.write('failed\n');
    process.exit(EXIT.MIGRATION_FAILED);
  }
  process.stdout.write('ok\n');
}

process.stdout.write('recording the post-migration run … ');
const status = runPrisma(['db', 'execute', '--stdin'], url, {
  quiet: true,
  input: `
-- Its own schema, so Prisma (which manages \`public\`) never sees it as drift. The database is
-- owned by edms_owner on every documented path (docs-db-admin, CI, compose), which may create it.
CREATE SCHEMA IF NOT EXISTS munaxa_meta;
REVOKE ALL ON SCHEMA munaxa_meta FROM PUBLIC;
GRANT USAGE ON SCHEMA munaxa_meta TO edms_app;
-- One row per completed run: the file versions it applied, and the Prisma migrations the database
-- had when it finished, so a later migration without a later run is seen.
CREATE TABLE IF NOT EXISTS munaxa_meta.post_migrate_run (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now(),
  files        text[]      NOT NULL,
  migrations   text[]      NOT NULL
);
REVOKE ALL ON munaxa_meta.post_migrate_run FROM PUBLIC;
REVOKE ALL ON munaxa_meta.post_migrate_run FROM edms_app;
GRANT SELECT ON munaxa_meta.post_migrate_run TO edms_app;
INSERT INTO munaxa_meta.post_migrate_run (files, migrations)
SELECT ARRAY[${entries.map((entry) => `'${entry}'`).join(', ')}]::text[],
       COALESCE(array_agg(migration_name ORDER BY migration_name), '{}')
  FROM public._prisma_migrations
 WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
`,
});
if (status !== 0) {
  process.stdout.write('failed\n');
  process.exit(EXIT.MIGRATION_FAILED);
}
process.stdout.write('ok\n');
