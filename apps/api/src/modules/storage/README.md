# Storage module

**Answers:** Where are the bytes, and are they intact?

| | |
| --- | --- |
| **Owns** | FileObject, UploadSession, dedupe, the antivirus gate |
| **Depends on** | — (the StoragePort only) |
| **Binds in core** | Nothing in core. It is the only module that calls `STORAGE_PORT` and `ANTIVIRUS_PORT`. |

## Layers

```text
storage/
├── storage.module.ts   composition for this module
├── domain/                    entities, value objects, pure rules, events — no Nest, no Prisma
├── application/               use cases and the ports this module declares
├── infrastructure/            Prisma repositories and adapters implementing those ports
└── presentation/              controllers, DTOs, OpenAPI decorators, view mappers
```

The dependency rule points inward, and it is enforced by `eslint.config.mjs` at the app root,
not merely described here. Other modules call this one through its **application service** or
react to its **events** — never through its repositories or its Prisma models.

## Events published

| Type | Meaning |
| --- | --- |
| `storage.file-created` | Bytes are stored and checksummed; scanning may still be pending. |
| `storage.scan-completed` | Carries the verdict; only CLEAN makes content reachable. |
| `storage.file-quarantined` | Infected content was isolated and an incident raised. |
| `storage.checksum-mismatch` | Stored bytes no longer match their recorded digest — highest severity. |

## Phase 3 — the port stops refusing

Phase 0.5 established the contracts and bound `STORAGE_PORT` to an adapter that failed naming the
variable that would configure it. Phase 3 is where that changes: **two real drivers**, one upload
path, one download path, and the antivirus gate.

| Driver | For | Built how |
| --- | --- | --- |
| `LOCAL` | A single-server on-premise installation | The filesystem, plus two transfer endpoints |
| `S3` / `R2` | AWS, MinIO, Cloudflare R2, anything S3-compatible | Presigned URLs, SigV4 written out |

Both are bound *underneath* `TenantScopedStorage` in the composition root, so neither contains the
word "tenant" and neither could opt out of isolation if it wanted to
([ADR-0015](../../../../../docs/architecture/adr/0015-database-per-tenant.md)).

### Bytes never pass through the API

The one rule everything here is shaped by. Upload and download are presigned and go
browser-to-store directly, so a 2 GB drawing never occupies an application process
([11-storage-architecture.md §4](../../../../../docs/architecture/11-storage-architecture.md)).

`LOCAL` is the interesting case, because a filesystem has nothing in front of it that understands a
presigned URL. It gets two endpoints of its own — `PUT` and `GET` on `/storage/local` — which do
nothing but stream, and which are authorised by a **signed capability** rather than by a session:
one object, one method, one expiry, signed with the deployment's own key. They are `@Public` for
exactly the reason an object store's presigned URLs need no session, and the token is the credential.

### Nothing is stored to find out it is refused

The type, the size and the content sniff all run **before** a target is issued. The declared type is
checked against the *bytes*, never the extension, so a renamed executable is refused before it costs
anybody a transfer (`17-security-architecture.md` §5).

### The store's answer is the fact; the client's claim is a claim

Bytes land on a **staging key** and move to their content key at completion. The final key *is* the
digest, and the digest is not known until the bytes arrive — writing to the content key on the
client's word would let a client that computes its checksum wrongly overwrite the blob that
legitimately holds that digest, and every integrity check afterwards would report tampering on a
document nobody touched.

Size and digest are read back at completion and compared with what was announced. A mismatch is
refused and the bytes removed.

### The gate has no permissive default

With `AV_DRIVER=NONE` the port refuses, the service catches the refusal, and the verdict is
`SKIPPED` — which is **not** `CLEAN` and therefore not attachable. A development environment can
upload; nothing can pretend the gate ran. The rule is enforced again by a database trigger
(`infra/sql/post-migrate/03-content-gate.sql`), because the use case is not the only thing that ever
writes these rows.

### The server-side half — Phase 9

Three methods on `StoragePort` exist for bytes that have **no client**: `put`, `read` and `list`.
The presigned handshake above exists so a *client's* bytes never pass through the API; these exist
because there is no browser to presign a target for an evidence bundle the server assembled from
its own trail, or for a signed checkpoint.

`put` **streams**, and that is why it arrived rather than `storeDerived` being reused. A thumbnail
is kilobytes, content-addressed, and holding it is free — hashing it first is what names it. A
seven-year evidence export is hundreds of megabytes and unique by construction, so holding it would
contradict the `audit.export` lane's own description ("streamed to storage rather than held in
memory") and content-addressing it would buy a deduplication that can never hit. The filesystem
adapter pipes to a `.partial` and renames; the S3 adapter drives a multipart upload itself, a part
at a time, so memory is one part whatever the artefact's size.

`evidenceKeyFor` is the third root in `content-key.ts`, and the one place content addressing is set
aside — with the reason written beside it. `TenantScopedStorage` scopes all three new methods,
including the *listing prefix*: it is the one call in this port where an absent argument would
otherwise mean "the whole bucket".

### Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| Scanning is synchronous | The outbox dispatcher does not exist yet, so there is nothing to feed a worker. A blob left `PENDING` forever would be one nothing can ever attach | R5 |
| No Azure Blob or GCS adapter | Neither has a customer. Adding one is a class and a `case` in the composition root, which is the claim the port makes | The phase that needs one |
| Multipart completion trusts the client's entity tags | The API never sees the bytes, so it cannot compute them. The store checks them itself and a wrong one fails the completion | Nothing — this is correct |
| No quota accounting | Entitlements are Phase 21's, and a quota with nothing to read is a constant | `POLICY_EVALUATOR` |
| `put` is not resumable | A server-produced artefact has one producer and one attempt; a failed stream aborts the multipart and the job retries from the beginning | The first artefact large enough for a restart to cost real time |
| `read` has no size bound | No object store enforces one on a `GET`, and its only caller reads a few hundred bytes of signed checkpoint | A second caller, which would be the moment to add one |

## Phase 10 — the bytes finally leave

`listUnreferenced` has carried the comment "only retention calls this, and only at a reference
count of zero" since Phase 3, and had no caller. `StoragePort.delete` was reachable and uncalled
outside the upload path. `StorageBlobReaper` is the caller: it binds Retention's `BLOB_REAPER`,
and it is the only code in the product that removes an object from storage.

Two things in it are decisions rather than plumbing.

**The reference count is re-checked inside the deleting transaction, with the row taken
`FOR UPDATE`.** The listing ran earlier, in somebody else's snapshot; a revision attaching the blob
between the two would have moved the count off zero, and deleting the object then is precisely how
a live document loses its content. The re-check is raw SQL because Prisma cannot express
`FOR UPDATE`, and it is the one place in this module that needed to.

**The grace period is why this is not simply "delete at zero".** A delete and the restore that
undoes it are separated by however long somebody takes to notice, so `retention.blobGraceDays`
(default 7) holds the bytes after the last reference goes. It is measured from `updated_at`, which
moves with every reference adjustment — so "unchanged since the cutoff at a count of zero" means
"at zero at least that long", without a second timestamp column nothing else would read.

`expireUploadSessions` is the other half: `storage.sweep-upload-sessions` has been in the schedule
catalogue since Phase 0.5 with nothing to fire it, and it now expires abandoned sessions *and*
removes their staging objects. Removing the object is best-effort per session and logged when it
fails — most abandoned sessions never wrote a byte, so "nothing to delete" is the common answer and
not a fault; a store that is genuinely refusing deletes is what the log makes visible.

## Phase 18 — the rolling verifier, and the audit action that waited eighteen phases

`17-security-architecture.md` §8 has promised *"a rolling verifier plus verification on every
preview fetch; mismatch quarantines and raises an incident"* since Phase 0, and
`13-audit-architecture.md` §2 has carried `INTEGRITY_MISMATCH` with the note *"Phase 18 — the
integrity sweep that would detect one"*. Nothing had ever written that action. This module writes
it now, because this module owns the bytes — the same split as the reaper above: Retention decides
*when* a schedule fires, Storage decides what a checksum means.

`verifyIntegrity` reads a bounded page of blobs back from the store, re-hashes each, and records
the finding on the row. Three things in it are decisions.

**A pass carries no cursor.** The page is ordered by `integrity_checked_at`, ascending, nulls
first — which is the column the pass itself writes. So a blob checked now sorts to the end and the
next call naturally takes the next set, a crashed pass loses nothing, and there is no stored
position for a restore or a failover to disagree with.

**A verified blob writes no audit row.** One chained, retention-governed row per blob per pass to
record that nothing happened would be millions of them; that is 13 §2's argument against auditing
favourites at a far larger scale. The finding lives on the row, where the next pass reads it. Only
a mismatch is an event — an audit row whose **outcome is `FAILED`**, carrying both digests, plus a
domain event that reaches webhooks and any SIEM sink.

**The read is bounded, and a blob too large is marked checked anyway.** `StoragePort.read` answers
with a whole `Buffer` and the port has no streaming read, so an unbounded pass would hold a 2 GB
scan in a background lane's memory. A blob above `STORAGE_INTEGRITY_MAX_BYTES` is skipped — and its
`integrity_checked_at` is stamped even though its status stays `UNVERIFIED`, because without that
stamp the ordering would hand back the same unreadable-to-us blobs on every pass for ever and the
sweep would never reach anything else.

`IntegrityStatus` is deliberately **not** a value inside `ScanStatus`. `INFECTED` means the bytes
are what was uploaded and the upload was hostile — destroy them. `MISMATCH` means the bytes are
*not* what was uploaded — a storage fault or a tampering incident, recovered by a restore.
Collapsing them would make "was our object store corrupted" a question this product cannot answer.

`isReachable` refuses a quarantined blob through the same gate an infected one fails, and **nothing
but a successful re-read clears it**: an operator with a database connection cannot mark a blob
good, because a blob marked good by a human is exactly what the control exists to prevent.
`docs/operations/disaster-recovery.md` §2 is the procedure.

Phase 18 also counts every signed URL this module issues. `MetricName.STORAGE_PRESIGN` is
incremented in `TenantScopedStorage` rather than here — that wrapper is the one place every presign
in the product passes through, which is the same property that makes it the isolation boundary, so
counting there cannot be forgotten by a caller and there is no second signing path to miss.
