# Backup and restore

**Purpose:** what is backed up, what a restore actually does, and the test that is the only thing
making either statement true.
**Audience:** operators, and whoever answers an auditor asking "prove you can recover".

## 1. What is backed up, and what is deliberately not

20 §6's table, as procedures.

| Asset | Method | Retention | RPO | RTO |
| --- | --- | --- | --- | --- |
| PostgreSQL, **per tenant database** | Continuous WAL archiving + nightly base backup | 35 days PITR, monthly for 12 months | 5 min | 2 h |
| Object storage | Versioning + cross-region replication | The tenant's retention policy | 15 min | 4 h |
| Redis | **None** | — | — | Minutes |
| Search index | **None** | — | — | Hours (rebuild) |
| Audit checkpoints | Written to a store the database cannot reach | 7 years | Immediate | Immediate |

Two of those are absences with reasons.

**Redis is not backed up because nothing in it is a record.** Queues are fed from the transactional
outbox, which is in PostgreSQL and commits with the change that caused it — so a lost Redis loses
in-flight jobs and the dispatcher re-enqueues them from rows that survived. The ACL decision cache
is a cache, and 19 §4's rule is that a cold cache produces identical answers. The per-tenant
concurrency counters expire. **What a lost Redis does cost** is the deduplication window that makes
at-least-once delivery harmless, so a restart may redeliver a job that had already run — which is
why every consumer in this product is idempotent on its own row rather than on a queue identifier.

**The search index is not backed up because it is derived.** Phase 8 built a resumable rebuild that
projects from the document tables into a shadow table and swaps, so it never empties a live index.
Restoring a stale index would be worse than rebuilding: it would answer queries confidently with a
corpus that no longer exists.

## 2. A restore, per tenant

Under [ADR-0015](../architecture/adr/0015-database-per-tenant.md) each tenant has its own database,
so a restore is one customer's, to the minute, without touching anybody else's. That is the whole of
the commercial argument for the per-tenant split and it is also the operational one.

```bash
# 1. The cluster's roles FIRST, on the destination — before anything is restored into it.
#    Corrected in Phase 6.10, which found this out by doing it the other way round. `pg_restore`
#    replays `ALTER … OWNER TO edms_owner` and `GRANT … TO edms_app` for every object, and on an
#    empty cluster — which is the disaster case — those roles do not exist yet. Every one of them
#    then fails, and pg_restore STILL EXITS ZERO: the procedure reports success and leaves a
#    database owned by the superuser whose application role cannot even connect. The file is
#    idempotent, so this is also correct on a cluster that already has them.
psql "$DEST_ADMIN_URL" -f infra/sql/cluster/01-roles.sql

# 2. Restore that tenant's database, under a NEW name. Never over the live one: the live database
#    is the evidence of what went wrong, and PITR onto it destroys it.
#    `--exit-on-error` deliberately: without it a restore that failed half its statements is
#    indistinguishable from one that worked.
pg_restore --create --exit-on-error --dbname="$DEST_ADMIN_URL" edms_acme_base.dump
psql "$ADMIN_URL" -c "SELECT pg_wal_replay_pause()"   # then recover to the target LSN or time

# 3. Apply this repository's own per-database and post-migration SQL to the restored copy.
#    A restored database has the tables and may not have the policies, depending on how the dump
#    was taken — and a tenant database without RLS is a tenant database the application role can
#    read across. `apply-post-migrate.mjs` RAISES on a tenant-scoped table without row-level
#    security rather than reporting success, which is what makes this step a check and not a ritual.
psql "$RESTORED_ADMIN_URL" -f infra/sql/database/01-grants.sql
node scripts/apply-post-migrate.mjs   # with the restored URL in the catalogue

# 4. Verify the audit hash chain end to end, BEFORE anybody is pointed at it. See §3.

# 5. Repoint the tenant's catalogue entry at the restored database and reload.
#    The identifier in the entry is what routes every request and is never regenerated, so the
#    tenant's rows still address correctly (20 §8).
```

**Steps 1 to 3 are `scripts/dr-rehearsal.mjs`**, which is the same commands in the same order with
the comparison and the timings recorded. It is the rehearsal §3 asks for rather than a shortcut
around the procedure: an operator can run it, and a quarterly test is one invocation.

**Step 4 is an edit, not a migration.** A tenant's catalogue entry names its own connection string,
so moving a tenant between databases — or clusters — is a configuration change and a restore. That
is the same mechanism 19 §6's Stage 4 uses to spread tenants across clusters.

## 3. The test, which is the only thing that makes any of this real

20 §6: *"Restores are **tested quarterly** into an isolated environment, and the test is only passed
when the audit hash chain verifies end to end after the restore. An untested backup is not a
backup."*

The chain condition is not decoration. Every other check on a restored database — row counts, a
document opening, a search returning — passes just as well on a database that has been silently
altered. The hash chain is the only assertion in this product that a restored trail is the trail
that was taken, and it is checkable because Phase 9 put the checkpoints in a store the database
cannot reach and signed them with a key held in neither.

The test passes when all four hold:

1. The restored database migrates cleanly with `apply-post-migrate.mjs`, which **raises** on a
   tenant-scoped table without row-level security rather than reporting success.
2. `audit.verify-chain` walks the restored trail from genesis and reports `intact`.
3. The last signed checkpoint before the restore point **recomputes** against the restored rows.
   A checkpoint that does not is the one signal that distinguishes a restore from a rewrite.
4. A sample of documents' blobs re-hash to their recorded checksums — which since Phase 18 is a
   button rather than a script: run one pass of the integrity sweep against the restored tenant
   (`storage.verify-integrity`) and confirm it reports no mismatches.

Record the result, dated, in `docs/reports/`. A quarter with no record is a failed test.

## 4. What has and has not been performed

**Stated plainly, because this document's own §3 says an untested procedure is a hypothesis.**

**§2 has now been executed** — Phase 6.10, and the first restore in this repository's history. Two
tenants in two databases were backed up, a fresh PostgreSQL cluster was provisioned empty, the
procedure above was run into it, and the product was booted against the result and driven through a
real browser. The record is
[phase-6.10](../reports/phase-6.10-disaster-recovery-and-notification-verification.md), and what it
proved and did not prove is worth carrying here rather than leaving in a report:

| §3's condition | Result |
| --- | --- |
| 1. Migrates cleanly with `apply-post-migrate.mjs` | **Passed.** RLS enabled *and* forced on all 77 tenant-scoped tables, 77 policies, `edms_app` neither superuser nor `BYPASSRLS` |
| 2. `audit.verify-chain` reports `intact` | **Passed**, run in the restored deployment through the lane it actually runs on |
| 3. The last signed checkpoint recomputes | **Passed**, and visibly: the restored verification resumed *from* the source's signed checkpoint at sequence 19 and verified only the 2 events after it |
| 4. A sample of blobs re-hash to their checksums | **Not performed.** See below |

**What the rehearsal did not cover, and neither should be read as covered.** §1's object-storage row
is versioning and cross-region replication, which is a property of a bucket rather than of this
repository — the checkpoint store was carried across by pointing the restored deployment at the same
storage root, which *models* a replicated bucket rather than exercising one, and no document blob was
re-hashed. And §1's PostgreSQL row is continuous WAL archiving with a 5-minute RPO; what was
rehearsed is the base-backup half. `pg_wal_replay_pause()` and recovery to a target LSN need an
archive, and an archive needs a running cluster to have been producing one.

So: **the database restore is verified and the object-storage restore is not.** The RTO in §1 is
still a target rather than a measurement of a production-scale dataset, though it now has a first
number beside it — 20.5 seconds of restore for two small tenant databases, which says the procedure
works rather than that it will finish in two hours.
