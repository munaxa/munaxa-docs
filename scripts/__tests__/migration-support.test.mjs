// DC-01: what the migration runner prints and how it ends, without a database.
//
//   node --test scripts/__tests__/
//
// The end-to-end behaviour against a real database is scripts/migration-image/verify.sh.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { EXIT, prismaCli, redact, repositoryRoot } from '../migration-support.mjs';

test('redacts every PostgreSQL URL and every password, encoded or not', () => {
  const url = 'postgresql://edms_owner:s3cr%40t-pass@db.internal:5432/edms_acme';
  const text = `failed at ${url}\nauth for s3cr@t-pass and s3cr%40t-pass\npostgres://x:y@h/d`;
  const out = redact(text, [url]);
  assert.doesNotMatch(out, /s3cr/);
  assert.doesNotMatch(out, /postgres(ql)?:\/\/[^*]/);
  assert.match(out, /postgresql:\/\/\*\*\*/);
});

test('leaves ordinary text alone', () => {
  assert.equal(
    redact('All migrations have been successfully applied.', []),
    'All migrations have been successfully applied.',
  );
});

test('resolves the Prisma CLI the lockfile pins, without pnpm', () => {
  const cli = prismaCli();
  assert.match(cli, /node_modules[\\/].*prisma[\\/]build[\\/]index\.js$/);
  const lock = readFileSync(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  const pinned = /^ {2}prisma@([0-9.]+)/m.exec(lock)?.[1];
  const version = JSON.parse(readFileSync(join(cli, '..', '..', 'package.json'), 'utf8')).version;
  assert.equal(version, pinned);
});

function runner(env) {
  return spawnSync(process.execPath, [join(repositoryRoot, 'scripts', 'migrate-tenants.mjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

test('exits 2, touching nothing, without a migration URL', () => {
  const result = runner({});
  assert.equal(result.status, EXIT.CONFIGURATION);
  assert.match(result.stderr, /DATABASE_MIGRATION_URL is not set/);
});

test('exits 2 before any database for a catalogue tenant with no migration URL', () => {
  const result = runner({ TENANT_CATALOGUE: JSON.stringify({ tenants: [{ slug: 'acme' }] }) });
  assert.equal(result.status, EXIT.CONFIGURATION);
  assert.match(result.stderr, /Tenant 'acme' has no migration URL/);
});

test('exits 1 and names the tenant and step when the database cannot be reached, printing no URL', () => {
  const url = 'postgresql://edms_owner:never-print-me@127.0.0.1:9/edms_none';
  const result = runner({ DATABASE_MIGRATION_URL: url, TENANT_SLUG: 'acme' });
  assert.equal(result.status, EXIT.MIGRATION_FAILED);
  assert.match(result.stderr, /MIGRATION FAILED: \[1\/1\] acme at 'database SQL 01-grants\.sql'/);
  assert.doesNotMatch(result.stdout + result.stderr, /never-print-me/);
  assert.doesNotMatch(result.stdout + result.stderr, /postgres(ql)?:\/\/[^*]/);
});

test('never runs a destructive Prisma command', () => {
  for (const file of ['migrate-tenants.mjs', 'apply-post-migrate.mjs', 'migration-support.mjs']) {
    const source = readFileSync(join(repositoryRoot, 'scripts', file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(
      source,
      /migrate['", ]+(reset|dev)\b|db['", ]+push|accept-data-loss|force-reset|migrate['", ]+resolve/,
      file,
    );
  }
});
