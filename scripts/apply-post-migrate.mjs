#!/usr/bin/env node
// Applies every SQL file in infra/sql/post-migrate, in filename order, as the migration owner.
//
// These are the statements that cannot run at provisioning time because they reference tables:
// row-level security policies and the audit append-only trigger. They must run after every
// `prisma migrate deploy`, not once — a migration that adds a tenant-scoped table needs a
// policy on it, and 01-tenant-isolation.sql raises if one is missing.
//
// The directory is enumerated rather than listed, so adding a file is adding a file.

import { readdirSync } from 'node:fs';
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
