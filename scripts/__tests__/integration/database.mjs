// Disposable databases for the migration runner's integration tests (L-1, L-2).
//
//   MIGRATION_TEST_ADMIN_URL   a role that may CREATE and DROP DATABASE and SET ROLE edms_app
//                              (CI: the edms_owner superuser of the integration job's PostgreSQL)
//   MIGRATION_TEST_OWNER_URL   edms_owner on any database of the same server; the tests swap the
//                              database name (CI: the same URL as the admin one)
//
// The cluster roles (infra/sql/cluster/01-roles.sql) must exist. Every database made here is named
// mig_test_<random> and dropped afterwards. Without the variables the suites are skipped, so the
// workflow step that runs them sets both.

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repositoryRoot } from '../../migration-support.mjs';

export const ADMIN_URL = process.env.MIGRATION_TEST_ADMIN_URL ?? '';
export const OWNER_URL = process.env.MIGRATION_TEST_OWNER_URL ?? '';
export const configured = Boolean(ADMIN_URL && OWNER_URL);
export const skip = configured
  ? false
  : 'MIGRATION_TEST_ADMIN_URL and MIGRATION_TEST_OWNER_URL are not set';

const { PrismaClient } = await import(
  pathToFileURL(createRequire(join(repositoryRoot, 'package.json')).resolve('@prisma/client')).href
);

export function urlFor(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

export function client(url) {
  return new PrismaClient({ datasourceUrl: url });
}

/** A fresh, empty database owned by edms_owner; `drop()` removes it. */
export async function freshDatabase() {
  const name = `mig_test_${randomBytes(6).toString('hex')}`;
  const admin = client(urlFor(ADMIN_URL, 'postgres'));
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${name} OWNER edms_owner`);
  } finally {
    await admin.$disconnect();
  }
  const db = client(urlFor(ADMIN_URL, name));
  return {
    name,
    ownerUrl: urlFor(OWNER_URL, name),
    db,
    async drop() {
      await db.$disconnect();
      const again = client(urlFor(ADMIN_URL, 'postgres'));
      try {
        await again.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await again.$disconnect();
      }
    },
  };
}

/** The advisory locks held in `db`'s database under the migration lock's identity. */
export async function migrationLocks(db) {
  return db.$queryRawUnsafe(`
    SELECT l.pid, a.application_name
      FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND l.classid = 1297436248 AND l.objid = 1145915719
       AND l.objsubid = 2 AND l.granted
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
}

/** What edms_app may do to a table, as PostgreSQL itself answers it. */
export async function appPrivileges(db, table) {
  const [row] = await db.$queryRawUnsafe(
    `SELECT has_table_privilege('edms_app', $1, 'SELECT') AS select,
            has_table_privilege('edms_app', $1, 'INSERT') AS insert,
            has_table_privilege('edms_app', $1, 'UPDATE') AS update,
            has_table_privilege('edms_app', $1, 'DELETE') AS delete,
            has_table_privilege('edms_app', $1, 'TRUNCATE') AS truncate`,
    table,
  );
  return { ...row };
}

/** Whether anything at all exists in the database beyond what CREATE DATABASE made. */
export async function untouched(db) {
  const [row] = await db.$queryRawUnsafe(`
    SELECT to_regclass('public._prisma_migrations') IS NULL
       AND to_regnamespace('munaxa_meta') IS NULL
       AND to_regprocedure('public.current_tenant_id()') IS NULL
       AND NOT EXISTS (SELECT 1 FROM pg_default_acl)
       AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public') AS untouched`);
  return row.untouched === true;
}
