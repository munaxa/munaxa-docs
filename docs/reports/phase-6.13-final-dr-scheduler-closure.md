# Phase 6.13 — Final Disaster Recovery, Scheduler & Production-Evidence Closure

## 1. Executive summary

**Status: PARTIALLY COMPLETE. Recommendation: NO-GO**, on a short and entirely specific list.

**The headline is that combined disaster recovery is now VERIFIED end to end** — the thing four
phases have been circling and none could execute. Two tenants, each with a document whose bytes were
uploaded through the real presigned path, were backed up (database *and* bucket), restored into a
**genuinely empty** PostgreSQL cluster and a **genuinely empty** MinIO, and then served by the real
application. Both documents' content was retrieved through the product's own download path and came
back **byte-identical and digest-identical** to what was uploaded. Cross-tenant access was refused in
both directions, for metadata and for content. The audit chain verified on both restored tenants and
signed new checkpoints into the restored store. Chromium confirmed it from a browser.

That closes the largest carried-forward gap. Three remain, and two of them are the reason for NO-GO:

- **Five scheduled jobs still have no observed effect**, and one — retention disposition — is a
  compliance control in a document-control product.
- **There is still no automated scheduler regression coverage.** The declared-but-inert class of
  defect has now bitten twice (Phase 6.10, Phase 6.12) and nothing yet fails when it recurs.
- **PITR is not implemented.** Not partially: the repository contains no `archive_mode`, no
  `archive_command`, no `wal_level`, no `restore_command` and no backup tool, while
  `20-deployment-architecture.md` §6 documents a 5-minute RPO. That is a production decision, and
  §D forbids me making it silently.

| | Count |
| --- | --- |
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |
| P3 | 0 |

No new defects. This phase found none — which, after five phases that each found one, is itself
worth recording.

## 2. Exact scope

The four categories Phase 6.12 carried forward, plus the R2 question. Nothing else was touched: no
product behaviour changed, no schema, no permissions, no semantics.

## 3. Phase 6.12 carry-forward

| Item | Result |
| --- | --- |
| Combined PostgreSQL + object-storage DR | **VERIFIED** (§§4–9) |
| Five scheduled jobs' effects | **NOT VERIFIED** (§10) |
| Scheduler regression suite | **NOT VERIFIED — not built** (§11) |
| PITR | **NOT IMPLEMENTED** (§13) |
| R2 | **NOT VERIFIED** (§14) |

## 4. Combined DR methodology — VERIFIED

Everything real, and the source state produced by the product rather than seeded:

1. Two tenants seeded; the API booted with `STORAGE_DRIVER=S3` against MinIO from
   `infra/docker-compose.yml`.
2. For each tenant: a real PDF uploaded through `POST /uploads` → presigned `PUT` → `POST
   /uploads/:id/complete`, then a document created through `POST /documents` referencing the
   resulting blob. The upload path is the one Phase 6.12 repaired.
3. Source checkpoint recorded: object keys, byte counts, SHA-256, and the
   document → revision → file_object chain.
4. Database backed up and restored by `scripts/dr-rehearsal.mjs` (the documented procedure).
5. Bucket backed up, verified and restored by `scripts/storage-backup.mjs` — new tooling, §6.
6. The application booted against **both** restored stores.
7. Content retrieved through the real API; bytes and digest compared.
8. Chromium driven against the restored deployment.

**One environment note, recorded rather than hidden.** `AV_DRIVER=NONE`, so a completed upload is
`SKIPPED` rather than `CLEAN` and the content gate correctly refuses to attach an unscanned blob
(`CONTENT_NOT_SCANNED`). The scan verdict was recorded in the fixture exactly as `markClean` does in
the existing integration suites. The refusal itself is real, was left intact, and is worth noting as
a control that works.

## 5. Database restore evidence — VERIFIED

| | |
| --- | --- |
| Artefacts | primary 450,068 B (`af225f9b0b31…`), secondary 382,378 B (`89fc235b3dd2…`), both taken 2026-08-09 12:50:49 UTC |
| Destination | the `initdb`'d cluster on 5442, databases dropped first |
| Comparison | **`differences: []`** — every table of every tenant of both databases, plus audit tail, document roll, user roll, revision roll and notification roll |
| RLS | 77/77 ENABLED, 77/77 **FORCED**, 77 policies |
| Roles | `edms_app` and `edms_owner` both non-superuser, both `NOBYPASSRLS` |
| Audit immutability | `edms_app` still cannot `UPDATE audit_event` |
| Restore duration | **23.1 s** (roles → grants → post-migration gate, both databases) |

## 6. Object-storage restore evidence — VERIFIED

`scripts/storage-backup.mjs` is **new tooling**, and the distinction §14 of the brief asks for is:
`backup-and-restore.md` §1's object-storage mechanism is bucket **versioning plus cross-region
replication** — a provider policy, not something a repository executes. That remains the production
mechanism. This tool does not replace it; it makes a restore *rehearsable*, which is the gap three
phases have recorded. It drives the product's **own** S3 adapter from the build output rather than a
second S3 client, because ADR-0007 §1 allows one storage implementation and Phase 6.12 showed the
checksum handling that makes an object verifiable lives inside it.

| | |
| --- | --- |
| Backup | 2 objects, 118 B, tenants `e2e2c44a6565d` and `e2e4a03d1d2ed`, 84 ms |
| Manifest | key, tenant, byte count and SHA-256 **computed from the bytes as read** |
| `verify` | `intact: true`, `mismatched: []` |
| Destination | a second MinIO container, own volume, port 9010 — **0 objects before restore** |
| Restore | 2 objects, `differences: []`, 148 ms — every object read back and re-hashed through the adapter |
| Refusal | `restore` refuses a destination already holding any manifest key |

## 7. Byte and checksum comparison — VERIFIED

The assertion the whole phase exists for. Retrieved through `POST /documents/:id/content` — the
product's real audited download path — from the restored application against the restored bucket:

| | tenant A | tenant B |
| --- | --- | --- |
| Metadata | `200`, "Recovery subject A" | `200`, "Recovery subject B" |
| Content | `201`, presigned | `201`, presigned |
| Bytes retrieved | 59 | 59 |
| **Bytes equal to original** | **true** | **true** |
| SHA-256 retrieved | `5ceb89cb…b97951` | `0f201dff…185e951` |
| **Digest equal to original** | **true** | **true** |

Database state, object bytes and application references survived **together**.

## 8. Tenant-isolation evidence — VERIFIED

Through the real application, after restore, both directions and both surfaces:

| | Result |
| --- | --- |
| A → B's document (metadata) | `404` |
| B → A's document (metadata) | `404` |
| A → B's content | `404` |
| B → A's content | `404` |

The identifiers are real ones that exist in the other restored database, so these are refusals rather
than absences. Underneath: two databases, RLS forced, and object keys prefixed per tenant by
`TenantScopedStorage` — the restored bucket shows the two prefixes separately.

**Audit-chain continuity — VERIFIED.** Run through the real lane on the restored deployment:
`eventsVerified: 36 / toSequence: 36` and `17 / 17`, both `checkpointed: true`, both
`The audit chain verified`.

## 9. Browser verification — VERIFIED

Real Chromium against the restored deployment: login succeeded against restored credentials; the
restored document's title rendered; **the neighbour's document did not**; the audit timeline rendered
the restored trail.

**Application boot: 2.0 s** against both restored databases and the restored bucket, all
dependencies `UP`.

**RTO/RPO — NOT VERIFIED.** The numbers above are measurements of this rehearsal on two small
tenants. They say the procedure works; they do not say a customer-sized corpus restores inside
`20 §6`'s two hours, and no RPO claim is possible without PITR.

## 10. Five scheduled-job verification results — NOT VERIFIED

The five, identified from Phase 6.11 §8 rather than assumed: `retention.sweep` (disposition),
`notifications.digest-hourly`, `notifications.digest-daily`, `notifications.digest-weekly`,
`notifications.release-batches`. `audit.stream-sinks` remains **NOT VERIFIED — NO CONFIGURED SINK**.

**Not attempted in this phase.** Runway went to Part A, and the honest consequence is that each still
lacks a precondition: a document past its retention date with a disposition due, held messages inside
a digest window, and a closed coalescing window. None was fabricated.

## 11. Scheduler regression suite — NOT VERIFIED

Not built. `apps/api/src/infrastructure/queue/__tests__/job-identifier.integration.spec.ts` (Phase
6.10) still asserts only that the **broker accepts** all twelve derived identifier shapes and that
they stay distinct. That is the narrow guard on the Phase 6.10 P0 and it is real, but it does not
assert that a worker consumed the job or that the intended handler was reached — which is precisely
the distinction §C asks for and this phase did not close.

## 12. BullMQ job-ID compatibility evidence — VERIFIED (carried)

The twelve shapes are accepted, verified against a real broker, and the guard fails naming the shape
that regressed. Unchanged from Phase 6.10 and re-run green here.

## 13. PITR assessment — **NOT IMPLEMENTED (category C)**

Determined by inspection of the whole repository, excluding the phase reports that discuss it:

```
grep -rniE 'archive_mode|archive_command|wal_level|restore_command|recovery_target|
            pg_receivewal|pgbackrest|wal-g|barman'   →  no matches
```

No WAL archiving, no continuous backup, no restore-to-timestamp procedure, no backup tool.
`backup-and-restore.md` §2's two PITR lines assume an archive that nothing creates.

**A production decision is required and is not mine to make.** The architecture documents a 5-minute
RPO (`20-deployment-architecture.md` §6); satisfying it means choosing and operating a mechanism —
managed PostgreSQL with PITR, or pgBackRest/WAL-G with an archive destination and a retention policy.
Until that is chosen, the RPO is **TARGET DOCUMENTED, EVIDENCE NOT VERIFIED**, and no PITR
infrastructure was invented here to make this report greener.

## 14. R2 assessment — NOT VERIFIED

No R2 credentials exist in this environment (`R2_*`/`CLOUDFLARE*` absent; no AWS credentials file).
There is no R2-specific adapter — `S3` and `R2` are the same class differing in endpoint, region and
addressing style. The Phase 6.12 fix uses `x-amz-checksum-sha256` and `x-amz-checksum-mode`, both
part of the S3 API R2 implements, and **no provider branch was added**. MinIO remains VERIFIED; R2
remains NOT VERIFIED, and would be settled by one credentialed run of the existing storage suite.

## 15. Findings by severity

None. No new defect was found by this phase.

## 16. Fixes made

None. No product code changed.

## 17. Tests added

None in this phase. `scripts/storage-backup.mjs` is operator tooling rather than a test; the
combined DR evidence in §§5–9 was produced by executing it and the existing `dr-rehearsal.mjs`
against real infrastructure, and is **not yet protected by an automated suite** — the same weakness
Phase 6.11 recorded about scheduled work, now applying to DR as well.

## 18. Complete gate results

| Gate | Result |
| --- | --- |
| format | clean |
| lint | **0 errors** (7 pre-existing warnings) |
| typecheck | 13/13 |
| unit | web 126 · API 644 (1 skipped) · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| integration | 38 files, **657 passed, 0 skipped** — PostgreSQL 16, two tenant databases, Redis, MinIO (Phase 6.12 run; no product code changed since) |
| build | 9/9 |
| verify:styles | 10/10 |
| visual | 36 passed (Phase 6.12) |
| e2e | 43 passed (Phase 6.12) |
| **combined DR** | **executed and verified — §§5–9** |
| scheduler integration | the job-identifier guard only — §11 |

## 19. Evidence matrix

| Control | Status |
| --- | --- |
| Database backup and restore into an empty cluster | **VERIFIED** |
| Object-storage backup, verification and restore into an empty store | **VERIFIED** |
| Combined restore serving the real application | **VERIFIED** |
| Restored document bytes byte-identical | **VERIFIED** |
| Restored document digest identical | **VERIFIED** |
| Document → revision → file → object references after restore | **VERIFIED** |
| Audit chain continuity after restore | **VERIFIED** |
| Signed checkpoint recomputes after restore | **VERIFIED** |
| Tenant isolation after restore (API, both directions, metadata and content) | **VERIFIED** |
| Browser verification of the restored environment | **VERIFIED** |
| RLS ENABLED + FORCED, role security after restore | **VERIFIED** |
| Cloud upload integrity (MinIO) | **VERIFIED** (6.12) |
| Cloud upload integrity (R2) | **NOT VERIFIED** |
| Eight scheduled jobs' effects | **VERIFIED** (6.11) |
| Five scheduled jobs' effects | **NOT VERIFIED** |
| Audit sink streaming | **NOT VERIFIED — no configured sink** |
| Scheduler regression coverage beyond job identifiers | **NOT VERIFIED** |
| Combined DR protected by an automated suite | **NOT VERIFIED** |
| PITR | **NOT IMPLEMENTED** |
| RTO / RPO at production scale | **NOT VERIFIED** |
| Search projection, workflow timers | **DEFERRED** — event/delay-driven, outside the scheduler inventory |

## 20. Remaining production risks

1. **Retention disposition has never been observed.** In a document-control product this is a
   compliance control, and it is the one unverified schedule whose silence would be discovered by an
   auditor rather than by a user.
2. **No mechanism protects against the declared-but-inert class of defect.** It has occurred twice.
3. **No point-in-time recovery.** A restore returns the environment to the last base backup; the
   documented RPO is unachievable as built.
4. **DR evidence is hand-run.** Everything in §§5–9 is reproducible from committed tooling, and
   nothing fails if it stops working.
5. R2 unproven; digests unverified there.

## 21. Production GO / NO-GO recommendation

**NO-GO** — narrowly, and for reasons that are now specific rather than unknown.

Disaster recovery, tenant isolation, audit integrity, cloud storage integrity and the eight verified
schedules are in good order, and the product's recovery story is materially stronger than any phase
since 6.8 could claim. What blocks a defensible GO is that a compliance-relevant scheduled control
has never been seen to act, and that the product cannot meet the recovery-point objective its own
architecture documents.

## 22. Exact prerequisites for GO

1. **Observe retention disposition end to end** — a document past its retention date, the real
   `retention.sweep` schedule, the expected disposition, the audit row. Then the four notification
   schedules, or an honest NOT VERIFIED with the precondition named.
2. **A scheduler regression suite** that proves each of the thirteen is consumed and its **handler
   reached**, and that cannot pass when a job is accepted but never processed.
3. **A PITR decision, then its implementation and one rehearsal** — or an explicit, recorded
   acceptance that the RPO is the base-backup interval, with `20 §6` amended to say so. Either
   closes it; leaving the documented target unmet does not.
4. **An automated DR rehearsal**, so §§5–9 stop being a thing somebody did once.
5. *(Optional, not blocking)* one credentialed R2 run of the existing storage suite.

Items 1, 2 and 4 are executable work. **Item 3 is a decision, and it is the one thing here that needs
a person rather than another phase.**

## Evidence vocabulary

**IMPLEMENTED** — present in code or configuration, not empirically exercised. **VERIFIED** —
executed against the real system and observed. **NOT VERIFIED** — evidence not obtained; no claim
made. **FAILED** — exercised and did not hold. **BLOCKED** — a real dependency or decision is
missing. **DEFERRED** — intentionally outside this phase.

No claim in this report rests on source inspection alone.
