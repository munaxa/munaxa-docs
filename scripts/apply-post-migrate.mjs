#!/usr/bin/env node
// Applies every SQL file in infra/sql/post-migrate, in filename order, as the migration owner.
//
// These are the statements that cannot run at provisioning time because they reference tables:
// row-level security policies and the audit append-only trigger. They must run after every
// `prisma migrate deploy`, not once — a migration that adds a tenant-scoped table needs a
// policy on it, and 01-tenant-isolation.sql raises if one is missing.
//
// The directory is enumerated rather than listed, so adding a file is adding a file.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(repositoryRoot, 'infra', 'sql', 'post-migrate');

// The owner role, not the application role: these statements are DDL, and edms_app has no
// rights to alter a table. Naming the variable is the convention the API config follows too.
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error(
    'DATABASE_MIGRATION_URL is not set. Post-migration SQL runs as the schema owner ' +
      '(edms_owner), not as the application role — see .env.example.',
  );
  process.exit(1);
}

const files = readdirSync(directory)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error(`No .sql files found in ${directory}.`);
  process.exit(1);
}

for (const file of files) {
  process.stdout.write(`applying ${file} … `);
  try {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'execute', '--url', url, '--file', join(directory, file)],
      { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    process.stdout.write('failed\n');
    console.error(error.stderr?.toString() ?? error.message);
    process.exit(1);
  }
  process.stdout.write('ok\n');
}
