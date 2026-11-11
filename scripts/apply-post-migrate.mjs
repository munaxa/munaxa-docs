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
// Each run is recorded in `munaxa_meta.post_migrate_run` (DC-01): opened before the first file with
// the file versions (name and SHA-256) and the Prisma migrations applied at that moment, closed after
// the last. The API's start-up gate and provisioning refuse a database while the newest run is open
// (failed, killed or still running), when a migration was applied after the latest closed run began,
// or when no closed run applied this build's version of every file. Rows are only added. The
// application role may read them and nothing else.

import { createHash, randomUUID } from 'node:crypto';
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

const run = randomUUID();
const record = (label, sql) => {
  process.stdout.write(`${label} … `);
  const status = runPrisma(['db', 'execute', '--stdin'], url, { quiet: true, input: sql });
  if (status !== 0) {
    process.stdout.write('failed\n');
    process.exit(EXIT.MIGRATION_FAILED);
  }
  process.stdout.write('ok\n');
};

// Opened before any file runs, so the migrations it lists are those the files then run against: a
// migration another runner applies meanwhile is not claimed by this run. Closed only when every file
// has applied; a run that fails or is killed stays open, and the gate refuses while the newest run
// is open.
record(
  'opening the post-migration run record',
  `
-- Its own schema, so Prisma (which manages \`public\`) never sees it as drift. The database is
-- owned by edms_owner on every documented path (docs-db-admin, CI, compose), which may create it.
CREATE SCHEMA IF NOT EXISTS munaxa_meta;
REVOKE ALL ON SCHEMA munaxa_meta FROM PUBLIC;
GRANT USAGE ON SCHEMA munaxa_meta TO edms_app;
CREATE TABLE IF NOT EXISTS munaxa_meta.post_migrate_run (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run          uuid        NOT NULL UNIQUE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  files        text[]      NOT NULL,
  migrations   text[]      NOT NULL
);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public._prisma_migrations FROM edms_app;
REVOKE ALL ON munaxa_meta.post_migrate_run FROM PUBLIC;
REVOKE ALL ON munaxa_meta.post_migrate_run FROM edms_app;
GRANT SELECT ON munaxa_meta.post_migrate_run TO edms_app;
INSERT INTO munaxa_meta.post_migrate_run (run, files, migrations)
SELECT '${run}',
       ARRAY[${entries.map((entry) => `'${entry}'`).join(', ')}]::text[],
       COALESCE(array_agg(migration_name ORDER BY migration_name), '{}')
  FROM public._prisma_migrations
 WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
`,
);

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

record(
  'closing the post-migration run record',
  `
-- 01-tenant-isolation.sql grants the application role write on every table in \`public\`, which
-- includes Prisma's history: the gate trusts that history, so edms_app may only read it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public._prisma_migrations FROM edms_app;
UPDATE munaxa_meta.post_migrate_run SET completed_at = now() WHERE run = '${run}';
`,
);
