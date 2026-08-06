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
# 1. Restore that tenant's database to a point in time, under a NEW name. Never over the live one:
#    the live database is the evidence of what went wrong, and PITR onto it destroys it.
pg_restore --create --dbname=postgres edms_acme_base.dump
psql "$ADMIN_URL" -c "SELECT pg_wal_replay_pause()"   # then recover to the target LSN or time

# 2. Apply the cluster roles and this repository's own post-migration SQL to the restored copy.
#    A restored database has the tables and may not have the policies, depending on how the dump
#    was taken — and a tenant database without RLS is a tenant database the application role can
#    read across.
psql "$RESTORED_ADMIN_URL" -f infra/sql/cluster/01-roles.sql
psql "$RESTORED_ADMIN_URL" -f infra/sql/database/01-grants.sql
node scripts/apply-post-migrate.mjs   # with the restored URL in the catalogue

# 3. Verify the audit hash chain end to end, BEFORE anybody is pointed at it. See §3.

# 4. Repoint the tenant's catalogue entry at the restored database and reload.
#    The identifier in the entry is what routes every request and is never regenerated, so the
#    tenant's rows still address correctly (20 §8).
```

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

Nothing in §2 has been executed against a real deployment, because there is no deployment of this
product — Phase 18 is the phase that makes one possible rather than the phase that made one. The
procedure is written from the mechanisms that do exist and are tested: the migration runner, the
post-migration gate, the chain verifier, the checkpoint store and the integrity sweep are each
exercised by the integration suite against a real PostgreSQL. What is untested is the *sequence*,
and the first execution of it is the first quarterly test rather than an emergency.

The honest reading: this is a procedure with tested components and an untested composition. It is
recorded here rather than discovered by the person performing it.
