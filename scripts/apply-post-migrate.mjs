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
//
// ## Under the migration lock (L-1)
//
// Every statement this script runs first checks, in the same transaction, that the migration lock
// (migration-support.mjs `MIGRATION_LOCK`) is held by the session that owns this run. Run by
// migrate-tenants.mjs, that is the runner's own lock session (`MIGRATION_LOCK_BACKEND_PID`). Run on
// its own (`pnpm db:post-migrate`, the DR rehearsal), it takes the lock itself first and refuses,
// exit 3, if another run holds it for longer than MIGRATION_LOCK_TIMEOUT_SECONDS. So a run is never
// opened, a file never applied and a run never closed while another migration run is active.
//
// ## Never a moment of write access to Prisma's history (L-2)
//
// 01-tenant-isolation.sql grants the application role write on every table in `public`, and that
// includes `_prisma_migrations`, which the start-up and provisioning gate trusts. Each file is
// therefore executed together with a revoke of that write, as one script, in one transaction (the
// whole script a single `db execute`): no other session ever sees the grant. The bytes executed are
// the bytes hashed into the run record, read once.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXIT,
  MigrationLockTimeout,
  acquireMigrationLock,
  assertLockHeldSql,
  describeConnectionError,
  lockWaitSeconds,
  repositoryRoot,
  runPrisma,
  stopRunningChildren,
} from './migration-support.mjs';

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
const contents = files.map((file) => {
  if (!NAME.test(file)) {
    console.error(`Unexpected post-migration file name ${JSON.stringify(file)}.`);
    process.exit(EXIT.CONFIGURATION);
  }
  // Read once: what is hashed into the run record is exactly what is executed.
  const bytes = readFileSync(join(directory, file));
  return { file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const entries = contents.map(({ file, sha256 }) => `${file}:${sha256}`);

const lockWait = lockWaitSeconds();
if (lockWait === null) {
  console.error('MIGRATION_LOCK_TIMEOUT_SECONDS must be a whole number of seconds from 0 to 3600.');
  process.exit(EXIT.CONFIGURATION);
}

// The runner's lock session, or our own.
let lock;
let lockPid;
const inherited = process.env.MIGRATION_LOCK_BACKEND_PID;
if (inherited !== undefined) {
  lockPid = /^[1-9]\d{0,9}$/.test(inherited) ? Number(inherited) : NaN;
  if (!Number.isSafeInteger(lockPid)) {
    console.error('MIGRATION_LOCK_BACKEND_PID is not a backend id.');
    process.exit(EXIT.CONFIGURATION);
  }
} else {
  try {
    lock = await acquireMigrationLock(url, {
      waitSeconds: lockWait,
      onWait: () =>
        process.stdout.write(
          `waiting up to ${lockWait}s for the migration lock: another migration run holds it\n`,
        ),
      onLost: () => void stopRunningChildren(),
    });
  } catch (error) {
    if (error instanceof MigrationLockTimeout) {
      console.error(`POST-MIGRATION LOCKED: ${error.message}. Nothing was changed.`);
      process.exit(EXIT.LOCKED);
    }
    console.error(`Could not take the migration lock: ${describeConnectionError(error, [url])}`);
    process.exit(EXIT.MIGRATION_FAILED);
  }
  lockPid = lock.pid;
}

// Stopped (by the runner, or by an operator): stop the running statement's CLI and wait for it, and
// only then let go of the lock, so no statement of this run can still be executing once another run
// may start. The run record stays open, which keeps the gate refusing until a run completes.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void stopRunningChildren().then(async () => {
      await lock?.release();
      console.error(`Post-migration SQL cancelled by ${signal}; the run stays open.`);
      process.exit(EXIT.MIGRATION_FAILED);
    });
  });
}
const guard = assertLockHeldSql(lockPid);

const finish = async (code) => {
  await lock?.release();
  process.exit(code);
};

const run = randomUUID();
// One `db execute`: the lock check, then `sql`, in one transaction. Output is streamed as it comes.
const execute = async (label, sql) => {
  process.stdout.write(`${label} …\n`);
  const status = await runPrisma(['db', 'execute', '--stdin'], url, {
    input: `${guard}\n${sql}`,
    // Under the runner, stay in the process group it stops; on our own, a group of its own.
    processGroup: inherited === undefined,
  });
  if (status !== 0 || lock?.lost) {
    process.stdout.write(`${label}: failed${lock?.lost ? ` (${lock.lost.message})` : ''}\n`);
    await finish(EXIT.MIGRATION_FAILED);
  }
  process.stdout.write(`${label}: ok\n`);
};

// After every file, in the same transaction as the file: 01-tenant-isolation.sql's GRANT on every
// table in `public` never leaves the application role able to write the history the gate trusts.
const ASSERT_HISTORY_READ_ONLY = `
-- A REVOKE by a role that does not own the table only warns: prove the result, whatever the route.
DO $$
BEGIN
  IF has_table_privilege('edms_app', 'public._prisma_migrations', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'edms_app can still write public._prisma_migrations (is it owned by edms_owner?)';
  END IF;
END
$$;
`;

const KEEP_HISTORY_READ_ONLY = `
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public._prisma_migrations FROM edms_app;
${ASSERT_HISTORY_READ_ONLY}`;

// Opened before any file runs, so the migrations it lists are those the files then run against: a
// migration another runner applies meanwhile is not claimed by this run. Closed only when every file
// has applied; a run that fails or is killed stays open, and the gate refuses while the newest run
// is open.
await execute(
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
for (const { file, bytes } of contents) {
  // A trailing line break, so a final `--` comment in the file cannot swallow the revoke.
  await execute(`applying ${file}`, `${bytes.toString('utf8')}\n${KEEP_HISTORY_READ_ONLY}`);
}

await execute(
  'closing the post-migration run record',
  `
-- 01-tenant-isolation.sql grants the application role write on every table in \`public\`, which
-- includes Prisma's history: the gate trusts that history, so edms_app may only read it.
${KEEP_HISTORY_READ_ONLY}
UPDATE munaxa_meta.post_migrate_run SET completed_at = now() WHERE run = '${run}';
`,
);

await finish(EXIT.OK);
