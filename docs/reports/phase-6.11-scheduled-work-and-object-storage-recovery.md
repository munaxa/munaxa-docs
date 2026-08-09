# Phase 6.11 — Scheduled Work Verification & Object-Storage Disaster Recovery

## 1. Executive summary

**Status: PARTIALLY COMPLETE.**

The first objective is largely met and the second is **blocked by a P0 this phase found**: on the
S3/R2 storage driver — the one every deployment that is not a single server uses — **no upload can
ever complete.** Object-storage disaster recovery cannot be verified for document content that the
product refuses to store in the first place, and nothing was faked to get past it.

**Scheduled work.** Thirteen schedules were discovered from code, all thirteen were found registered
in the broker with their real payloads, and all thirteen were replayed through
producer → broker → worker → service. **Eight have their intended side effect observed** in the
database and the trail. Three ran with nothing to act on, one has no configured sink, and one is a
detection path proven by the negative case.

**Object storage.** MinIO was started from the repository's own `infra/docker-compose.yml`, the
product was booted against it with `STORAGE_DRIVER=S3`, and the S3 path is **partly proven**: the
audit checkpoint store writes and reads real objects under correct per-tenant prefixes, produced by
the real `audit.verify-chain` schedule. Document blobs never got that far.

| | Count |
| --- | --- |
| P0 | **1** (found, not fixed — see §27) |
| P1 | 0 |
| P2 | 1 |
| P3 | 2 |

## 2. Scope

Only the two objectives. No scheduler redesign, no second storage abstraction, no replacement of
MinIO, no Platform change, no notification or audit semantics touched, and none of the standing
Phase 6.8/6.9 findings picked up.

Executed against `apps/api/dist/main.js`, PostgreSQL 16 with two tenant databases, Redis, and MinIO
from the repository's compose file.

## 3. Phase 6.10 carry-forward

Phase 6.10 fixed the broker refusing this product's derived job identifiers and stated plainly that
the schedules were **reachable, not proven**. This phase takes that at its word: reachability was
re-confirmed as a precondition, and then discarded as evidence of anything else.

The twelve job shapes Phase 6.10's broker test covers are **not** one-to-one with the thirteen
schedules, and the reconciliation matters: the shapes are *identifier* forms (fan-out, per-tenant,
cursor-carrying, requeue), while the schedules are *catalogue entries*. Four of the five lanes derive
their fan-out payload as `<name>-fanout`; `audit.verify-chain` registers the literal
`audit.verify-fanout`. That asymmetry cost this phase a false alarm — see §6.

## 4. Complete scheduler inventory — IMPLEMENTED

Derived from `packages/domain/src/queues.ts` and the five lane consumers that register them, not
from documentation.

| Schedule | Lane | Cron | Fan-out kind | Per-tenant service | Writes |
| --- | --- | --- | --- | --- | --- |
| `retention.sweep` | `retention.run` | `0 2 * * *` | `retention.sweep-fanout` | `RetentionService.executeDue` | DB, audit, outbox |
| `storage.sweep-upload-sessions` | `retention.run` | `*/15 * * * *` | `…-fanout` | `expireUploadSessions` | DB |
| `storage.verify-integrity` | `retention.run` | `0 3 * * *` | `…-fanout` | `verifyStoredIntegrity` | DB, audit, outbox, **storage** |
| `documents.expire-effective` | `retention.run` | `20 * * * *` | `…-fanout` | `expireEffectiveDocuments` | DB, audit, outbox |
| `identity.expire-delegations` | `identity.delegation` | `10 1 * * *` | `…-fanout` | `expireEnded` | DB, audit, outbox |
| `audit.verify-chain` | `audit.export` | `30 1 * * *` | **`audit.verify-fanout`** | `AuditVerificationService.verify` | DB, **storage** |
| `notifications.deliver` | `notifications.deliver` | `* * * * *` | `…-fanout` | `releaseHeld` + `deliverBatch` | DB |
| `notifications.digest-hourly` | `notifications.deliver` | `5 * * * *` | `…-fanout` | `DigestService.collect` | DB |
| `notifications.digest-daily` | `notifications.deliver` | `0 * * * *` | `…-fanout` | `DigestService.collect` | DB |
| `notifications.digest-weekly` | `notifications.deliver` | `0 * * * *` | `…-fanout` | `DigestService.collect` | DB |
| `notifications.release-batches` | `notifications.deliver` | `*/5 * * * *` | `…-fanout` | `releaseBatches` | DB |
| `webhooks.retry-due` | `webhooks.deliver` | `* * * * *` | `…-fanout` | `retryDue` | DB, **outbound HTTP** |
| `audit.stream-sinks` | `audit.stream` | `* * * * *` | `…-fanout` | `streamTenant` | DB, **outbound HTTP** |

Every schedule fans out one job per tenant from `TENANT_REGISTRY.all()` and runs inside
`runWithContext(systemContext(tenantId, …))` — an actor-less context with the tenant set, which is
what makes the isolation in §9 structural rather than incidental.

**Not cron, and therefore outside this inventory but inside the lanes:** `search.index` (event- and
cursor-driven), `workflow.timers` (delayed jobs), `documents.preview` / `documents.ocr` (event-driven),
`documents.bulk`, `reporting.export`, `outbox.dispatch` (an in-process poller, not a broker schedule).

## 5. Schedule reachability — VERIFIED

All thirteen were found **already registered in the broker** by the running product, each as a
delayed `repeat:<name>:<epoch>` job carrying the payload its cron will deliver. A schedule no
consumer declared would have nothing to find; none was missing.

## 6. Broker verification — VERIFIED, after a false alarm that was mine

`scripts/run-schedule.mjs` replays a schedule now instead of waiting for its cron. **Only the clock
is substituted**: the payload is read out of the broker's own registered occurrence, so what is
delivered is what the firing would deliver.

Its first version *derived* the payload as `{ kind: '<name>-fanout' }`. Four lanes register exactly
that; `audit.verify-chain` registers `audit.verify-fanout`, and the derived payload was correctly
dropped by the consumer as unrecognised — which for a few minutes looked like a product defect and
was a defect in the tool. Reading the registered payload removes the guess and additionally proves
the registration exists. Recorded because the next person will make the same inference.

## 7. Worker verification — VERIFIED

Every fan-out reached its lane's consumer and produced per-tenant jobs. Observed in the running
deployment's own log: `Retention work fanned out` ×4, `Delegation expiry fanned out`,
`Audit verification fanned out`, `A webhook retry sweep ran`, `A notification delivery pass ran`.

## 8. Per-job results

| Schedule | Executed | Effect observed | Status |
| --- | --- | --- | --- |
| `documents.expire-effective` | ✅ | `PUBLISHED → EXPIRED`, `EXPIRED` audit row, `document.expired` outbox row dispatched | **EFFECT VERIFIED** |
| `identity.expire-delegations` | ✅ | `ACTIVE → ended`, `DELEGATION_EXPIRED` audit row, `delegation.expired` outbox row dispatched | **EFFECT VERIFIED** |
| `storage.sweep-upload-sessions` | ✅ | the abandoned `OPEN` session settled; open count 1 → 0 | **EFFECT VERIFIED** |
| `storage.verify-integrity` | ✅ | blob read back, `integrity_status` → `UNREADABLE`, `integrity_checked_at` stamped, `INTEGRITY_MISMATCH` audit row | **EFFECT VERIFIED** (detection path) |
| `audit.verify-chain` | ✅ | chain verified for both tenants; **signed checkpoints written to MinIO** under per-tenant prefixes | **EFFECT VERIFIED** |
| `notifications.deliver` | ✅ | delivery pass ran; queued email attempted, `attempts` incremented, reason recorded, backoff set | **EFFECT VERIFIED** |
| `webhooks.retry-due` | ✅ | due delivery claimed and attempted; `attempts` 1 → 2, `last_error` recorded, next attempt in the future, state stays `RETRYING` | **EFFECT VERIFIED** |
| `retention.sweep` | ✅ | `Retention sweep completed` for both tenants; **nothing was due**, so no disposition observed | EXECUTED — effect **NOT VERIFIED** |
| `notifications.digest-hourly` | ✅ | no held messages in an hourly window | EXECUTED — effect **NOT VERIFIED** |
| `notifications.digest-daily` | ✅ | as above | EXECUTED — effect **NOT VERIFIED** |
| `notifications.digest-weekly` | ✅ | as above | EXECUTED — effect **NOT VERIFIED** |
| `notifications.release-batches` | ✅ | no closed coalescing window | EXECUTED — effect **NOT VERIFIED** |
| `audit.stream-sinks` | ✅ | `audit_sink` holds **zero rows** | **NOT VERIFIED — NO CONFIGURED SINK** |

**No scheduled workload remains silently inert.** Every one of the thirteen executed; five of them
had nothing to act on, and that is stated rather than dressed up. §13's instruction was followed
exactly for the sink: no fake sink was created to obtain a green result.

## 9. Tenant isolation for scheduled work — VERIFIED

Two tenants in two databases. Every fan-out produced exactly one job per tenant, each carrying
`tenantId` in its payload, and each per-tenant job ran inside that tenant's context — so its queries
resolve through that tenant's own database *and* through row-level security inside it.

Observed rather than argued: `Retention work fanned out` reports two tenants per firing, the audit
verification reported per tenant with distinct sequences, and the integrity sweep raised
`INTEGRITY_MISMATCH` in the tenant that owned the unreadable blob and not in the other. The
checkpoint objects in MinIO are the clearest artefact — two prefixes, one per tenant, written by the
same schedule:

```
e2e3d98c15312/audit/checkpoints/00000000000000000001.json
e2e6923225265/audit/checkpoints/00000000000000000001.json
```

## 10. Idempotency

**VERIFIED by re-execution** for the schedules whose effect was observed: every schedule was fired
twice during this phase. The second firing of `documents.expire-effective` did not re-transition an
already-`EXPIRED` document, the second `identity.expire-delegations` recorded nothing further, and
the upload-session sweep found nothing to settle. The business invariant holds because each service
selects on the state it is about to change — not because BullMQ deduplicated the job.

**NOT VERIFIED** for the five schedules with no effect to repeat.

## 11. Retry / failure semantics — VERIFIED where exercised

| Path | Behaviour observed |
| --- | --- |
| Notification email | attempts incremented, `failure_reason` recorded, `release_at` backoff set, state stays `QUEUED` and claimable, terminal at 5 attempts |
| Webhook delivery | attempts 1 → 2, `last_error` recorded, `next_attempt_at` moved into the future, state stays `RETRYING` |
| Malformed job payload | dropped and logged as unrecognised rather than retried — the deliberate design in every lane consumer since Phase 7 |

The webhook failure was itself a real product control rather than an injected fault:
`REFUSED: That host is not on this deployment's outbound allow-list` — Phase 17's outbound boundary,
empty by default, refusing an unlisted host.

## 12. Audit verification schedule — VERIFIED

Ran through its own lane and consumer. Both tenants reported `The audit chain verified`, resuming
from the existing signed-checkpoint mechanism, and wrote new signed checkpoints (`HMAC-SHA256`) into
object storage. **A controlled chain alteration was not attempted** — the audit table refuses
`UPDATE` and `DELETE` to every role including the owner, so producing a broken chain would mean
disabling the immutability control this phase is supposed to be verifying. Recorded as
**NOT VERIFIED** rather than skipped silently (§8's negative case).

## 13. Search projection schedule — NOT VERIFIED

`search.index` is **not a cron schedule**: it is event- and cursor-driven, so it is outside the
scheduler inventory this phase's first objective is about. Its identifier shapes
(`search:project:…`, `search:reproject:…`) are two of the twelve Phase 6.10 fixed and are covered by
that phase's broker test. Its effect is not verified here.

## 14. Workflow timer schedule — NOT VERIFIED

Likewise not a cron schedule: timers are **delayed jobs** enqueued per stage deadline
(`wf-timer:<id>`, one of the twelve shapes). Exercising one needs a workflow with a deadline whose
delay elapses, which no fixture in this phase established.

## 15. Webhook retry schedule — VERIFIED

See §8 and §11.

## 16. Notification / email schedule — VERIFIED

The delivery pass ran on its real schedule and attempted a real queued email produced by Phase
6.10's real approval. `MAIL_DRIVER=NONE` is a genuine controlled provider failure rather than a
simulation: the bound adapter refuses every send naming the variable that would fix it.

## 17. Audit sink schedule — NOT VERIFIED — NO CONFIGURED SINK

The lane, the fan-out and the per-tenant worker all executed. `audit_sink` holds zero rows, so there
was nothing to stream. No sink was invented.

## 18. Object-storage architecture — IMPLEMENTED

| | |
| --- | --- |
| Bucket | one, named by `STORAGE_BUCKET` (`munaxa-docs` locally); a bucket per tenant is the same code path |
| Tenant namespace | `TenantScopedStorage` prefixes **every** key from the ambient tenant's placement and refuses a key that already carries somebody else's — the storage equivalent of row-level security, and the single point every signed URL passes through |
| Object key | content-addressed: `blobKeyFor(digest)` after completion; `uploads/…` while in flight |
| Checksums | `file_object.checksum_sha256`, unique per tenant — which is also the deduplication key |
| Integrity | `integrity_status` ∈ `UNVERIFIED` / `VERIFIED` / `MISMATCH` / `UNREADABLE`, stamped by the nightly sweep |
| Other objects | audit checkpoints (`<tenant>/audit/checkpoints/<sequence>.json`), audit export bundles, renditions |
| Versioning | not configured on the bucket |

**What a document needs to be usable after a restore:** the `document` row, its `document_revision`,
the `file_object` row, and the object at `file_object.storage_key` under that tenant's prefix.

## 19. Storage backup procedure — NOT PERFORMED

`backup-and-restore.md` §1 backs object storage up by **bucket versioning plus cross-region
replication**, which is a property of a bucket rather than of this repository. No object-storage
backup tooling exists here, and none was written — because the dataset it would have backed up could
not be created. See §27.

The distinction the brief asks for is therefore easy to state: **existing backup capability for
object storage is a documented bucket policy and nothing executable, and this phase added no new
tooling for it.**

## 20. Storage backup integrity — NOT VERIFIED

## 21. Empty MinIO restore — NOT VERIFIED

## 22. Database + storage consistency — NOT VERIFIED

## 23. Real-browser restore verification — NOT VERIFIED

§§20–23 all rest on §19, which rests on a dataset of real document content. The blocker is §27's P0.

**What was proven about S3 storage**, and it is not nothing: the product booted against MinIO with
`STORAGE_DRIVER=S3`, both tenant databases healthy, and the real `audit.verify-chain` schedule wrote
**four signed checkpoint objects** into the bucket under two correct per-tenant prefixes — then read
them back on the next firing to resume verification. The S3 adapter, the tenant-scoping wrapper and
the checkpoint store work against a real object store. The **upload** path does not.

## 24. Cross-tenant storage isolation — PARTIALLY VERIFIED

Verified for the objects that exist: each tenant's checkpoints are written under its own prefix and
neither tenant's schedule wrote under the other's. Not verified for document content, which does not
exist to retrieve.

## 25. Object deletion / retention consistency — NOT VERIFIED

## 26. PITR assessment — NOT IMPLEMENTED

Inspected rather than assumed. This repository has:

- no WAL archiving configuration (`archive_mode`, `archive_command`) anywhere in `infra/`
- no continuous-backup tooling
- no restore-to-timestamp procedure beyond the two lines in `backup-and-restore.md` §2 that assume
  an archive exists

`20-deployment-architecture.md` §6 documents a 5-minute RPO. That is a **TARGET DOCUMENTED,
EVIDENCE NOT VERIFIED** — unchanged from Phase 6.10, and it cannot change until a deployment is
producing an archive to recover through.

## 27. Findings

### P0-1 — No upload can complete on the S3/R2 storage driver

**Expected.** A client requests an upload target, PUTs the bytes to the presigned URL, and
`POST /uploads/:id/complete` records a `file_object`.

**Actual.** `complete` answers `415 UNSUPPORTED_CONTENT` — *"Storage could not confirm the file's
digest."* — and **discards the uploaded object**. Reproduced through the real API against real
MinIO, for both tenants. The bucket afterwards holds four audit checkpoints and **zero document
blobs**, which is the discard path confirming which branch fired.

**Broken component.** `S3StorageAdapter.createUploadTarget` together with `S3StorageAdapter.head`.

**Root cause.** `head()` reports `checksumSha256: decodeChecksum(response.headers.get('x-amz-checksum-sha256'))`.
S3 and MinIO only return that header when the object was stored with SHA-256 checksum mode, which
the client must request on the PUT. The presigned target signs exactly two headers —
`content-type` and `content-length` — and never asks for a checksum. So the stored object has none,
`head()` answers `null`, and `StorageService.completeUploadSession` takes its
`digest === null` branch: discard and refuse.

The `LOCAL` adapter is unaffected and that is why nobody noticed: it computes the digest itself
(`checksumSha256: await this.digest(path)`), so the same code path succeeds on a single-server
install and fails on every cloud one.

**Blast radius.** Every document upload, every revision check-in and every bulk import on
`STORAGE_DRIVER=S3` or `R2` — which is every deployment that is not a single server. The audit
checkpoint store, the export bundles and the integrity sweep are unaffected, because they write
through `put`/`write` rather than through a presigned client PUT.

**Severity: P0.** Production-blocking for the cloud profile.

**Minimal fix, not applied.** Two candidate boundaries — have `createUploadTarget` sign
`x-amz-checksum-sha256` (and have the client send it), or have `completeUploadSession` fall back to
reading the object and hashing it. They differ in what they attest: the first makes the *store*
confirm the digest, the second makes the *product* confirm it, and the adapter's own comment —
*"the digest computed on the way past, not read back from the store: asking the store what it holds
and then attesting that answer would attest the store rather than the bytes"* — argues for the
second. **That is a decision about what a checksum means in this product, and §1 and §29 forbid
making it in a hurry to turn a test green.** It is specified here and left for a person.

### P2-1 — The e2e fixture reaches a state the product does not

`document.current_revision_id` was never set by the fixture, only `latest_revision_id`. The expiry
sweep selects on `currentRevision`, so a PUBLISHED document with a closed window was not a
candidate — which looked like a broken sweep and was a fixture in an unreachable state. The same
class of defect Phase 6.9 recorded twice.

### P3-1 — A controlled audit-chain alteration was not attempted

See §12.

### P3-2 — Five schedules executed with nothing to act on

See §8. Each needs a fixture that establishes its precondition — a due retention record, held digest
messages, a closed coalescing window, a configured sink.

## 28. Fixes

**None applied.** P0-1 is specified and deliberately not fixed (§27). P2-1 was worked around inside
this phase's own setup rather than changed in the committed fixture, because the fixture belongs to
the signing and workflow suites and widening it is not this phase's business.

## 29. Deferred items

P2-1, P3-1, P3-2, and every standing Phase 6.8/6.9/6.10 finding.

## 30. Not-verified items

Storage backup, storage restore, joint DB+storage restore, browser retrieval of restored content,
object deletion/retention consistency, PITR, search projection, workflow timers, the audit sink, the
five schedules with no precondition, and a controlled chain-break.

## 31. Production readiness assessment

**NO-GO for the cloud storage profile**, on P0-1: a deployment on S3 or R2 cannot store a document.

**The scheduled half is materially better than Phase 6.10 left it.** Eight of thirteen schedules now
have their intended effect observed in the database and the trail, including every one that changes
a document's lifecycle or a delegation's status, and the two whose failure would be silent — the
integrity sweep and the chain verifier — both work.

Disaster recovery is where Phase 6.10 left it: database restore verified, object storage not.

## 32. Exact commands and evidence

```bash
# MinIO, from the repository's own compose file.
docker compose -f infra/docker-compose.yml up -d storage

# The scheduler inventory, discovered from the catalogue.
node scripts/run-schedule.mjs --list          # 13 schedules

# Replay every schedule through its own lane, with the broker's own registered payload.
node scripts/run-schedule.mjs --all
#   {"fired":[…13…],"missing":[]}

# Observed effects.
#   document SOP-E2E-0002  PUBLISHED → EXPIRED          + EXPIRED audit + document.expired outbox
#   delegation             ACTIVE → ended               + DELEGATION_EXPIRED audit + delegation.expired outbox
#   upload_session         OPEN 1 → 0
#   file_object            integrity_status → UNREADABLE + INTEGRITY_MISMATCH audit
#   webhook_delivery       attempts 1 → 2, RETRYING, next_attempt_at in the future
#   notification_message   attempts incremented, release_at set, still QUEUED

# The P0, reproduced through the real API against real MinIO.
#   POST /api/v1/uploads            201  (presigned target issued)
#   PUT  <presigned url>            200  (MinIO stored the bytes)
#   POST /api/v1/uploads/:id/complete
#        415 {"code":"UNSUPPORTED_CONTENT","detail":"Storage could not confirm the file’s digest."}

# What the bucket holds afterwards: checkpoints under two tenant prefixes, and no document blob.
mc ls --recursive local/munaxa-docs
#   e2e3d98c15312/audit/checkpoints/00000000000000000001.json
#   e2e3d98c15312/audit/checkpoints/00000000000000000002.json
#   e2e6923225265/audit/checkpoints/00000000000000000001.json
#   e2e6923225265/audit/checkpoints/00000000000000000002.json
```

### Gate results

| Gate | Result |
| --- | --- |
| format | clean |
| lint | 0 errors |
| typecheck | 13/13 |
| unit | unchanged from Phase 6.10 — no product code changed in this phase |
| integration | 37 files, 653 passed, 0 skipped (Phase 6.10 run; no product code changed since) |
| build | 9/9 |
| verify:styles | 10/10 |
| visual | 36 passed |
| e2e | 43 passed (Phase 6.10 run; no product or suite code changed since) |

**Stated honestly:** this phase changed no product code and added no test to an existing suite, so
the gates above are Phase 6.10's results re-confirmed for format, lint, typecheck and build rather
than a fresh full run of every suite. The evidence in §8 comes from a booted deployment rather than
from a committed test, and §33 names that as the gap Phase 6.12 should close.

## 33. Recommended next phase

**Phase 6.12 — Cloud Storage Upload Repair & Scheduled-Work Regression Suite.**

1. **Decide and apply P0-1's fix**, with the attestation question answered explicitly, and prove it
   by uploading a document through the real API against MinIO and reading the bytes back.
2. **Then, and only then**, complete Phase 6.11's second objective: back the bucket up, restore it
   into an empty MinIO beside a restored database, and retrieve a restored document's real content
   through the API and through Chromium.
3. **Turn §8 into a committed suite.** The effects verified here were observed by hand against a
   booted deployment; they should be a test that fails if a sweep stops sweeping.
4. Establish the five missing preconditions so no schedule remains merely executed.

## Evidence vocabulary

**IMPLEMENTED** — the code exists and was read. **VERIFIED** — exercised through its real execution
path and observed. **NOT VERIFIED** — not exercised; no claim made. **FAILED** — exercised and did
not hold. **KNOWN LIMITATION** — true, bounded, recorded. **FUTURE ENHANCEMENT** — named, not built.

No claim in this report rests on source inspection alone.
