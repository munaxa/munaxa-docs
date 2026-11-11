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
// When every file has applied, the last step records each file's name and SHA-256 in
// `munaxa_meta.post_migrate_applied` (DC-01). The API's start-up gate and provisioning compare that
// record with the files the running build carries, so a database on which any post-migration file
// failed, was skipped or has since changed is refused, not only one missing row-level security.
// The record is append-only from here (a row per file version, never deleted), so an older build
// still finds its own versions after an expand-only rollback. The application role may read it and
// nothing else.

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

const MARKER = /^[0-9A-Za-z._-]+$/;
const recorded = files.map((file) => {
  const sha256 = createHash('sha256')
    .update(readFileSync(join(directory, file)))
    .digest('hex');
  if (!MARKER.test(file)) {
    console.error(`Unexpected post-migration file name ${JSON.stringify(file)}.`);
    process.exit(EXIT.CONFIGURATION);
  }
  return `('${file}', '${sha256}')`;
});

process.stdout.write('recording the post-migration SQL as applied … ');
const status = runPrisma(['db', 'execute', '--stdin'], url, {
  quiet: true,
  input: `
-- Its own schema, so Prisma (which manages \`public\`) never sees it as drift. The database is
-- owned by edms_owner on every documented path (docs-db-admin, CI, compose), which may create it.
CREATE SCHEMA IF NOT EXISTS munaxa_meta;
REVOKE ALL ON SCHEMA munaxa_meta FROM PUBLIC;
GRANT USAGE ON SCHEMA munaxa_meta TO edms_app;
CREATE TABLE IF NOT EXISTS munaxa_meta.post_migrate_applied (
  file       text        NOT NULL,
  sha256     text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file, sha256)
);
REVOKE ALL ON munaxa_meta.post_migrate_applied FROM PUBLIC;
REVOKE ALL ON munaxa_meta.post_migrate_applied FROM edms_app;
GRANT SELECT ON munaxa_meta.post_migrate_applied TO edms_app;
INSERT INTO munaxa_meta.post_migrate_applied (file, sha256) VALUES
  ${recorded.join(',\n  ')}
ON CONFLICT (file, sha256) DO NOTHING;
`,
});
if (status !== 0) {
  process.stdout.write('failed\n');
  process.exit(EXIT.MIGRATION_FAILED);
}
process.stdout.write('ok\n');
