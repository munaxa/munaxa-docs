// L-1: one migration run per tenant database at a time, enforced by the database itself.
//
//   MIGRATION_TEST_ADMIN_URL=… MIGRATION_TEST_OWNER_URL=… \
//     node --test --test-concurrency=1 scripts/__tests__/integration/*.test.mjs
//
// Each test makes its own disposable database (database.mjs) and runs the real runner against it.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  EXIT,
  MIGRATION_LOCK,
  MigrationLockTimeout,
  acquireMigrationLock,
} from '../../migration-support.mjs';
import { freshDatabase, migrationLocks, skip, untouched } from './database.mjs';
import { migrate, run, start, until } from './run.mjs';

describe('the migration lock', { skip, concurrency: false }, () => {
  const made = [];
  const database = async () => {
    const db = await freshDatabase();
    made.push(db);
    return db;
  };
  after(async () => {
    for (const db of made) await db.drop();
  });

  test('is taken on its own named session and released by release()', async () => {
    const db = await database();
    const lock = await acquireMigrationLock(db.ownerUrl, { waitSeconds: 0 });
    try {
      const held = await migrationLocks(db.db);
      assert.equal(held.length, 1);
      assert.equal(held[0].pid, lock.pid);
      assert.equal(held[0].application_name, MIGRATION_LOCK.applicationName);
      await lock.assertHeld();
    } finally {
      await lock.release();
    }
    assert.deepEqual(await migrationLocks(db.db), []);
  });

  test('a second taker times out after the bounded wait, naming the holder', async () => {
    const db = await database();
    const first = await acquireMigrationLock(db.ownerUrl, { waitSeconds: 0 });
    try {
      const started = Date.now();
      await assert.rejects(
        acquireMigrationLock(db.ownerUrl, { waitSeconds: 2, pollMs: 100 }),
        (error) =>
          error instanceof MigrationLockTimeout &&
          error.holder?.pid === first.pid &&
          /waited 2s/.test(error.message),
      );
      const waited = Date.now() - started;
      assert.ok(waited >= 2_000 && waited < 6_000, `waited ${waited} ms`);

      // No wait at all: one attempt, then the refusal.
      const quick = Date.now();
      await assert.rejects(
        acquireMigrationLock(db.ownerUrl, { waitSeconds: 0 }),
        MigrationLockTimeout,
      );
      assert.ok(Date.now() - quick < 2_000);
    } finally {
      await first.release();
    }
    // Free again: the next taker gets it at once.
    const next = await acquireMigrationLock(db.ownerUrl, { waitSeconds: 0 });
    await next.release();
  });

  test('a waiting taker gets the lock as soon as it is released', async () => {
    const db = await database();
    const first = await acquireMigrationLock(db.ownerUrl, { waitSeconds: 0 });
    let waited = false;
    const second = acquireMigrationLock(db.ownerUrl, {
      waitSeconds: 30,
      pollMs: 100,
      onWait: () => (waited = true),
    });
    await until(() => waited, 10_000, 'the second taker to start waiting');
    await first.release();
    const lock = await second;
    assert.equal((await migrationLocks(db.db))[0].pid, lock.pid);
    await lock.release();
  });

  test('a second runner is refused (exit 3) and changes nothing while another run holds the lock', async () => {
    const db = await database();
    const holder = await acquireMigrationLock(db.ownerUrl, { waitSeconds: 0 });
    try {
      const result = await migrate(db.ownerUrl, { MIGRATION_LOCK_TIMEOUT_SECONDS: '1' });
      assert.equal(result.status, EXIT.LOCKED, result.output);
      assert.match(
        result.stderr,
        /MIGRATION LOCKED: \[1\/1\] acme: another migration run holds the migration lock \(backend \d+, munaxa-docs-migrate-lock\); waited 1s\. Nothing was read or changed/,
      );
      // Not one step started: no grants, no default privileges, no history, no run record.
      assert.doesNotMatch(result.stdout, /database SQL|migrate deploy|post-migration/);
      assert.ok(await untouched(db.db), 'the database was changed before the lock was taken');

      // The post-migration SQL on its own takes the same lock and is refused the same way.
      const post = await run('apply-post-migrate.mjs', {
        DATABASE_MIGRATION_URL: db.ownerUrl,
        MIGRATION_LOCK_TIMEOUT_SECONDS: '0',
      });
      assert.equal(post.status, EXIT.LOCKED, post.output);
      assert.ok(await untouched(db.db));
    } finally {
      await holder.release();
    }
  });

  test('is released after a successful run', async () => {
    const db = await database();
    const result = await migrate(db.ownerUrl);
    assert.equal(result.status, EXIT.OK, result.output);
    assert.match(result.stdout, /migration lock held/);
    assert.deepEqual(await migrationLocks(db.db), []);
    const next = await acquireMigrationLock(db.ownerUrl, { waitSeconds: 0 });
    await next.release();
  });

  test('is released after a failed run', async () => {
    const db = await database();
    // A type the second migration creates, so migration 1 applies and migration 2 fails (P3018).
    await db.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE edms_owner');
      await tx.$executeRawUnsafe(`CREATE TYPE "user_status" AS ENUM ('X')`);
    });
    const result = await migrate(db.ownerUrl);
    assert.equal(result.status, EXIT.MIGRATION_FAILED, result.output);
    assert.match(result.output, /P3018/);
    assert.deepEqual(await migrationLocks(db.db), []);
    const next = await acquireMigrationLock(db.ownerUrl, { waitSeconds: 0 });
    await next.release();
  });

  test('two runners at once: the second waits for the first, and both finish cleanly', async () => {
    const db = await database();
    const [a, b] = await Promise.all([migrate(db.ownerUrl), migrate(db.ownerUrl)]);
    assert.equal(a.status, EXIT.OK, a.output);
    assert.equal(b.status, EXIT.OK, b.output);
    assert.ok(
      /waiting up to 120s for the migration lock/.test(a.stdout + b.stdout),
      'one of them waited',
    );
    const [counts] = await db.db.$queryRawUnsafe(`
      SELECT (SELECT count(*) - count(DISTINCT migration_name) FROM _prisma_migrations)::int AS duplicated,
             (SELECT count(*) FROM munaxa_meta.post_migrate_run WHERE completed_at IS NULL)::int AS open,
             (SELECT count(*) FROM munaxa_meta.post_migrate_run WHERE completed_at IS NOT NULL)::int AS closed`);
    assert.deepEqual(counts, { duplicated: 0, open: 0, closed: 2 });
    // The two post-migration runs did not overlap: each began after the previous one completed.
    const [overlap] = await db.db.$queryRawUnsafe(`
      SELECT count(*)::int AS n FROM munaxa_meta.post_migrate_run a JOIN munaxa_meta.post_migrate_run b
          ON a.id < b.id AND b.started_at < a.completed_at`);
    assert.equal(overlap.n, 0);
  });

  test('cancellation stops the running step, then releases the lock', async () => {
    const db = await database();
    const runner = start('migrate-tenants.mjs', { DATABASE_MIGRATION_URL: db.ownerUrl });
    await until(async () => (await migrationLocks(db.db)).length === 1, 30_000, 'the lock');
    await until(() => /migrate deploy|post-migration/.test(runner.output()), 30_000, 'a step');
    runner.child.kill('SIGTERM');
    const result = await runner.result;
    assert.equal(result.status, EXIT.MIGRATION_FAILED, result.output);
    assert.match(result.stderr, /MIGRATION CANCELLED by SIGTERM/);
    assert.deepEqual(await migrationLocks(db.db), []);
    // Nothing of the run is still executing: a fresh run completes.
    const again = await migrate(db.ownerUrl);
    assert.notEqual(again.status, EXIT.LOCKED, again.output);
  });

  test('a run that loses its lock session stops with exit 1', async () => {
    const db = await database();
    const runner = start('migrate-tenants.mjs', { DATABASE_MIGRATION_URL: db.ownerUrl });
    await until(async () => (await migrationLocks(db.db)).length === 1, 30_000, 'the lock');
    const [{ pid }] = await migrationLocks(db.db);
    await db.db.$queryRawUnsafe(`SELECT pg_terminate_backend(${Number(pid)})`);
    const result = await runner.result;
    assert.equal(result.status, EXIT.MIGRATION_FAILED, result.output);
    assert.match(result.stderr, /MIGRATION FAILED: .*the migration lock was lost/);
  });

  test('every SQL step checks, in its own transaction, that its run still holds the lock', async () => {
    const db = await database();
    // A post-migration run pointed at a session that does not hold the lock (this test's own).
    const [{ pid }] = await db.db.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
    const result = await run('apply-post-migrate.mjs', {
      DATABASE_MIGRATION_URL: db.ownerUrl,
      MIGRATION_LOCK_BACKEND_PID: String(pid),
    });
    assert.equal(result.status, EXIT.MIGRATION_FAILED, result.output);
    assert.match(result.output, /the Docs migration lock is not held by this migration run/);
    // The opening record never committed: the schema it creates in the same transaction is absent.
    const [row] = await db.db.$queryRawUnsafe(
      `SELECT to_regnamespace('munaxa_meta') IS NULL AS absent`,
    );
    assert.equal(row.absent, true);
  });
});
