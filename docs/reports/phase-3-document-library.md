# Phase 3 — Document Library: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Document Library phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 4 and after, and whoever audits what Phase 3 claimed.

Phase 2 built every place a document would go and every policy it would be created under, and said
plainly that nothing lived in any of them. Phase 3 is where a customer's own content enters the
product for the first time: bytes are stored, a controlled record is created from them, and the
library it sits in can be navigated.

The phase's real risk was named before it started, and it was the right one to name.

## 1. The storage adapter, which had no precedent

Everything else in Phase 3 had a shape to follow somewhere in the repository. Storage did not:
`STORAGE_PORT` was declared in Phase 0.5, wrapped in tenant scoping in Phase 2.5, and bound to an
adapter that refused every call. Nothing had ever stored a byte, and — more to the point — nothing
had ever run `TenantScopedStorage` against anything but a spy.

Two drivers were built.

| Driver | For | Shape |
| --- | --- | --- |
| `LOCAL` | A single-server on-premise installation | The filesystem, plus two streaming endpoints |
| `S3` / `R2` | AWS, MinIO, Cloudflare R2 | Presigned URLs, SigV4 |

Both are bound **underneath** the tenant scoping in the composition root. Neither contains the word
"tenant", which is the check that the isolation Phase 2.5 built is inherited rather than
re-implemented.

### Signature Version 4 is written out rather than pulled in

"Use the SDK" is the usual answer and it was rejected deliberately. What this adapter needs from S3
is five operations; the v3 SDK plus its presigner is tens of megabytes of dependency, a middleware
stack, and a credential-provider chain that will happily read an instance metadata endpoint this
product never intended to talk to. Signing is a hash chain and a canonical string — about a hundred
lines, precisely specified, and **AWS publishes test vectors for it**.

That last part is the argument. `sigv4.spec.ts` asserts the derived signing key against the value in
AWS's own documentation for the documented example credential. A dependency whose behaviour cannot
be pinned to a published vector has to be trusted; this can be checked.

The failure mode that check exists for is real and specific: `encodeURIComponent` leaves `!'()*`
unescaped and S3 escapes them, so a key containing an apostrophe — `O'Brien contract.pdf` is an
ordinary filename — signs one way and requests another. It is four characters and it is the classic
hand-rolled-SigV4 defect.

### The `LOCAL` driver needed two endpoints, and they are the one `@Public` write in the product

A filesystem has nothing in front of it that understands a presigned URL. So `PUT` and `GET` on
`/api/v1/storage/local` stream bytes, authorised by a signed capability in the query: one object, one
method, one expiry, HMAC-signed with the deployment's own key and domain-separated from every other
use of it.

They are `@Public` because a presigned URL is by definition redeemed without a bearer token — that is
what makes one usable in an `<img>` tag or handed to a browser's own download manager. The token *is*
the credential. `local-transfer-token.spec.ts` is written as a list of attacks rather than round
trips, because being wrong here means serving somebody else's document: the key repointed at another
tenant, the expiry pushed out, a download URL presented as an upload, a signature truncated by one
character.

Two properties are worth recording. The signature is verified **before** any field of the payload is
read, because parsing attacker-controlled fields to decide whether to verify them is the wrong order
every time. And every rejection returns the same answer to the caller — distinguishing "expired" from
"bad signature" tells somebody probing which half of a forged token to keep working on.

### It was tested against live backends, not against a spy

`storage-adapters.integration.spec.ts` runs the **same twelve assertions against both drivers**,
through the real `TenantScopedStorage`. That is the claim the storage port makes — "adding a provider
is an adapter and a configuration value" — and a suite exercising one driver would have left it an
aspiration.

There is no MinIO in the suite and no network. The S3 side runs against an in-process store that
**re-derives every signature from the request as received**, so an adapter that signs one URL and
emits another fails exactly as it would at AWS. `sigv4.spec.ts` ties the algorithm to AWS's vectors;
this ties the adapter to the algorithm. The sharpest assertions are the two tamper cases: a signed
URL for Acme's object with its path repointed at Rival's is refused with 403, and so is one with a
single character of the signature altered.

This is also the first time the tenant prefixing was exercised against something that stores bytes.
The assertion that matters is two tenants writing **identical content under the same logical key**
and getting two objects — which is the ordinary case for content-addressed storage, because two
customers holding the same standard form compute the same digest.

## 2. What was built

| Piece | What it does |
| --- | --- |
| `packages/domain/file-formats.ts` | The format table: MIME type, family, extensions, magic bytes, whether it is a ZIP container |
| `infrastructure/storage/sigv4.ts` | AWS Signature Version 4, header and query forms |
| `infrastructure/storage/s3.adapter.ts` | S3, MinIO and R2 — one adapter |
| `infrastructure/storage/local.adapter.ts` | The filesystem, with atomic rename-into-place |
| `infrastructure/storage/local-transfer.controller.ts` | The two streaming endpoints the filesystem driver needs |
| `modules/storage` | Upload sessions, content addressing, deduplication, the antivirus gate |
| `modules/document` | The controlled record, its metadata, favourites, recents, duplicate detection |
| `modules/revision` | The first revision, and its label |
| `modules/preview` | The upload-time thumbnail |
| `infra/sql/post-migrate/03-content-gate.sql` | Four invariants the application cannot enforce alone |
| `apps/web/src/features/documents` | The workspace: tree, list, upload, scan intake, properties |

Eight new tables, one migration, and no change to any Phase 1 or Phase 2 table other than added
back-references.

## 3. Decisions worth carrying forward

**Nothing is stored to find out it is refused.** The type, the size and the content sniff all run
before a presigned target exists, so a rejected upload never occupies a byte of storage and never
costs the person the transfer. The declared type is checked against the *bytes*, never the extension.

**Recognition is by content, and the declared type participates.** Every OOXML format and
`application/zip` share four leading bytes, so bytes alone can rule a claim *out* but not always
*in*. The rule is: an undeclared or unsupported type is refused outright; a declaration the bytes
agree with stands; anything else is a mismatch reported with what the file actually is. That ordering
is what stops a renamed executable being stored as a PDF while still storing a `.docx` without
unzipping it during a request.

**Bytes land on a staging key and move to their content key at completion.** The content key *is* the
digest, and the digest is not a fact until the bytes have arrived. Writing to it on the client's word
would let a client that computes its checksum wrongly overwrite the blob that legitimately holds that
digest — and every integrity check afterwards would report tampering on a document nobody touched.

**The store's own answer is the fact; the client's claim is a claim.** Size and digest are read back
at completion and compared with what was announced. That is why `upload_session` and `file_object`
are separate tables: keeping the claim apart from the fact is what lets a mismatch be detected rather
than overwritten.

**The gate has no permissive default, in any environment.** With `AV_DRIVER=NONE` the port refuses,
the service catches the refusal, and the verdict is `SKIPPED` — which is not `CLEAN` and therefore
not attachable. "Upload works locally" must never come to mean "the gate is off".

**A document, its first revision and the reference on its blob are one transaction.** A document with
no revision has no content; a revision holding a blob nothing counted is a blob retention will delete
underneath it. The integration suite asserts both directions, including that a *refused* create
leaves no reference behind.

**The type's policy is copied, not referenced.** Confidentiality and retention are frozen onto the
document at creation, which is what lets a type be edited without rewriting history. A document's own
level may be raised and never lowered: every handling rule on a level subtracts, so choosing a lower
one would be a way to grant access the type's author decided against, from a dropdown.

**A duplicate is a warning, not a refusal.** Content addressing already made identical files one blob,
so the check is a lookup rather than a comparison. The first attempt is refused *naming what it
found*; an attempt that says it knows is accepted. Filing the same signed form against two projects
is ordinary — doing it unknowingly is the mistake.

**Favourites are not audited, and that is deliberate.** Whether somebody bookmarked a document is a
fact about a menu, not about a controlled record. One hash-chained, immutable, retention-governed row
per click on a star would dilute the trail with the one kind of event that can never matter to an
investigation.

**Recent documents are a table, not a projection of the audit trail** — even though the trail records
every read. Audit is evidence; serving a convenience list from it would put a product query on the
one table that must stay cheap to write and impossible to rewrite.

## 4. Three ports were inverted, and why

`REVISION_WRITER`, `DOCUMENT_CONTENT_GATE` and `DOCUMENT_THUMBNAILER` are declared in Document's
application layer and implemented by Revision, Storage and Preview.

The rule is that a module may call downward and publish upward, and all three of those sit *below*
Document — Revision depends on Document, not the other way round. But creating a document creates its
first revision and references its first blob, and all three have to commit together. So the
dependency was inverted rather than reversed: Document declares what it needs, in its own vocabulary;
the owning modules implement it; the composition root binds them.

The import direction is the proof. Those modules import Document's ports, and nothing in Document
imports anything of theirs — which the boundary lint checks. The Nest imports in `document.module.ts`
point the other way, as DI wiring always does.

Each port is deliberately narrower than the service behind it. `DOCUMENT_CONTENT_GATE` can describe a
blob, reference it, dereference it and link to it; it cannot create an upload, complete one or delete
a blob, because a document use case able to delete a blob is one able to delete another document's
content.

## 5. What the database enforces on its own

Four rules span two tables and are therefore triggers rather than check constraints. Each is asserted
by the integration suite **bypassing every use case** — writing directly, as a repair script or a
backfill would — because that is the only honest way to test a defence that exists precisely for the
case where the use case is not what is writing.

| Rule | Why it cannot live only in a use case |
| --- | --- |
| A revision may not reference a blob that is not `CLEAN` | `17-security-architecture.md` §5 asks for both; the use case's version produces a sentence a person reads, this one still holds at three in the morning |
| A referenced blob may not leave `CLEAN` | A re-scan finding something it missed must not silently leave a document pointing at hostile content. Withdraw the revision, then quarantine |
| A document may not claim another document's revision | The single worst thing a document-control system can get wrong. `current_revision_id` being unique prevents only half of it |
| A reference count may not go negative | A negative count means the count has already drifted from what it counts, at which point the next sweep deletes a blob a document still points at |

## 6. Preview: one artefact, and an honest boundary

Phase 3 owns the upload-time thumbnail and nothing else, and the narrowness is worth stating plainly
because it is the phase's most visible limitation.

**Thumbnails are produced for PNG only.** A PDF's first page, an Office document's cover and a DWG's
viewport each need a real renderer — a PDF engine, a headless office suite, a CAD library — and every
one of those is a sandboxed subprocess with CPU, memory and time caps, a plugin registry and a
failure story. That is Phase 7, it is a phase's worth of work, and building a fraction of it here
would have meant building the fraction with no sandbox. Every other format renders its format label
in the library, which is what a Word document would have shown anyway.

**The encoder is written out rather than pulled in.** `sharp` is the obvious dependency and is a
native binding: a platform-specific binary that builds or downloads per architecture, which is
exactly the dependency an air-gapped on-premise installer meets badly. A box-filter downscale and a
PNG encoder are a couple of hundred lines of arithmetic with none. The decoder refuses a
decompression bomb from the header, before allocating — twenty-five bytes can honestly declare
fourteen gigabytes of pixels.

**Generating one never fails a document.** The port returns nothing, deliberately. A thumbnail is a
decoration; a create rolled back over one would lose a document somebody uploaded in order to protect
a picture.

## 7. Scanning, stated precisely

The phase specification asks for "Scan Document(s)", and what was built needs to be described exactly
rather than implied.

**What exists:** a scan intake flow that is the upload pipeline with a narrower accepted format list
— images and PDF, which is what a scanner emits — and a `document.origin` column recording `SCAN`
rather than `UPLOAD`, so an auditor asking "was this captured from paper" has an answer that is not
recoverable from anything else afterwards.

**What does not exist and is not claimed:** there is no TWAIN, WIA or eSCL driver, no device
enumeration, and no server-side assembly of several captured pages into one multi-page document. A
browser cannot drive a scanner, and page assembly needs a PDF writer — which is the same renderer
dependency Phase 7 owns. In practice a person scans to files with their device's own software, or
uses a phone's camera through the file picker, and drops the results in.

Calling that "scanning" without saying so would have been the dishonest part.

## 8. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **Scanning is synchronous** | The malware scan happens inside the upload's completion request, so a large file holds a request open for the scan's duration | The architecture puts it on a worker fed by the outbox; the dispatcher does not exist yet, and a blob left `PENDING` forever would be one nothing can ever attach. Moves to a worker with R5 |
| **`LOCAL` computes a digest by reading the file** | An object store records one on the way in; a filesystem does not, so `head` streams the file to hash it | Streamed, never buffered. It is one pass per completed upload, and the alternative is the one deployment where content addressing is not provable |
| **A pre-upload digest is skipped above 128 MB** | `SubtleCrypto` has no streaming interface, so a whole-file digest means a whole file in memory | The server deduplicates at completion instead. One transfer later, same outcome |
| **The duplicate list is capped at twenty** | A warning listing four hundred documents says the same thing as one listing eleven, and costs a page of rows to say it | The count is exact in the refusal; the list is a sample |
| **No quota accounting** | `11-storage-architecture.md` §4 asks for a per-tenant quota check before presigning, and there is none | Entitlements are Phase 21's. A quota with nothing to read would be a constant |
| **Archive limits are declared, not applied** | The policy carries depth, entry-count and expansion-ratio caps, and nothing expands an archive yet | Nothing in Phase 3 reads inside a ZIP. They bind in Phase 7, where a renderer does |
| **Orphaned staging objects are swept by session, not by prefix** | A client that transferred bytes and never completed leaves an object whose session says `EXPIRED` | Correct for every case a session recorded. A prefix sweep for objects no session knows about is owed |

## 9. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| Every document is `DRAFT` | Submission, approval and publication are Phase 4's. `refuseWhenFrozen` is written and never fires, because an edit path built without it is one somebody has to remember to add | Phase 4 |
| No document number | Reserved at submission, assigned at approval ([ADR-0004](../architecture/adr/0004-numbering-assigned-at-approval.md)) | Phase 5 |
| No second revision | Check-out, check-in, compare and restore are Phase 6's. `document_revision` is already the full shape for all of them | Phase 6 |
| No `capabilities` on a document response | Object-level permission resolution is the ACL resolver's, and it is unbound. Inventing the object would be the web client rendering affordances from a decision nothing made | The ACL phase |
| Search is the list's `LIKE` filter | Title, number and description, escaped. Full text, OCR and permission-filtered ranking are Phase 8's | Phase 8 |
| Declassification is refused outright | Reducing a document's confidentiality is a decision with its own procedure; allowing it here would make it an ordinary edit any document editor can perform | The phase that gives it one |
| A folder delete still ignores its documents | ACLs do not exist yet, so a folder with documents in it is not yet a folder with permissions on it. The check belongs with the phase that makes the consequence real | The ACL phase |
| No Azure Blob or GCS adapter | Neither has a customer. Adding one is a class and a `case` in the composition root, which is the claim the port makes | The phase that needs one |

## 10. Defects and drift found while doing it

**Boot validation was checking storage configuration only in production, and should never have
been.** `STORAGE_BUCKET` required for a remote driver, and `LOCAL` refused under the cloud profile,
were both inside the `NODE_ENV === 'production'` block. Both describe what a *driver* needs in order
to work at all, not what production demands of a deployment: an S3 driver with no bucket cannot
address an object in staging either, and the failure it produces there is a 500 on the first upload
rather than a refusal to start. They now run in every environment, which is the same reasoning that
put tenancy validation outside that block in Phase 2.5. A third check was added beside them —
supplying one half of a storage key pair, which is the shape a partly filled `.env` takes.

**`UploadPart` could not describe a multipart completion.** The Phase 0.5 contract had `partNumber`
and `url` and nothing else, so there was nowhere to carry the store's upload identifier or the entity
tags a completion has to name. Both were added as optional fields on the part rather than on the
target: a driver with no notion of a multipart session simply never sets them, and `completeUpload`
sees a single-part transfer.

**`DuplicateError` could not say what the duplicate was.** "That document already exists" is not
something anybody can act on. It now takes optional details, and the document use case fills in the
first match's identifier, title and folder — a code collision still needs none, because the caller
typed the code.

**The integration suite could not be written where it belonged.** A suite under
`src/modules/document/` may not import `src/modules/storage/infrastructure/` or
`src/infrastructure/`, and the boundary lint enforces that for tests too — correctly, because a test
reaching into another module's internals keeps passing after that module's contract changes. The
composition moved to `src/testing/real-collaborators.ts`, which is exactly the file Phase 2.5 created
for this reason and whose comment says so. It is worth recording that the rule bit on the first
attempt rather than being noticed in review.

**Two integration assertions were passing for the wrong reason.** An early version checked
`head('tenants/<id>/<key>')` against the test registry, whose prefix is the tenant identifier alone.
The "is it absent for the other tenant" assertions therefore passed trivially — the path was wrong
for *both* tenants. The two that asserted presence failed, which is what surfaced it. A shared helper
now derives the path the way the scoping wrapper does.

## 11. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 297 API tests (up from 223), plus the shared packages and 21 web tests |
| `pnpm test:integration` | 15 files / 260 tests (up from 13 / 189) against real PostgreSQL |
| `pnpm build` | Clean, API and web |
| `pnpm prisma:deploy` | Verified against two tenant databases, including the new post-migration SQL |

The two suites that matter most are new.

`storage-adapters.integration.spec.ts` runs both drivers through the real tenant scoping against
real backends — a temporary directory and an in-process S3-compatible store that verifies every
signature it receives. It is the first thing in the product to exercise `TenantScopedStorage` against
something that stores bytes.

`document-library.integration.spec.ts` runs the whole library over a real PostgreSQL and a real
filesystem: forty-four assertions covering atomicity, the frozen policy, metadata coercion, duplicate
detection, favourites, recents, the move and delete lifecycle, and the four database triggers. Its
last group runs two tenants through one database — the on-premise shape, and the layer beneath
ADR-0015 — and asserts that a document, its blob and one person's favourites are all invisible across
the boundary.
