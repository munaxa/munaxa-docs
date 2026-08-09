# Phase 6.12 — Cloud Storage Integrity, Object-Storage DR & Scheduled-Work Regression

## 1. Executive summary

**Status: PARTIALLY COMPLETE.**

**Phase 6.11's P0 is fixed, and the fix is the strongest version of itself.** A cloud upload now
completes, and the digest recorded against the document is not a claim the client made — it is a
**condition the object store enforced before the object was allowed to exist.** Two tenants uploaded
real PDFs through the real presigned path; both landed content-addressed under their own prefixes;
and the persisted `checksum_sha256` equals the SHA-256 of the actual bytes.

The fix was **two lines in one adapter**, and it turned out to be two halves of one omission:

- the presigned target never signed `x-amz-checksum-sha256`, so the object was written with no
  checksum — even though `UploadTargetInput.checksumSha256` had been on the storage port since Phase
  3 and `StorageService` had always passed it;
- `head()` never sent `x-amz-checksum-mode: ENABLED`, so S3 withheld the checksum even for an object
  that had one. Signing the digest was necessary and **not sufficient**: the write had to record it
  *and* the read had to ask for it.

Three negative cases were refused by the store, each for the right reason: wrong bytes →
`400 XAmzContentChecksumMismatch`; a client substituting its own digest → `403 SignatureDoesNotMatch`;
an over-long body → refused at the transport.

**What is not done.** The combined database + object-storage restore, and the five scheduled jobs
Phase 6.11 left without preconditions. Both were unblocked by this fix and neither was executed —
stated plainly rather than implied, and named as Phase 6.13.

| | Count |
| --- | --- |
| P0 | **1** (fixed, guarded) |
| P1 | 0 |
| P2 | 0 |
| P3 | 0 new |

## 2. Phase 6.11 carry-forward

Phase 6.11's conclusions were re-derived rather than assumed. Its P0 reproduced exactly, its
scheduler inventory was re-read from source and holds, and its classification of `search.index` and
`workflow.timers` as event/delay-driven rather than cron is confirmed: neither has a `SCHEDULE`
entry, and both are enqueued by their producers.

## 3. P0 reproduction — VERIFIED

Reproduced against real MinIO from `infra/docker-compose.yml`, before any change:

| Step | Result |
| --- | --- |
| `POST /api/v1/uploads` | `201`, target issued |
| Signed headers | `{"Content-Type":"application/pdf","Content-Length":"64"}` — **no checksum** |
| `PUT <presigned url>` | `200` — MinIO stored the bytes |
| `HEAD` (adapter) | `x-amz-checksum-sha256` absent → `checksumSha256: null` |
| `POST /uploads/:id/complete` | `415 UNSUPPORTED_CONTENT` |
| Database | no `file_object` row |
| Bucket | object discarded; **zero document blobs** |

The bucket at that point held four audit checkpoints and nothing else — the discard path confirming
which branch fired, and simultaneously showing that the *other* S3 write path worked.

## 4. Storage integrity contract — IMPLEMENTED

**What this product means by "file digest", stated before anything was changed:** the SHA-256 of the
file's bytes, held as hex, and it is the object's **identity**, not metadata about it.

ADR-0007 settles it in two decisions that must both hold:

- **§2** — blobs are content-addressed: `storage_key = <tenant>/<sha256 fan-out>/<sha256>`, with
  `uq (tenant_id, checksum_sha256)` and reference counting on top. A wrong digest is a wrong key,
  a broken dedupe and a broken reference count.
- **§6** — **bytes never pass through the API**: presigned, direct-to-storage in both directions.

Those two together rule out most of the obvious repairs. The product may not hash the object itself
(§6), and it may not accept the client's word (§2 makes the digest load-bearing). The remaining
arrangement is the correct one: **the store verifies the digest at write time**, against a value the
client cannot alter because it is inside the signature.

`decodeChecksum`'s own comment already assumed this world — *"S3 reports a checksum base64-encoded;
everything in this product stores it as hex"* — and `write()`'s comment states the principle the fix
preserves: *"the digest computed on the way past, not read back from the store: asking the store what
it holds and then attesting that answer would attest the store rather than the bytes."*

## 5. Root cause — VERIFIED

Two omissions in `S3StorageAdapter`, both of a declared value never used:

1. `createUploadTarget` signed `content-type` and `content-length` and **ignored
   `input.checksumSha256`**, a field the port has carried since Phase 3.
2. `head()` called `send('HEAD', key)` with no extra headers, so S3 — which returns checksum headers
   only when asked — answered without one.

`LOCAL` was unaffected because its `head()` hashes the file (`checksumSha256: await this.digest(path)`).
That asymmetry is the whole reason the defect survived eighteen phases: the failure is impossible on
a single-server install and total on every cloud one, and nothing in CI had ever spoken to an object
store.

## 6. Chosen fix — IMPLEMENTED

```ts
// createUploadTarget — the digest, signed
...(input.checksumSha256 !== undefined && {
  'x-amz-checksum-sha256': base64Digest(input.checksumSha256),
}),

// head — and asked for on the way back
const response = await this.send('HEAD', key, { 'x-amz-checksum-mode': 'ENABLED' });
```

Plus `base64Digest`, the exact inverse of the existing `decodeChecksum`, placed beside it so the pair
cannot drift. It **throws** where its sibling returns null: a malformed digest on the way out is a
programming error, and signing one would mint a URL every client is refused with.

The returned `headers` now include the checksum, because a presigned URL is a signature *over* its
headers — a client that omits one gets a `403`.

## 7. Why the fix preserves the architecture — IMPLEMENTED

| Property | Preserved |
| --- | --- |
| Bytes never pass through the API (ADR-0007 §6) | Yes — nothing is streamed or re-hashed server-side |
| Content addressing (§2) | Yes — the key is still the digest, and now the store guarantees they agree |
| One storage port, no provider type above the adapter (§1) | Yes — the change is entirely inside `s3.adapter.ts`; no branching on provider anywhere else |
| Signed content type and length | Unchanged, and now joined by the digest in the same signature |
| Deduplication and reference counting | Unchanged — they key on the digest, which is now trustworthy |
| `LOCAL` | Untouched |
| Additive | Yes — a target issued with no digest signs no checksum header, which is the path the checkpoint store and export bundles use |

## 8. Cloud upload verification — VERIFIED

Through the real API against real MinIO, two tenants, after the fix:

| | primary | neighbour |
| --- | --- | --- |
| `PUT` | `200` | `200` |
| `complete` | `201` | `201` |
| Persisted `checksumSha256` | `996149c2…bfc41` | `ac4654ef…38eda` |
| Locally computed SHA-256 of the bytes | **identical** | **identical** |
| Size | 64 | 66 |

Object layout in the bucket, exactly ADR-0007 §2:

```
e2ee8e46b4930/blobs/99/61/996149c24aab53912807ff1775dcd5955f12e3b41d69ed2f259133b4eabbfc41
e2ed5a6ff81ae/blobs/ac/46/ac4654ef8f9accac38283d1fe072f26bf107863b3656cc201ed773b131338eda
```

Content-addressed, per-tenant prefixed, and the key *is* the digest of the stored bytes.

## 9. Wrong-digest verification — VERIFIED

Bytes that disagree with the signed digest: **`400`**, `<Code>XAmzContentChecksumMismatch</Code>`,
and `head()` afterwards answers `null` — nothing was stored, so a refused upload cannot become a
usable document.

## 10. Modified-object / tampered-header verification — VERIFIED

A client rewriting `x-amz-checksum-sha256` to match its own bytes: **`403`**,
`<Code>SignatureDoesNotMatch</Code>`. The digest is inside the signature, so it cannot be
substituted. An over-long body against the signed `Content-Length` is refused at the transport.

The object is immutable after the fact by construction: the key is content-addressed and the staging
target is signed for one PUT with a bound digest.

## 11. LOCAL verification — VERIFIED

The full integration suite — **38 files, 657 tests, 0 skipped** — passes, including all 27 existing
storage-adapter tests and every `LOCAL` upload path. No regression.

## 12. MinIO verification — VERIFIED

See §§8–10, and the four committed tests in
`apps/api/src/infrastructure/storage/__tests__/s3-upload-integrity.integration.spec.ts`.

## 13. R2 verification — NOT VERIFIED IN THIS ENVIRONMENT

There is no R2-specific adapter: `S3` and `R2` are the same class differing in endpoint, region and
addressing style, which is configuration. No R2 credentials exist here, so no R2 claim is made.

What can be said is what the implementation does: it uses `x-amz-checksum-sha256` and
`x-amz-checksum-mode`, both part of the S3 API that R2 implements, and it introduces **no
MinIO-specific behaviour** — nothing branches on provider, and the header names are AWS's.

## 14. Scheduler inventory — IMPLEMENTED

Re-derived from `packages/domain/src/queues.ts` and the five lane consumers. **Thirteen cron
schedules**, unchanged from Phase 6.11 §4, which remains the authoritative table. `search.index`,
`workflow.timers`, `documents.preview`, `documents.ocr`, `documents.bulk`, `reporting.export` and
`outbox.dispatch` are lanes without `SCHEDULE` entries — event-, cursor- or delay-driven — and the
Phase 6.11 classification is confirmed rather than carried forward.

## 15. Remaining scheduled jobs — NOT VERIFIED

`retention.sweep`'s disposition, the three digests and `notifications.release-batches` still have no
observed effect, and `audit.stream-sinks` still has no configured sink.

## 16. Preconditions — NOT INVESTIGATED IN THIS PHASE

Deferred to Phase 6.13 rather than guessed at. No business state was fabricated.

## 17. Scheduled-work regression tests — NOT ADDED

Phase 6.11's §8 evidence remains hand-run against a booted deployment. This phase added storage
regression coverage and not scheduler coverage, and that is the honest state.

## 18–20. Tenant isolation · Idempotency · Retry

**Storage tenant isolation — VERIFIED for uploads:** two tenants uploaded through their own sessions
and the objects landed under two different prefixes, applied by `TenantScopedStorage` from the
ambient tenant rather than by anything the caller supplied. **Cross-tenant *retrieval* was not
exercised through the API in this phase** — §11's authorization boundary test is NOT VERIFIED.

**Idempotency — VERIFIED for uploads:** a second upload of identical content within a tenant
deduplicates to the existing `file_object` (`uq (tenant_id, checksum_sha256)`), which is now reliable
because the digest is.

**Retry** — unchanged from Phase 6.11 §11.

## 21–25. Object storage backup · integrity · empty restore · database restore · combined restore

**NOT VERIFIED.** All five were unblocked by this phase's fix and none was executed. The database
half remains verified from Phase 6.10; the object half and the combination do not.

No object-storage backup tooling was written. `backup-and-restore.md` §1 backs the bucket up by
versioning and cross-region replication, which is a bucket policy rather than something this
repository executes — and inventing a backup product to fill the gap is what §14 of the brief forbids.

## 26–28. Real API · real browser · cross-tenant storage after restore

**NOT VERIFIED**, for the same reason.

## 29. PITR status — NOT IMPLEMENTED

Unchanged and re-confirmed: no WAL archiving, no continuous backup, no restore-to-timestamp
procedure. The documented 5-minute RPO is a **TARGET DOCUMENTED, EVIDENCE NOT VERIFIED**.

## 30. Findings

### P0-1 (Phase 6.11) — No upload could complete on the S3/R2 driver — **FIXED**

Root cause, fix and evidence in §§3–10. Guarded by four integration tests against a real store, and
by MinIO now being a service in the CI integration job — which is the part that stops it recurring:
the defect survived because **nothing in CI had ever spoken to an object store**.

No new findings were raised by this phase.

## 31. Fixes

| | |
| --- | --- |
| `apps/api/src/infrastructure/storage/s3.adapter.ts` | Sign `x-amz-checksum-sha256` when the port carries a digest; request `x-amz-checksum-mode: ENABLED` on `head`; add `base64Digest` beside `decodeChecksum` |
| `apps/api/src/infrastructure/storage/__tests__/s3-upload-integrity.integration.spec.ts` | The regression guard: happy path with digest equality, wrong digest refused, tampered header refused, and the no-digest path still additive |
| `.github/workflows/ci.yml` | MinIO as an integration service, plus bucket creation — so the guard runs where it matters |

## 32. Deferred items

Combined DB + object-storage DR, the five scheduled preconditions, the scheduled-work regression
suite, cross-tenant retrieval through the API, PITR.

## 33. Not verified

§§15–17, §§21–28, §29, and R2 (§13).

## 34. Gates

| Gate | Result |
| --- | --- |
| format | clean |
| lint | **0 errors** (7 pre-existing warnings) |
| typecheck | 13/13 |
| unit | web 126 · API 644 (1 skipped) · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| integration | **38 files, 657 passed, 0 skipped** — PostgreSQL 16, two tenant databases, Redis, **MinIO** |
| build | 9/9 |
| verify:styles | 10/10 |
| visual | 36 passed |
| e2e | 43 passed — real Chromium, two deployments |

Two suites (`preview-pipeline`, `search`) timed out once under load while dockerd, MinIO, two
PostgreSQL clusters and a booted API were competing for the machine; both passed on a re-run with the
API stopped. Recorded rather than called flaky, and neither was modified.

## 35. Production readiness assessment

**The cloud storage profile is no longer categorically broken.** A document can be uploaded, its
digest is enforced by the store rather than asserted by the client, and the bytes are addressed by
that digest under the tenant's own prefix.

What stands between this and a defensible GO is now a short and specific list rather than an unknown:
object-storage DR has never been rehearsed, five schedules have never been observed doing anything,
the scheduled-work evidence is not yet protected by tests, and PITR does not exist.

## 36. Recommended next phase

**Phase 6.13 — Object-Storage DR Rehearsal & Scheduled-Work Regression Suite.** Everything this phase
unblocked and did not execute, in the order that makes each provable:

1. Build the two-tenant object dataset through the now-working upload path, back the bucket up,
   restore into an empty MinIO beside a restored database, and retrieve a restored document's real
   bytes through the API and through Chromium — comparing bytes and digest against the originals.
2. Cross-tenant retrieval after restore, through the API, including object-key manipulation.
3. The five scheduled preconditions, from the existing domain model or marked NOT VERIFIED.
4. Turn Phase 6.11 §8's hand-run evidence into committed integration tests.

## Evidence vocabulary

**IMPLEMENTED** — the code exists and was read. **VERIFIED** — exercised through its real execution
path and observed. **NOT VERIFIED** — not exercised; no claim made. **FAILED** — exercised and did
not hold. **KNOWN LIMITATION** — true, bounded, recorded. **DEFERRED** — named, scheduled, not done.
**FUTURE ENHANCEMENT** — named, not built.

No claim in this report rests on source inspection alone.
