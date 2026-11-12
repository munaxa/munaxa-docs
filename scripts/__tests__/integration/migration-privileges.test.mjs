// L-2: the application role never has write on Prisma's migration history — not on a fresh database,
// not for a moment during the post-migration SQL, not on a database an earlier release migrated —
// while the migration role still migrates and the application keeps what it needs at run time.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { EXIT, repositoryRoot, runPrisma } from '../../migration-support.mjs';
import { appPrivileges, freshDatabase, skip } from './database.mjs';
import { migrate, run, start } from './run.mjs';

const quiet = { stdout: () => {}, stderr: () => {} };
const NO_WRITE = { insert: false, update: false, delete: false, truncate: false };

function writes(privileges) {
  const { insert, update, delete: remove, truncate } = privileges;
  return { insert, update, delete: remove, truncate };
}

async function asApp(db, sql) {
  return db.db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE edms_app');
    return tx.$executeRawUnsafe(sql);
  });
}

describe('privileges on the migration history', { skip, concurrency: false }, () => {
  const made = [];
  const database = async () => {
    const db = await freshDatabase();
    made.push(db);
    return db;
  };
  after(async () => {
    for (const db of made) await db.drop();
  });

  test('a fresh database: no write between `migrate deploy` and the post-migration SQL', async () => {
    const db = await database();
    const grants = join(repositoryRoot, 'infra', 'sql', 'database', '01-grants.sql');
    assert.equal(await runPrisma(['db', 'execute', '--file', grants], db.ownerUrl, quiet), 0);

    // No default privilege hands tables to the application any more.
    const [defaults] = await db.db.$queryRawUnsafe(`
      SELECT count(*)::int AS n FROM pg_default_acl d
       WHERE d.defaclobjtype = 'r' AND array_to_string(d.defaclacl, ',') LIKE '%edms_app=%'`);
    assert.equal(defaults.n, 0);

    // The moment that used to be the window: Prisma has just created its history table.
    assert.equal(await runPrisma(['migrate', 'deploy'], db.ownerUrl, quiet), 0);
    assert.deepEqual(writes(await appPrivileges(db.db, 'public._prisma_migrations')), NO_WRITE);
    assert.equal((await appPrivileges(db.db, 'public._prisma_migrations')).select, false);

    // The post-migration SQL: read for the application, never write.
    const post = await run('apply-post-migrate.mjs', { DATABASE_MIGRATION_URL: db.ownerUrl });
    assert.equal(post.status, EXIT.OK, post.output);
    const history = await appPrivileges(db.db, 'public._prisma_migrations');
    assert.equal(history.select, true);
    assert.deepEqual(writes(history), NO_WRITE);
  });

  test('the application role is refused every write to the history, and keeps its run-time access', async () => {
    const db = await database();
    const result = await migrate(db.ownerUrl);
    assert.equal(result.status, EXIT.OK, result.output);

    for (const sql of [
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, applied_steps_count)
       VALUES ('forged', 'x', '20990101000000_forged', now(), 1)`,
      `UPDATE _prisma_migrations SET finished_at = now()`,
      `DELETE FROM _prisma_migrations`,
      `TRUNCATE _prisma_migrations`,
    ]) {
      await assert.rejects(asApp(db, sql), /permission denied/, sql);
    }

    // Run-time access is unchanged: read and write on the application's tables, append-only audit.
    const tables = await db.db.$queryRawUnsafe(`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`);
    assert.ok(tables.length > 20);
    for (const { name } of tables) {
      const privileges = await appPrivileges(db.db, `public."${name}"`);
      const expected =
        name === 'audit_event'
          ? { select: true, insert: true, update: false, delete: false, truncate: false }
          : { select: true, insert: true, update: true, delete: true, truncate: false };
      assert.deepEqual(privileges, expected, name);
    }

    // Forced row-level security and the tenant policy on every tenant table, as before.
    const [unprotected] = await db.db.$queryRawUnsafe(`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'tenant'
         AND EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = c.relname AND column_name = 'tenant_id')
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity
                  AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'))`);
    assert.equal(unprotected.n, 0);

    // And the migration role still migrates: a re-run is a clean no-op.
    const again = await migrate(db.ownerUrl);
    assert.equal(again.status, EXIT.OK, again.output);
    assert.match(again.output, /No pending migrations to apply/);
  });

  test('no other session ever sees the grant the post-migration SQL makes and takes back', async () => {
    const db = await database();
    const result = await migrate(db.ownerUrl);
    assert.equal(result.status, EXIT.OK, result.output);

    // Control: 01-tenant-isolation.sql on its own (the way it ran before) does leave the write, so
    // the observer below would see it if the runner ever did.
    const isolation = join(
      repositoryRoot,
      'infra',
      'sql',
      'post-migrate',
      '01-tenant-isolation.sql',
    );
    assert.equal(await runPrisma(['db', 'execute', '--file', isolation], db.ownerUrl, quiet), 0);
    assert.equal((await appPrivileges(db.db, 'public._prisma_migrations')).insert, true);
    await db.db.$executeRawUnsafe(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public._prisma_migrations FROM edms_app',
    );

    // The runner's way, watched from another session for the whole run.
    const runner = start('apply-post-migrate.mjs', { DATABASE_MIGRATION_URL: db.ownerUrl });
    let samples = 0;
    let seen = false;
    let finished = false;
    void runner.result.then(() => (finished = true));
    while (!finished) {
      const privileges = await appPrivileges(db.db, 'public._prisma_migrations');
      samples += 1;
      seen ||= privileges.insert || privileges.update || privileges.delete || privileges.truncate;
    }
    const post = await runner.result;
    assert.equal(post.status, EXIT.OK, post.output);
    assert.ok(samples > 10, `only ${samples} samples`);
    assert.equal(seen, false, 'the application role could write the history during the run');
  });

  test('a database migrated by an earlier release loses the old default and the old write', async () => {
    const db = await database();
    // What releases before this change left: a default privilege granting the application every
    // table edms_owner creates, and therefore write on the history Prisma created.
    await db.db.$executeRawUnsafe(`
      ALTER DEFAULT PRIVILEGES FOR ROLE edms_owner IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO edms_app`);
    assert.equal(await runPrisma(['migrate', 'deploy'], db.ownerUrl, quiet), 0);
    assert.equal((await appPrivileges(db.db, 'public._prisma_migrations')).insert, true);

    // The per-database SQL alone, before any migration of the next release, already takes it back.
    const grants = readFileSync(
      join(repositoryRoot, 'infra', 'sql', 'database', '01-grants.sql'),
      'utf8',
    );
    assert.equal(
      await runPrisma(['db', 'execute', '--stdin'], db.ownerUrl, { ...quiet, input: grants }),
      0,
    );
    assert.deepEqual(writes(await appPrivileges(db.db, 'public._prisma_migrations')), NO_WRITE);
    const [defaults] = await db.db.$queryRawUnsafe(`
      SELECT count(*)::int AS n FROM pg_default_acl d
       WHERE d.defaclobjtype = 'r' AND array_to_string(d.defaclacl, ',') LIKE '%edms_app=%'`);
    assert.equal(defaults.n, 0);

    // A full run from there ends in the same state as on a fresh database.
    const result = await migrate(db.ownerUrl);
    assert.equal(result.status, EXIT.OK, result.output);
    const history = await appPrivileges(db.db, 'public._prisma_migrations');
    assert.equal(history.select, true);
    assert.deepEqual(writes(history), NO_WRITE);
  });
});
