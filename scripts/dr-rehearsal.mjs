#!/usr/bin/env node
// The disaster-recovery restore rehearsal — Phase 6.10, and the first one this repository has ever
// performed.
//
// `docs/operations/backup-and-restore.md` §3 says it plainly: *"An untested backup is not a
// backup."* Everything that document describes had tested components and an untested composition,
// and §4 said so rather than letting somebody discover it during an incident. This script is the
// composition, executed.
//
// ## What it is, and what it deliberately is not
//
// It is **the documented procedure, run** — not a second procedure that happens to produce a
// database. Every step below is one of §2's steps, in §2's order once the ordering defect this
// rehearsal found was corrected, using this repository's own tooling: `infra/sql/cluster`,
// `infra/sql/database` and `scripts/apply-post-migrate.mjs` are the same files an operator applies,
// invoked the same way. Nothing here creates a table the backup was supposed to restore.
//
// It is **not** a point-in-time restore. §2's step 1 is a base restore followed by
// `pg_wal_replay_pause()` and recovery to a target LSN, and continuous WAL archiving is a property
// of a running cluster rather than of a repository — no archive exists to recover through, so the
// rehearsal performs the half that can be performed and the report says which half that is. What is
// proven is that the artefact reconstitutes the environment; what is not is the *minutes* of RPO
// the architecture claims.
//
// It does not create the destination cluster either, and that is the same distinction: a cluster is
// infrastructure an operator provisions, and inventing one here would make the rehearsal depend on
// this machine's `initdb`. The destination is passed in, empty, and the script refuses one that is
// not.
//
// ## Usage
//
//   DATABASE_MIGRATION_URL=…        the first tenant's database, as its owner
//   SECOND_DATABASE_MIGRATION_URL=… the second tenant's, or empty for a one-tenant rehearsal
//   DR_DEST_ADMIN_URL=…             a superuser on the EMPTY destination cluster
//   DR_BACKUP_DIR=…                 where the artefacts are written
//
//   node scripts/dr-rehearsal.mjs
//
// Prints one JSON object on stdout: the source checkpoint, the artefact's evidence, the restored
// checkpoint, the security posture of the restored cluster and every measured duration. Everything
// the report's §9 through §16 assert is a field of it.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BACKUP_DIR = process.env.DR_BACKUP_DIR ?? join(ROOT, '.dr');
const DEST_ADMIN = required('DR_DEST_ADMIN_URL');

/**
 * The tenants in the rehearsal, named by their database.
 *
 * Derived from the same two variables the integration suite and the end-to-end suite read, so the
 * set of databases backed up is exactly the set the application was just using. Deriving it any
 * other way is how a tenant comes to be missed — the argument `migrate-tenants.mjs` makes about
 * reading the catalogue rather than scanning a directory.
 */
const TENANTS = [
  {
    key: 'primary',
    sourceUrl: required('DATABASE_MIGRATION_URL'),
    sourceAppUrl: required('DATABASE_URL'),
  },
  ...(process.env.SECOND_DATABASE_MIGRATION_URL
    ? [
        {
          key: 'secondary',
          sourceUrl: process.env.SECOND_DATABASE_MIGRATION_URL,
          sourceAppUrl: process.env.SECOND_DATABASE_URL ?? '',
        },
      ]
    : []),
].map((tenant) => {
  const database = new URL(tenant.sourceUrl).pathname.replace(/^\//, '');
  return {
    ...tenant,
    database,
    restoredOwnerUrl: destUrl('edms_owner', database),
    restoredAppUrl: destUrl('edms_app', database),
  };
});

/**
 * What the rehearsal compares, and it is deliberately everything rather than a sample.
 *
 * `MUST MATCH` is every row count in the schema plus the audit tail, because a database restore
 * that dropped a table nobody sampled would pass a sampled comparison. There is no `MAY DIFFER`
 * list for a dump-and-restore of a whole database: the transient state this product tolerates
 * losing — Redis, the search index — is outside the artefact rather than inside it and different,
 * and `backup-and-restore.md` §1 records why for each.
 */
const AUDIT_TAIL = `
  SELECT sequence::text, hash, previous_hash, action
  FROM audit_event ORDER BY sequence DESC LIMIT 1`;

const step = [];
const started = Date.now();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set.`);
    process.exit(1);
  }
  return value;
}

/** The same database on the destination cluster, reached as the named role. */
function destUrl(role, database) {
  const url = new URL(DEST_ADMIN);
  url.username = role;
  url.password = '';
  url.pathname = `/${database}`;
  return url.toString();
}

function psql(url, args) {
  return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** ASCII SOH as the field separator: it cannot occur in a uuid, a slug, a hash or a status. */
const FS = String.fromCharCode(1);

/** One query, answered as rows of fields. */
function ask(url, sql) {
  const raw = psql(url, ['-q', '-t', '-A', '-F', FS, '-c', sql]).trim();
  if (raw === '') {
    return [];
  }
  return raw.split('\n').map((line) => line.split(FS));
}

function one(url, sql) {
  return ask(url, sql)[0] ?? [];
}

/**
 * The same query, asked **as the application would ask it** — inside one tenant's discriminator.
 *
 * Not a nicety. Row-level security on every tenant-scoped table is `FORCE`d, so it applies to the
 * owner as well, and a count taken without `app.tenant_id` returns zero rather than everything. The
 * first run of this rehearsal reported every restored table empty for exactly that reason, and the
 * restore had been perfect: the *source* cluster's `edms_owner` had been created out of band as a
 * superuser, which bypasses row security regardless of FORCE, while the destination's was created
 * by `infra/sql/cluster/01-roles.sql` and correctly was not. Two sides answering different
 * questions, and the difference presented as total data loss.
 *
 * Reading both sides through the discriminator removes the asymmetry, and is the stronger check
 * anyway: it counts what a tenant can actually see, which is what a restored database has to serve.
 */
function askAsTenant(url, tenantId, sql) {
  const script = `SELECT set_config('app.tenant_id', '${tenantId}', false) \\g /dev/null\n${sql};\n`;
  const raw = execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-F', FS], {
    cwd: ROOT,
    encoding: 'utf8',
    input: script,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return raw === '' ? [] : raw.split('\n').map((line) => line.split(FS));
}

function timed(name, run) {
  const at = Date.now();
  const result = run();
  step.push({ name, ms: Date.now() - at });
  return result;
}

/**
 * A checkpoint of one database: what has to be true again on the other side.
 *
 * Row counts come from the tables themselves rather than from `pg_stat`, whose estimates are
 * exactly the kind of number that agrees when the rows do not.
 */
function checkpointOf(url) {
  const tables = ask(
    url,
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  ).map(([name]) => name);

  // `tenant` carries no policy — it *is* the discriminator — so the roll is readable without one.
  const tenants = ask(url, 'SELECT id, slug FROM tenant ORDER BY slug').map(([id, slug]) => ({
    id,
    slug,
  }));

  /*
   * One query per tenant, not one per table per tenant — Phase 8.18.
   *
   * `askAsTenant` spawns a `psql` process per call, and this loop used to call it once for every
   * table of every tenant. Measured on this repository's own fixture cluster: 79 tables x 73
   * tenants x 2 databases x 2 sides = **23 068 process spawns**, which is what a rehearsal of two
   * 15MB databases was spending its time on. Nothing was slow; something was repeated.
   *
   * The cost is O(tables x tenants), so it grows with the tenant roll — which is exactly the
   * degradation recorded across Phases 8.15-8.17 (409s -> 619s -> past its 600s timeout) as e2e
   * fixture tenants accumulated. It is not a test-only problem: an operator rehearsing recovery on
   * a real deployment with a few hundred tenants would hit the same wall, harder.
   *
   * A single `UNION ALL` returns every count for a tenant in one round trip, under the same
   * `set_config('app.tenant_id', ...)` the loop used, so the numbers are read through the tenant
   * discriminator exactly as before. Same query, same policy, same answers — one process instead
   * of seventy-nine.
   */
  const countsSql = tables
    .map((table) => `SELECT '${table}' AS t, count(*) AS n FROM "${table}"`)
    .join(' UNION ALL ');

  const perTenant = {};
  for (const tenant of tenants) {
    const counts = {};
    for (const table of tables) counts[table] = 0;
    for (const [table, value] of askAsTenant(url, tenant.id, countsSql)) {
      counts[table] = Number(value);
    }

    const [sequence = null, hash = null, previousHash = null, action = null] =
      askAsTenant(url, tenant.id, AUDIT_TAIL)[0] ?? [];

    perTenant[tenant.slug] = {
      id: tenant.id,
      counts,
      audit: { sequence, hash, previousHash, action },
      documents: askAsTenant(
        url,
        tenant.id,
        `SELECT id, status, coalesce(document_number, '') FROM document ORDER BY id`,
      ).map(([id, status, number]) => ({ id, status, number })),
      users: askAsTenant(url, tenant.id, 'SELECT id FROM "user" ORDER BY id').map(([id]) => id),
      revisions: askAsTenant(
        url,
        tenant.id,
        'SELECT id FROM document_revision ORDER BY id',
      ).map(([id]) => id),
      notifications: askAsTenant(
        url,
        tenant.id,
        'SELECT id, type_key, recipient_id, channel FROM notification_message ORDER BY id',
      ).map(([id, typeKey, recipientId, channel]) => ({ id, typeKey, recipientId, channel })),
    };
  }

  return { tables: tables.length, tenants, perTenant };
}

/**
 * The posture a restored tenant database has to have before anybody is pointed at it.
 *
 * `backup-and-restore.md` §2's own comment is the reason this is asserted rather than assumed:
 * *"a tenant database without RLS is a tenant database the application role can read across"*.
 */
function postureOf(url) {
  const [enabled = '0', forced = '0', total = '0'] = one(
    url,
    `SELECT count(*) FILTER (WHERE c.relrowsecurity),
            count(*) FILTER (WHERE c.relforcerowsecurity),
            count(*)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname NOT IN ('_prisma_migrations', 'tenant')`,
  );
  const roles = ask(
    url,
    `SELECT rolname, rolsuper::text, rolbypassrls::text FROM pg_roles
     WHERE rolname IN ('edms_app', 'edms_owner') ORDER BY rolname`,
  ).map(([name, superuser, bypassRls]) => ({
    name,
    superuser: superuser === 't',
    bypassRls: bypassRls === 't',
  }));

  return {
    rls: { enabled: Number(enabled), forced: Number(forced), total: Number(total) },
    policies: Number(one(url, `SELECT count(*) FROM pg_policies WHERE schemaname = 'public'`)[0]),
    roles,
    // The audit table's targeted revoke, which `02-audit-immutability.sql` applies and which a
    // restore has to carry: the trail is append-only *to the application role* as well as by
    // trigger, and a restored database that granted UPDATE back would be a weaker one.
    auditUpdatable: one(url, `SELECT has_table_privilege('edms_app','audit_event','UPDATE')`)[0]
      === 't',
    appMaySelectDocuments: one(url, `SELECT has_table_privilege('edms_app','document','SELECT')`)[0]
      === 't',
  };
}

// --- 1. The source checkpoint --------------------------------------------------------------------

// Read as **`edms_app`**, on both sides, and the reason is the one `askAsTenant` records: the role
// that owns the schema may or may not also be a cluster superuser, and a superuser bypasses row
// security regardless of FORCE. Reading as the application role asks the only question worth
// asking — *what can this tenant's own connection see?* — and asks it identically of both clusters.
const source = timed('checkpoint-source', () =>
  Object.fromEntries(TENANTS.map((t) => [t.key, checkpointOf(t.sourceAppUrl)])),
);

// --- 2. The backup ------------------------------------------------------------------------------
//
// Custom format, because that is the artefact `backup-and-restore.md` §2 names: its command is
// `pg_restore --create --dbname=postgres edms_acme_base.dump`, and `pg_restore` reads custom or
// directory format rather than plain SQL. One file per tenant database, because under ADR-0015
// there is no "the database" to dump — and because a restore is one customer's, which is the whole
// operational argument for the per-tenant split.

mkdirSync(BACKUP_DIR, { recursive: true });

const artefacts = timed('backup', () =>
  TENANTS.map((tenant) => {
    const file = join(BACKUP_DIR, `${tenant.database}.dump`);
    execFileSync('pg_dump', ['--format=custom', '--file', file, tenant.sourceUrl], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ...tenant, file };
  }),
);

// --- 3. The artefact, verified before anything is restored ---------------------------------------
//
// Because a restore is the wrong moment to discover a truncated dump. `pg_restore --list` is the
// integrity check the format itself provides: it parses the archive's table of contents, so a file
// that is not a readable archive fails here rather than half way through writing a database.

const verifiedArtefacts = timed('verify-artefact', () =>
  artefacts.map((artefact) => {
    const contents = execFileSync('pg_restore', ['--list', artefact.file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entries = contents.split('\n').filter((line) => line !== '' && !line.startsWith(';'));
    return {
      key: artefact.key,
      database: artefact.database,
      file: artefact.file,
      bytes: statSync(artefact.file).size,
      // Recorded rather than checked against anything: there is nothing to compare a first backup
      // to. What it is for is the *next* one — an artefact whose digest is written down cannot be
      // quietly altered between being taken and being restored.
      sha256: createHash('sha256').update(readFileSync(artefact.file)).digest('hex'),
      tableOfContentsEntries: entries.length,
      tables: entries.filter((line) => / TABLE /.test(line)).length,
      tableData: entries.filter((line) => / TABLE DATA /.test(line)).length,
      // The archive's own record of when it was taken, which is the only honest RPO evidence a
      // dump can offer: everything committed after this instant is not in it.
      takenAt: (/Archive created at (.+)/.exec(contents) ?? [])[1]?.trim() ?? null,
    };
  }),
);

// --- 4. The destination, refused unless it is empty -----------------------------------------------
//
// §8's whole point: the rehearsal proves the backup can *recreate* the environment rather than
// overwrite a working one. A destination that already holds one of these databases would let a
// restore appear to succeed against data that was already there.

// `--prepare-destination` is §8's "destroy the test environment", made explicit rather than hidden
// inside whatever calls this. It drops the destination copies of the tenant databases so the
// rehearsal starts from an empty cluster on a second run, and it is a **separate flag** because a
// script that silently dropped databases would be one nobody could safely point at a real cluster.
if (process.argv.includes('--prepare-destination')) {
  for (const tenant of TENANTS) {
    psql(DEST_ADMIN, ['-c', `DROP DATABASE IF EXISTS "${tenant.database}" WITH (FORCE)`]);
  }
}

const occupied = ask(
  DEST_ADMIN,
  `SELECT datname FROM pg_database WHERE datname IN (${TENANTS.map((t) => `'${t.database}'`).join(
    ',',
  )})`,
).map(([name]) => name);

if (occupied.length > 0) {
  console.error(
    `The destination already holds ${occupied.join(', ')}. This rehearsal restores into an EMPTY ` +
      'environment — restoring over an existing database proves that a restore can overwrite, ' +
      'which is not the claim. Drop them or point at a fresh cluster.',
  );
  process.exit(1);
}

// --- 5. The cluster's roles, BEFORE the restore ---------------------------------------------------
//
// The order is the defect this rehearsal found. `backup-and-restore.md` §2 applied
// `infra/sql/cluster/01-roles.sql` at step 2, *after* `pg_restore --create` — and on a genuinely
// empty cluster, which is the disaster case, every `ALTER … OWNER TO edms_owner` and every
// `GRANT … TO edms_app` in the archive then fails against a role that does not exist. `pg_restore`
// reports those as errors and still **exits zero**, so the procedure appears to have worked and
// leaves a database owned by the superuser whose application role cannot connect to it.
//
// Roles first. The file is idempotent, so this is also correct on a cluster that already has them.

timed('cluster-roles', () => psql(DEST_ADMIN, ['-f', join(ROOT, 'infra/sql/cluster/01-roles.sql')]));

// --- 6. The restore -------------------------------------------------------------------------------

const restoreStarted = Date.now();
timed('restore', () => {
  for (const artefact of artefacts) {
    // `--exit-on-error` because the alternative is what step 5's comment describes: a restore that
    // logs failures and reports success. A rehearsal that tolerated errors would be measuring
    // nothing.
    execFileSync('pg_restore', ['--create', '--exit-on-error', '--dbname', DEST_ADMIN, artefact.file], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
});

// --- 7. The per-database SQL and the post-migration gate ------------------------------------------
//
// §2's step 2, and it is not a formality. `apply-post-migrate.mjs` **raises** on a tenant-scoped
// table without row-level security rather than reporting success, so running it against the
// restored copy is how "the policies came across" stops being an assumption.

timed('post-migrate', () => {
  for (const tenant of TENANTS) {
    psql(tenant.restoredOwnerUrl, ['-f', join(ROOT, 'infra/sql/database/01-grants.sql')]);
    execFileSync('node', [join(ROOT, 'scripts/apply-post-migrate.mjs')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: tenant.restoredOwnerUrl,
        DATABASE_MIGRATION_URL: tenant.restoredOwnerUrl,
      },
    });
  }
});
const restoreMs = Date.now() - restoreStarted;

// --- 8. The comparison ----------------------------------------------------------------------------

const restored = timed('checkpoint-restored', () =>
  Object.fromEntries(TENANTS.map((t) => [t.key, checkpointOf(t.restoredAppUrl)])),
);
const posture = Object.fromEntries(TENANTS.map((t) => [t.key, postureOf(t.restoredOwnerUrl)]));

/**
 * Every difference, named — rather than a boolean saying there were none.
 *
 * A comparison that answers "identical" and cannot say what it compared is the comparison an
 * auditor discounts. This one enumerates each tenant, each table and each identity list, so an
 * empty array is a statement about the whole schema rather than about whatever was sampled.
 */
const differences = [];
for (const tenant of TENANTS) {
  const before = source[tenant.key];
  const after = restored[tenant.key];
  const at = (where, what, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      differences.push({ tenant: tenant.key, where, what, source: a, restored: b });
    }
  };

  at('tenant-roll', 'tenants', before.tenants, after.tenants);

  for (const slug of new Set([
    ...Object.keys(before.perTenant),
    ...Object.keys(after.perTenant),
  ])) {
    const a = before.perTenant[slug];
    const b = after.perTenant[slug];
    if (a === undefined || b === undefined) {
      differences.push({ tenant: tenant.key, where: slug, what: 'present', source: a !== undefined, restored: b !== undefined });
      continue;
    }
    for (const table of Object.keys(a.counts)) {
      at(slug, `count:${table}`, a.counts[table], b.counts[table] ?? null);
    }
    at(slug, 'audit-tail', a.audit, b.audit);
    at(slug, 'documents', a.documents, b.documents);
    at(slug, 'users', a.users, b.users);
    at(slug, 'revisions', a.revisions, b.revisions);
    at(slug, 'notifications', a.notifications, b.notifications);
  }
}

const evidence = {
    backupDir: BACKUP_DIR,
    tenants: TENANTS.map(({ key, database, sourceUrl, restoredOwnerUrl, restoredAppUrl }) => ({
      key,
      database,
      // The URLs the restored environment is reached on, so a caller can boot the product against
      // it without reconstructing them.
      sourceUrl,
      restoredOwnerUrl,
      restoredAppUrl,
    })),
    artefacts: verifiedArtefacts,
    source,
    restored,
    differences,
    posture,
  timings: { steps: step, restoreMs, totalMs: Date.now() - started },
};

// Written beside the artefacts as well as printed, because the evidence is what the rehearsal is
// *for*: a caller that parses stdout keeps the numbers only as long as it runs, and §3's record
// — *"Record the result, dated, in docs/reports/"* — needs something a person can open afterwards.
writeFileSync(join(BACKUP_DIR, 'rehearsal.json'), `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
