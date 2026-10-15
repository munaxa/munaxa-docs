# Backup and restore

**Purpose:** what is backed up, what a restore actually does, and the test that is the only thing
making either statement true.
**Audience:** operators, and whoever answers an auditor asking "prove you can recover".

## 1. What is backed up, and what is deliberately not

20 §6's table, as procedures.

| Asset | Method | Retention | RPO | RTO |
| --- | --- | --- | --- | --- |
| PostgreSQL **cluster** (every tenant database in it) | Continuous WAL archiving + nightly base backup — **point-in-time recovery, at cluster level** | 35 days PITR, monthly for 12 months | 5 min | 2 h |
| PostgreSQL, **per tenant database** | Logical dump (`pg_dump --format=custom`, as `edms_backup`) — **restorable per tenant, to the time of the dump** | Per the backup policy (runbook §19) | The dump's time | — |
| Object storage | Versioning + cross-region replication | The tenant's retention policy | 15 min | 4 h |
| Redis | **None** | — | — | Minutes |
| Search index | **None** | — | — | Hours (rebuild) |
| Audit checkpoints | Written to a store the database cannot reach | 7 years | Immediate | Immediate |

**The two PostgreSQL rows are different mechanisms, and they restore different things.** Every tenant
has its own database ([ADR-0015](../architecture/adr/0015-database-per-tenant.md)), but those
databases live in a PostgreSQL cluster, and **WAL-based point-in-time recovery works on the whole
cluster, not on one database in it** — a managed PostgreSQL service likewise recovers a whole
instance. Nothing in this product recovers a single tenant database to a point in time in place.
What *is* per tenant is the logical dump: one tenant's database, restorable on its own, but only to
the moment the dump was taken. §2 gives both procedures.

Two of the rows above are absences with reasons.

**Redis is not backed up because nothing in it is a record.** Queues are fed from the transactional
outbox, which is in PostgreSQL and commits with the change that caused it, so an event not yet
dispatched when Redis is lost is dispatched from its surviving row. The two things that used to
live *only* in Redis are now rebuilt from durable state by the consuming process
(`QueueRecoveryScheduler`): every lane's **cron schedule**, from the declarations each lane derives
from the schedule catalogue at boot, and every **workflow timer** still owed a firing — a
`SCHEDULED` row on a running instance and an active stage — re-armed under its own `job_id`, firing
at once if its moment passed while Redis was gone. That happens at boot, within
`QUEUE_RECOVERY_INTERVAL_MS` of a flush or a failover to an empty replica (the broker carries a
marker key whose absence is the signal), and unconditionally every
`QUEUE_RECOVERY_SWEEP_INTERVAL_MS`. No restart and no manual step is needed. The ACL decision cache
is a cache, and 19 §4's rule is that a cold cache produces identical answers. The per-tenant
concurrency counters expire.

**What a lost Redis does cost.** The deduplication window that makes at-least-once delivery
harmless, so a job that had already run may run again — which is why every consumer in this product
is idempotent on its own row rather than on a queue identifier. And one window that is *not* yet
rebuilt: an outbox row is marked processed when its job is **enqueued**, so a job enqueued but not
yet consumed at the moment of loss — an index projection, a notification, a webhook fan-out, a
preview render — is gone with it. The search index is rebuildable (the next paragraph); the others are not
replayed. Size that window by keeping consumers caught up, and prefer a Redis with persistence
(`--appendonly yes`, as `infra/docker-compose.yml` runs it) so a restart is not a loss.

**The search index is not backed up because it is derived.** Phase 8 built a resumable rebuild that
projects from the document tables into a shadow table and swaps, so it never empties a live index.
Restoring a stale index would be worse than rebuilding: it would answer queries confidently with a
corpus that no longer exists.

## 2. A restore, per tenant

Under [ADR-0015](../architecture/adr/0015-database-per-tenant.md) each tenant has its own database,
so a restore puts back one customer's database without touching anybody else's live database. How
far back it can go depends on which backup it starts from (§1):

- **From a logical dump (§2.1):** that tenant alone, to the time of the dump.
- **To a point in time (§2.2):** the **whole cluster** is recovered to that time in a separate
  recovery environment, and the one tenant's database is extracted from it and restored by §2.1.
  The recovered cluster is temporary; the live cluster and every other tenant's live database are
  not touched ([ADR-0021](../architecture/adr/0021-multi-tenant-hosted-launch.md) §8).

### 2.1 Restoring one tenant from a logical dump

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
#    is the evidence of what went wrong, and restoring onto it destroys it.
#    `--exit-on-error` deliberately: without it a restore that failed half its statements is
#    indistinguishable from one that worked. The dump is a logical backup: this restores the
#    tenant to the time the dump was taken, no later. For a point in time, see §2.2.
pg_restore --create --exit-on-error --dbname="$DEST_ADMIN_URL" edms_acme_base.dump

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
around the procedure: an operator can run it, and a quarterly test is one invocation. It is a
logical restore, not a point-in-time one.

**Step 5 is an edit, not a migration.** A tenant's catalogue entry names its own connection string,
so moving a tenant between databases — or clusters — is a configuration change and a restore. That
is the same mechanism 19 §6's Stage 4 uses to spread tenants across clusters.

### 2.2 Restoring one tenant to a point in time

PostgreSQL's point-in-time recovery replays the WAL of a **whole cluster**, so one tenant is
recovered to a point in time by recovering the cluster and taking that tenant's database out of it:

1. **Recover the cluster to the target time into a separate recovery environment** — a new cluster
   or instance, never the live one. Use the provider's point-in-time restore, or a base backup with
   `restore_command` and `recovery_target_time`. The tooling is
   **[PRODUCTION-SPECIFIC]** ([go-live-runbook.md §19](./go-live-runbook.md)).
2. **Extract the tenant's database** from the recovered cluster as a logical dump, as the backup role
   (`pg_dump --format=custom` as `edms_backup`, which reads through forced row-level security).
3. **Restore that dump by §2.1**, under a new name, beside the live database: roles first, grants and
   post-migration SQL, the audit chain verified, and only then the catalogue entry repointed.
4. **Retire the recovery environment** once the restored database is verified. It holds every
   tenant's data as of the target time and is handled with the same care as production.

Every tenant's data is in the recovered cluster, but only the one tenant's database leaves it. The
time this takes is the time to recover the **whole** cluster plus the time of §2.1, which is what the
recovery rehearsal must measure (§3).

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
2. `audit.verify-chain` walks the restored trail from genesis and reports it intact: the log says "The audit chain verified" for the tenant, and the metric `audit.chain.verified` is recorded with `intact="true"` (a break logs "The audit chain failed verification").
3. The last signed checkpoint before the restore point **recomputes** against the restored rows.
   A checkpoint that does not is the one signal that distinguishes a restore from a rewrite.
4. A sample of documents' blobs re-hash to their recorded checksums — which since Phase 18 is a
   button rather than a script: run one pass of the integrity sweep against the restored tenant
   (`storage.verify-integrity`) and confirm it reports no mismatches.

**The test exercises both restore paths of §2.** A logical restore (§2.1) proves the dump
reconstitutes a tenant. It says nothing about the 5-minute RPO, which only cluster-level
point-in-time recovery provides. So the rehearsal also restores **one tenant to a point in time by
§2.2**: the whole cluster recovered to a target time in a separate environment, that tenant's
database extracted and restored beside the live one, the four conditions above checked on it, and
the time of the whole sequence recorded
([ADR-0021](../architecture/adr/0021-multi-tenant-hosted-launch.md) §8;
[production-infrastructure-implementation.md](./production-infrastructure-implementation.md) 7b).

Record the result, dated, in `docs/reports/`. A quarter with no record is a failed test.

## 4. What has and has not been performed

**Stated plainly, because this document's own §3 says an untested procedure is a hypothesis.**

**§2.1 has now been executed** — Phase 6.10, and the first restore in this repository's history. Two
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
re-hashed. And §1's cluster row is continuous WAL archiving with a 5-minute RPO; what was rehearsed
is the logical restore of §2.1. Point-in-time recovery (§2.2) needs a WAL archive, and an archive
needs a running cluster to have been producing one. Cluster-level recovery to a timestamp was later
exercised in staging — a base backup plus the WAL archive, recovered into a new container with both
tenant databases present
([staging-acceptance-gate-e94c295.md §9](../reports/staging-acceptance-gate-e94c295.md)). **The
rest of §2.2 — extracting one tenant's database from the recovered cluster and restoring it beside
the live one — has not been executed.**

So: **the database restore is verified and the object-storage restore is not.** The RTO in §1 is
still a target rather than a measurement of a production-scale dataset, though it now has a first
number beside it — 20.5 seconds of restore for two small tenant databases, which says the procedure
works rather than that it will finish in two hours.

## 5. The Hetzner template's backups (R-1)

**Status:** implemented in `infra/hetzner/` and drilled **locally** with disposable data (§5.4).
Not run on Hetzner. The off-server copy (§5.5) is built and tested **against a local MinIO
stand-in only**; no provider account, bucket or key exists.

### 5.1 What is taken, and where it goes

| Asset | Method | Encryption | Retention | RPO |
| --- | --- | --- | --- | --- |
| Cluster WAL | `archive_command` → `munaxa-archive-wal`, every segment, forced at least every `archive_timeout` (300 s) when there are writes | `age`, public-key, at write | Back to the oldest kept base backup | ≤ 5 min on the server |
| Cluster base backup | `pg_basebackup -Ft -X fetch --manifest-checksums=SHA256`, nightly (`db-backup`) | `age` | 35 days, newest 2 always kept | — |
| Each tenant database | `pg_dump --format=custom` as `edms_backup`, nightly, plus roles without passwords | `age` | 35 days, newest 2 always kept | The dump's time |
| Off-server copy | `offsite` job (§5.5): every new file copied to a bucket at another provider every 15 minutes, read back and verified; never deletes | inherited (the files are already `age` ciphertext) | the provider's lifecycle rule (§5.5) | ≤ 15 min plus the WAL timeout, for the loss of the whole server |

**Where:**

- `DOCS_BACKUP_DIR`, a filesystem that is not the database's. Both writers refuse the database's
  own filesystem.
- Owned by uid 70, mode 0700.
- Reached only by the `postgres` container (WAL) and `db-backup`, which has no network except the
  private data network.

**Keys:**

- The server holds only `age` public keys (`DOCS_BACKUP_AGE_RECIPIENTS`, at least two holders).
- The identities are offline (key-rotation.md §5).
- `db-backup` refuses to run beside an identity.

### 5.2 Point-in-time recovery of the cluster (then §2.2 for one tenant)

Into a **new** container and volume, never over the live cluster, with an identity brought from
the escrow:

```bash
# 1. Decrypt, extract and verify a base backup older than the target time.
#    restore-base checks the ciphertext's SHA-256, then pg_verifybackup checks every file against
#    the manifest.
docker run --rm --user 70:70 --network none -v recovery:/restore -v "$DOCS_BACKUP_DIR:/backup:ro" \
  -v /path/to/identity:/restore-identity:ro -e BACKUP_AGE_IDENTITY_FILE=/restore-identity \
  "$DOCS_POSTGRES_IMAGE" munaxa-backup restore-base <name|latest> /restore/data

# 2. Recovery settings. The archive is mounted read-only. The identity file must be readable by
#    uid 70 inside the recovery volume.
cat >> /restore/data/postgresql.auto.conf <<'EOF'
restore_command = 'BACKUP_AGE_IDENTITY_FILE=/restore/identity munaxa-restore-wal %f %p'
recovery_target_time = '2026-10-15 19:20:00+00'
recovery_target_action = 'promote'
EOF
touch /restore/data/recovery.signal

# 3. Start it on its own network; wait for pg_is_in_recovery() = false.
docker run -d --user 70:70 --network <isolated> -v recovery:/restore \
  -v "$DOCS_BACKUP_DIR/wal:/backup/wal:ro" --entrypoint postgres "$DOCS_POSTGRES_IMAGE" -D /restore/data
```

**Then:**

- Check §3's conditions on the recovered databases.
- Take out the tenant you need by §2.2 steps 2–4.
- Retire the recovery container and volume, and the identity copy inside it.

`munaxa-restore-wal` refuses a segment whose decrypted digest is not the one recorded at archive
time, so recovery stops rather than replay altered WAL.

### 5.3 One tenant from its dump (§2.1, from the encrypted files)

```bash
munaxa-backup decrypt /backup/dumps/<set>/edms_<slug>.dump.age > edms_<slug>.dump  # checks the digest first
# …then §2.1 from step 1 (roles first, a NEW database name, --exit-on-error, grants and
# post-migration SQL, the chain verified, then the catalogue repointed).
```

### 5.4 The drill: what it proves and what it does not

`infra/hetzner/testing/backup/backup-drill.sh`, run inside the stack test against the real images
with the smoke test's data:

1. a base backup;
2. change A;
3. the target time;
4. change B;
5. the WAL archived.

Then:

- **PITR** into a new container: A present (it came from the WAL), B absent. Each tenant database
  is identical at the target (audit-trail length, last position and digest; users, documents,
  files).
- **Isolation:** row-level security is enabled **and forced** on every tenant-scoped table, and
  `edms_app` is neither superuser nor BYPASSRLS. Each database holds only its own tenant's users.
  As `edms_app`, acme's context sees acme's users and rival's context sees none.
- **The audit hash chain** of the recovered database verifies from genesis with the product's own
  verifier.
- **Recovery to the end of the archive**: A and B both present.
- **One tenant's encrypted dump** restored beside the others under a new name: the same contents as
  at the dump, RLS still forced, its chain verifying.

The drill's results, with timings, are in the readiness report.

Since the off-server copy was built, the drill also copies everything to the stand-in remote (the
test MinIO), fetches it back **from the remote alone** into an empty volume, and runs the same
point-in-time recovery from that copy, with every check above (step 6).

**It does not prove:**

- anything about Hetzner's disks or a Hetzner Volume;
- the off-server copy at a real provider (region, Object Lock, the key's permissions, egress);
- a restore at production size, so no RTO;
- §3's condition 3 (checkpoints in object storage) and condition 4 (blob re-hash). Those belong
  to the object-storage restore, which depends on the provider (D-3).

### 5.5 The off-server copy

**What it is.** `infra/hetzner/offsite/offsite.sh`, run as the `offsite` service (profile `ops`) by
`ops/systemd/munaxa-offsite.timer` every 15 minutes, on the pinned rclone image. It copies the
backup volume — already `age` ciphertext — to a bucket at **another provider** (proposed: Backblaze
B2 EU Central, Scaleway as the alternative; neither verified, see the readiness report §5.1).

**What it guarantees, and how:**

| Property | How |
| --- | --- |
| No key that decrypts anything leaves the offline holders | It copies ciphertext; it refuses to run with an `age` identity in its environment |
| It cannot damage the backups | The volume is mounted read-only; it refuses a writable mount |
| It never deletes or overwrites | `rclone copy --immutable` only, never `sync`, `move`, `purge` or `delete`; an object that exists with other content is a reported problem, never replaced. The credential is meant to lack delete rights too, and the provider's versioning or Object Lock to keep history regardless |
| A half-uploaded backup is never a recovery point | An S3 object exists only once its upload completes. Then every new file is read back: the size from the listing, the provider's MD5 when it has one (an ETag is not an MD5 for multipart uploads, so absence is not treated as a mismatch), and by default the SHA-256 of the bytes downloaded again. Only verified files are recorded, in a run manifest (`manifests/`); a base backup or dump set gets its `COMPLETE` marker — listing every file's size and SHA-256 — only after all its files are verified. `fetch` uses only marked backups and listed WAL, and checks every byte it downloads |
| Interrupted, failed or duplicate runs are safe | A lock lets one run at a time (a second exits doing nothing). A failed or interrupted run leaves files unverified; the next run re-verifies what arrived (no re-upload of identical content) and sends the rest |
| A damaged local file is not spread | A base backup or dump file that no longer matches the digest written beside it is refused and reported |
| Failures are seen | Every run — even one with nothing new to send — confirms that the remote answers and still holds the newest base backup it marked complete; otherwise the run fails. `offsite.prom` (last success, last run, pending files, newest complete base backup); `ops/host-check.sh` reports a failed run, no copy in 2 h, or no complete base backup on the remote |

**Retention on the remote.** The job never deletes; retention is the provider's lifecycle rule,
set in the console when the bucket is created:

- keep every object version for **at least 35 days** (the backup retention) **plus a margin** —
  45 days is proposed — so the oldest local base backup still has its remote copy and WAL;
- with Object Lock (if the provider offers it in the chosen region): a default retention of the
  same length in governance mode, so not even a full credential can remove a version early;
- abort unfinished multipart uploads after 1 day.

Cost grows with the retention: at TEST size (under 50 GB) it is negligible (readiness report §5.5).

**Recovering from the off-server copy** (the server is lost; readiness gates G-2, G-3):

```bash
# On a new host, with offsite.env and an EMPTY directory owned by uid 70. No backup volume needed.
docker run --rm --user 70:70 --read-only --tmpfs /tmp --env-file /etc/munaxa-docs/offsite.env   -e HOME=/tmp -v "$PWD/infra/hetzner/offsite/offsite.sh:/opt/munaxa/offsite.sh:ro"   -v /mnt/recovered-backups:/restore --entrypoint /bin/sh "$DOCS_OFFSITE_IMAGE"   /opt/munaxa/offsite.sh fetch /restore            # or: fetch /restore <base backup stamp>
# It prints which complete base backup it fetched and how many WAL files; every byte matched.
# Then §5.2 with DOCS_BACKUP_DIR=/mnt/recovered-backups (the same layout), and §5.3 for a tenant.
```

`list-remote` shows the complete recovery points without downloading anything.

**When a run reports a problem:**

- *the remote is unreachable*: nothing to do on the server; the next run catches up. Investigate if
  it lasts (provider status, the key, egress).
- *a different object already under a backup's name*: the remote object is not what this server
  wrote. Treat as an incident (another writer, or a damaged upload). The file is not marked; with a
  **separate, privileged** credential, examine the object's versions in the console before removing
  the bad one. Never give the copy job's own key that right.
- *a local file does not match its recorded digest*: the backup volume is damaged. Take a new
  backup (`munaxa-backup once`) and check the disk.

**Tested** (`infra/hetzner/testing/offsite/test-offsite.sh`, against MinIO): configuration
refusals, first copy, multipart verification, idempotent and concurrent runs, an outage with and
without new files and the catch-up, an interrupted run, a foreign object, recovery by `fetch` (newest and named), refusal of a
backup altered on the remote, the key's refused delete, local pruning not propagated, a damaged
local file refused, and no secret in any output. The stack-test drill (§5.4 step 6) recovers a
cluster from the fetched copy. **Not tested:** any real provider.
