# Moving export downloads onto verified delivery — design and implementation plan

- **Status:** **Design for review, revision 2. Nothing here is implemented.** No application code is
  changed until the owner approves this document and the decisions in §9.
- **Date:** 2026-10-15
- **Branch:** `claude/amazing-turing-09vlks`, at `8c2476a`.
- **Context:**
  - [ADR-0026](../architecture/adr/0026-hetzner-hosting-evaluation.md) §10 (**Proposed**);
  - [`hetzner-download-integrity-proposal.md`](hetzner-download-integrity-proposal.md) (verified
    delivery, design A, implemented for documents and revisions in `5ce5185`);
  - [`hetzner-export-download-gap.md`](hetzner-export-download-gap.md) (the gap).
- **Scope:** the three routes that still return a direct signed store URL (300 s,
  `STORAGE_SIGNED_URL_TTL_SECONDS`):
  - `GET /api/v1/documents/bulk/:id/links`;
  - `GET /api/v1/reports/exports/:id/download`;
  - `POST /api/v1/audit/exports/:id/download`.
- **Revision 1** (`1af8192`) is superseded. What changed:
  - E-1 and E-2 are fixed (`8c2476a`).
  - The sizes are measured from configuration, not assumed: under ICAP a document is ≤ 128 MiB,
    not 2 GiB.
  - Four defects are new: E-8 to E-11.
  - Every route now has an issuance, redemption, failure and audit specification.
  - The 1 GiB question is answered explicitly (§6), not by default.

## 1. Defects: what is fixed and what is still open

| # | Defect | Status |
| --- | --- | --- |
| E-1 | Bulk links skipped the confidentiality level's `allowDownload` | **Fixed in `8c2476a`.** One rule, `refuseWhereLevelForbidsDownload`, applies to the single download, the EXPORT plan and `links()` |
| E-2 | Bulk links checked neither the operation's kind nor its state | **Fixed in `8c2476a`.** Own, `EXPORT` and `COMPLETED`, otherwise 404 |
| E-3 | Bulk links stop at 1,000 items (`pageSize: 1_000`); `BULK_MAX_OBJECTS` is 5,000 | Open; closed by §3.1 (paged list) |
| E-4 | The bulk route writes no bundle-level audit row | Open; closed by §3.1 and §5 |
| E-5 | Audit download issues one link per artefact, each in its own transaction. One refusal fails the request after earlier `FILE_DOWNLOAD_ISSUED` rows are committed. (Bulk was fixed for refusals in `8c2476a`; a store outage part-way through still leaves rows) | Open; closed by §3.3 (check everything, then write everything in one transaction) and §3.1 (issue on click) |
| E-6 | The bulk manifest has no download route | Open; a decision (§4, §9 D-5) |
| E-7 | Streamed exports deduplicate by checksum onto an existing `file_object` | Open; see E-10 |
| **E-8** | The verified link's `mimeType` comes from the `file_object` row. Under deduplication that is the **first** writer's type, not this export's format or artefact | New; fixed by §2.1 (the grant carries the export's own media type) |
| **E-9** | Audit `events.jsonl` and `events.csv` contain no export identifier. Two exports of the same range and filters share one `file_object`, and every zero-event export shares one empty one. Only `manifest.json` names its export (the code comment at `storage.service.ts` `storeStreamed` says Phase 9 artefacts "can never collide"; that is true of the manifest only) | New; consequence in E-10 |
| **E-10** | **A quarantined deduplicated export cannot be recovered by running it again.** The re-run reproduces the same digest, and `findByChecksum` returns the same quarantined row (not soft-deleted). The bytes the re-run wrote under the new key are left unreferenced. Only a successful re-read at the original key (the verifier) clears it | New; a decision (§9 D-6) |
| **E-11** | The report screen lists every export in the tenant, but download is owner-only. Other people's rows show a Download button that answers 404 | New; UI only, fixed in §3.2 (show Download for the requester's own exports) |
| **E-12** | The audit screen opens one popup per artefact, after an `await`, in a loop. Browsers allow at most one popup per click, so only the first artefact is reliably downloaded; the others are blocked. No code checks `window.open`'s result | New; fixed in §3.3 (no popups) |

## 2. Shared mechanism

### 2.1 One link format, with a kind

Today's grant (`storage/domain/download-link-token.ts`) has compact keys `t u v d r f k n m e`:
- `t` tenant, `u` user, `v` permission version;
- `d` document, `r` revision, `f` file object;
- `k` disposition, `n` filename, `m` media type, `e` expiry.

It is signed with HMAC-SHA256, purpose `munaxa.download.link`.

| Kind (`s`) | Subject keys | Notes |
| --- | --- | --- |
| absent = `DOCUMENT` | `d`, `r`, `f` | Today's tokens, unchanged. Bulk document links use this kind |
| `REPORT_EXPORT` | `x` (export id), `f` | **Omits `d`** |
| `AUDIT_ARTEFACT` | `x` (export id), `a` (artefact name), `f` | **Omits `d`** |
| `BULK_MANIFEST` (only if D-5 approves it) | `o` (operation id), `f` | **Omits `d`** |

- **Backward compatibility, both directions:**
  - A token without `s` decodes as `DOCUMENT`, so links issued before a deployment still redeem
    (they live 60 s).
  - The new kinds omit `d`. The current decoder requires `d`, so **an old instance refuses a
    new-kind token as MALFORMED** (404) instead of redeeming it as a document. A mixed fleet during
    a rolling deployment cannot misroute.
  - An unknown `s` is refused (MALFORMED), never guessed.
- **`m` is the export's own media type** (CSV, SpreadsheetML, PDF, JSONL, JSON or text), taken from
  the export or artefact record, not from the shared `file_object` (E-8).
- **Lifetime:** 60 s for every kind (`DOWNLOAD_LINK_TTL_SECONDS`, **unchanged**). Every route below
  issues a link at the moment of the click and follows it at once, so 60 s is enough. No separate
  recommendation is made.

### 2.2 Redemption: one route, one redeemer per kind

- `GET /api/v1/downloads?token=` stays the only redemption route. Caddy already routes it, and it
  is `@Public`.
- The controller moves from the document module to the storage module, which owns delivery. It
  dispatches on the kind to a **redeemer registry** (`DOWNLOAD_REDEEMERS`, in
  `storage/application`). Each module registers its own redeemer at `onModuleInit`. That is the
  precedent `BULK_PLAN_REGISTRY` and `FolderContentsRegistry` set, and it respects the module
  boundary lint: a registry in `application/` may be imported; another module's `domain/` may not.
- Every redeemer does the same first three steps, then its own rules:
  1. **The person:** the requester directory's `currentAuthority(userId)`. Refuse if the person is
     gone, disabled, or their `permissionVersion` differs from the grant's. The token's permissions
     are never trusted.
  2. A request context built from that authority, in the grant's tenant.
  3. The kind's rules (§3), **ending in "the file the grant names is still the file the object
     points at"**: `f` must equal the object's current `fileObjectId`.
- **Every refusal is a 404 with one sentence** ("This download link has expired or is no longer
  valid"). Not-found, not-yours, not-finished, lost-permission and expired must not be
  distinguishable. The current English sentence ends "Go back to the document and download it
  again", which is wrong for an export. It becomes kind-neutral: "Go back and download it again."
  The Arabic is changed the same way, for native review.
- Then `DefaultVerifiedDownloadDelivery.deliver` runs **unchanged**:
  - the servable gate (derived and `SKIPPED` passes; `MISMATCH`/`UNREADABLE` are refused);
  - the size limit and admission (slots, staged bytes, free-disk reserve);
  - the whole-object stage and hash, then send;
  - `FILE_DOWNLOAD_SERVED` on the last byte;
  - quarantine on a confirmed mismatch or absence; 503 + `Retry-After` on anything transient.

### 2.3 Issuance: check everything, then write once

- Issuance keeps every check it has today and adds the verified path's own:
  - the servable gate;
  - the size limit (§6);
  - the HEAD check, as an early refusal.
- Where one request issues several links (audit), **every artefact is checked first, and every
  audit row is written in one transaction afterwards**. A refusal or an outage part-way writes
  nothing, and returns nothing (E-5).

## 3. Route by route

### 3.1 Bulk document links

**Today (after `8c2476a`):**
- `GET /documents/bulk/:id/links` checks own, `EXPORT` and `COMPLETED`.
- For each APPLIED item it checks the ACL `document:download`, the confidentiality level, and the
  content gate, and returns a **list of 300 s signed store URLs** minted all at once.
- It stops at 1,000 items.

**Proposed:**

| | |
| --- | --- |
| **List** | `GET /documents/bulk/:id/items?page=&pageSize=` replaces `/links`. It returns **no URLs**: for each APPLIED item `documentId`, `documentNumber`, `title`, `filename`, `sizeBytes`, `revisionLabel` and `available` (a boolean), plus `unavailableReason` (an `ErrorReason` key) when it is false. The operation must be own, `EXPORT` and `COMPLETED` (as `8c2476a`). Paged, so every item is reachable (E-3). An item is reported **only when the caller may view it now** (ACL `document:view`). One the caller can no longer see is counted, not described (see "Refused items" below) |
| **Issue (per click)** | `POST /documents/bulk/:id/items/:documentId/link`. Every check runs again, in this order: operation own/`EXPORT`/`COMPLETED`; the item is APPLIED in this operation (membership is required but **grants nothing**); then the **single download's own `downloadLink`**, which checks tenant `document:download`, ACL `document:download`, the confidentiality level, the current revision, scan, integrity, size and HEAD, and writes `FILE_DOWNLOAD_ISSUED` (`delivery: 'VERIFIED'`, plus `bulkOperationId`). It returns `{ url, expiresAt }`, which is a `DOCUMENT` grant |
| **Redeem** | The existing `DOCUMENT` redeemer, unchanged: person active and same `permissionVersion`, `document:download`, ACL on the document, confidentiality, the current revision, and `f` equal to the current file. Then delivery verifies the bytes. **Bulk membership is not consulted at redemption.** The link is a document link and must satisfy every document rule then |
| **Which revision** | The document's **current effective revision at the click**, the same as the single download. If a newer revision has been published since the export, the person gets the newer one, and the item shows both labels ("exported Rev 2, current Rev 3"). Releasing the exported revision instead would need `document:history:view`, as the revision route does. That is a decision (§9 D-4) |
| **Refused items** | No URL is ever created for them. The list shows them as unavailable, with a reason the caller is allowed to know: `INTEGRITY_FAILED`, `SCAN_*`, `DOWNLOAD_TOO_LARGE`, or a generic "you can no longer download this" for a reach or confidentiality change. That generic reason never says which. A document the caller can no longer **view** appears only in a count ("2 documents are no longer available to you") and is never described |
| **Expiry** | 60 s from the click. The browser follows it at once (`window.location.assign`, as documents do). An expired link answers the 404 page, and clicking the row again issues a new one |
| **Failure** | Store outage at issue (HEAD) → 503 `STORAGE_UNAVAILABLE`, nothing audited, the row says "try again". Outage at redemption → the 503 page with `Retry-After`. Staging full → 503 `DOWNLOAD_BUSY`. One item failing never affects another, because there is no batch request any more |
| **Audit** | See §5. One bundle-level `BULK_EXPORT_OPENED` per list request (counts only). `FILE_DOWNLOAD_ISSUED` per click, carrying `bulkOperationId`. `FILE_DOWNLOAD_SERVED` per full send |
| **UI** | The bulk result dialog lists items with a Download button each, plus paging. It no longer shows a column of raw links that expire unseen. The list can also be opened from the operation itself, which serves exports queued above `bulk.synchronousLimit` (50): today only a synchronous result shows the links button |

### 3.2 Report exports

| | |
| --- | --- |
| **Issue** | `GET /reports/exports/:id/download`. Unchanged checks: the export exists in the tenant, it is the caller's own (`requestedById`), its state is `COMPLETED`, it has a `fileObjectId`, and the caller holds the catalogue entry's whole permission set (`capabilitiesFor` at TENANT). Then `createVerifiedDownloadLink` (servable, size, HEAD) issues a `REPORT_EXPORT` grant with `x` = the export id, `f`, `n` = the artefact name, and `m` = the format's media type (E-8). `FILE_DOWNLOAD_ISSUED` (`delivery: 'VERIFIED'`, `reportExportId`). The response shape `{url, expiresAt, filename}` is unchanged |
| **Redeem** | Reporting's redeemer: person active and same `permissionVersion`; the export exists in the grant's tenant; `requestedById` equals the grant's user; `COMPLETED`; `fileObjectId` equals `f`; and **the catalogue entry's permission set is held now**, through the same `capabilitiesFor` the issue used, so a report whose permission was revoked since issue is refused |
| **Integrity** | Whole-object hash against the export's recorded SHA-256, which the API computed while streaming. This is stronger than today's issue-time HEAD, which for a streamed export (no store checksum) can only compare the size and last-modified time |
| **Scan** | Not scanned: product-generated (`derived`, `SKIPPED`), the same rule as today. A quarantined export (`MISMATCH`/`UNREADABLE`) is refused at issue and at redemption |
| **Expiry and UI** | 60 s. **The screen changes from `window.open(url, '_blank')` to `window.location.assign(url)`**: the response is an attachment, so the page stays where it is and there is no popup to block. Download appears only on the requester's own completed exports (E-11) |
| **Failure** | Outage at issue → 503, nothing audited, toast "try again". Outage at redemption → 503 page with `Retry-After`. Staging full → 503 `DOWNLOAD_BUSY`. Mismatch → 409 and quarantine. **A quarantined report export currently cannot be recovered by re-running it (E-10)**, so the message is "This export failed its integrity check. Ask an administrator." until D-6 is decided |
| **Audit** | `REPORT_EXPORTED` at request and completion, unchanged. `FILE_DOWNLOAD_ISSUED` at issue. `FILE_DOWNLOAD_SERVED` on a full send |

### 3.3 Audit exports

| | |
| --- | --- |
| **Issue** | `POST /audit/exports/:id/download`. Unchanged checks: tenant `audit:export` and the export `COMPLETED`. **Policy preserved:** any holder of `audit:export` in the tenant may download any completed bundle, exactly as today (D-3 describes requester-only as an option). **All or nothing:** every artefact is checked first (servable, size, HEAD); then **one transaction** writes a `FILE_DOWNLOAD_ISSUED` per artefact and the bundle-level `BULK_DOWNLOAD` (with every digest). If any check fails, nothing is written and the request answers that artefact's reason (E-5). Each link is an `AUDIT_ARTEFACT` grant: `x`, `a` (the artefact name), `f`, and `m` = the artefact's `mediaType` |
| **Redeem** | Audit's redeemer: person active and same `permissionVersion`; tenant `audit:export` held **now**; the export exists in the grant's tenant and is `COMPLETED`; the named artefact is in its `artefacts` list; and that artefact's `fileObjectId` equals `f` |
| **Integrity and scan** | As for reports: derived, `SKIPPED`, a whole-object hash against the artefact's recorded digest. The digests are also in the bundle's own manifest and in `AUDIT_EXPORTED`/`BULK_DOWNLOAD`, so an auditor can still check the files offline |
| **Expiry and UI** | 60 s. The screen no longer opens popups (E-12). It receives every link from the one request and starts each download with a hidden same-origin `<a download>` click, in sequence. Chromium asks once to "download multiple files", which is the standard behaviour. The dialog also lists the artefacts with a button each, which issues a fresh single-artefact link (`POST …/download?artefact=`) for anyone whose browser blocked the batch or let a link expire |
| **Failure** | As for reports. An outage at issue writes nothing. A mismatch quarantines **that artefact's** `file_object`, which deduplication may share with another export (E-9). The others still download |
| **Audit** | `AUDIT_EXPORTED` at request and completion, unchanged. At issue, in one transaction: `FILE_DOWNLOAD_ISSUED` × artefacts and `BULK_DOWNLOAD`. `FILE_DOWNLOAD_SERVED` per artefact sent in full. A single-artefact re-issue writes its own `FILE_DOWNLOAD_ISSUED` and a `BULK_DOWNLOAD` naming that artefact only |

## 4. The bulk manifest (E-6)

- **What it is.** A JSON file written when the export completes:
  - **header:** `operationId`, `documentCount`;
  - **per released document:** `documentId`, `documentNumber`, `title`, `folderPath`,
    `revisionLabel`, `filename`, `mimeType`, `sizeBytes` and `checksumSha256`.

  It is stored derived, content-addressed and referenced. It contains **no links**, and since
  `8c2476a` **no refused document**: a refused item is never APPLIED, so it is never listed.
- **Today it cannot be downloaded at all**, so keeping that is a safe default.
- **The risk if it is made downloadable.** It names documents. One reclassified or moved out of
  the requester's reach after the export would still be named in a file the requester takes later.
  The links are re-checked when they are used; a stored file cannot be.

**Recommendation (D-5): make it downloadable, under these conditions.**
- **Who:** the requester only, and only for an operation that is the requester's own `EXPORT`, in
  state `COMPLETED`.
- **How:** a `BULK_MANIFEST` link, redeemed through the verified path.
- **When it is refused:** if **any** document it names is no longer viewable by the requester,
  the redemption refuses with 409 "This manifest names documents you can no longer see." The
  person still has the per-item list, which shows only what they may see. An unauthorized
  document is never disclosed.
- **Format change, for new exports only:** add `includedCount` and `refusedCount` beside
  `documentCount`. A refused document is counted, never named. Existing manifests are unchanged:
  their bytes are their evidence.
- **Audit:** `FILE_DOWNLOAD_ISSUED` and `FILE_DOWNLOAD_SERVED` on the manifest's file.

The alternative is to leave it non-downloadable, since its content is visible to the requester
through `GET /documents/bulk/:id`. That costs nothing and loses only an evidentiary file the
requester can hand on.

## 5. Audit events

| Moment | Event | Subject | `after` | Change |
| --- | --- | --- | --- | --- |
| Bulk item list requested | **`BULK_EXPORT_OPENED`** (new) | `BULK_OPERATION` (the subject type exists) | `{ applied, availableNow, unavailableNow, page }`, counts only, never the ids of unavailable items | New. Closes E-4 without implying anything was released. Defined in `core/bulk/audit-actions.ts`, because `BULK_DOWNLOAD` is the audit module's constant and another module may not import its `domain/` |
| Any link issued | `FILE_DOWNLOAD_ISSUED` | `FILE` | `{ checksumSha256, filename, inline, expiresAt, delivery: 'VERIFIED' }` plus `bulkOperationId`, `reportExportId` or `auditExportId` + `artefact` | Correlation fields added. **Written only in the transaction that returns the link** |
| Audit bundle issued | `BULK_DOWNLOAD` | `EXPORT` | as today: artefacts, `eventCount`, digests | Now in the same transaction as the issued rows (E-5) |
| Every full send | `FILE_DOWNLOAD_SERVED` | `FILE` | `{ checksumSha256, sizeBytes, verifiedAfterMs }` + the same correlation field | Exports and bulk now write it too |
| Mismatch or confirmed absence | `INTEGRITY_MISMATCH` + outbox event | `FILE` | as today | Unchanged |

- **No misleading rows.**
  - A request that answers an error writes no `FILE_DOWNLOAD_ISSUED`. Bulk issues one link per
    request, and audit checks everything before writing (§2.3).
  - A redemption that refuses or fails writes no `FILE_DOWNLOAD_SERVED`.
  - A disconnect is logged, not audited, as for documents.
- **No migration.** Actions are free strings (`audit_event.action`), and `BULK_OPERATION` already
  exists as a subject type.
- **Documentation.** The audit screen shows action codes verbatim, so the new code needs only a
  line in `13-audit-architecture.md`.

## 6. Size, staging and concurrency — the 1 GiB question

**What can actually be produced today, at the shipped defaults:**

| Object | Bound in code | Realistic size |
| --- | --- | --- |
| Bulk document | Per-family caps (text 32 MiB, Office 128, image/PowerPoint 256, PDF 512 MiB, archives up to `STORAGE_MAX_UPLOAD_BYTES` 2 GiB). **Under `AV_DRIVER=ICAP`, which Hetzner and production require, uploads are capped at `AV_ICAP_MAX_BYTES` = 128 MiB** | ≤ 128 MiB unless the scanner cap is raised |
| Report CSV | `REPORTING_EXPORT_MAX_ROWS` 250,000 (configurable to 5,000,000); no byte cap. Widest report: 12 columns, title ≤ 200 characters | ~0.3–1 KB/row → **~75–250 MB** at the default cap [estimate] |
| Report SpreadsheetML | Same rows, ~41 bytes of markup per cell | **up to ~400 MB** at the default cap [estimate] |
| Report PDF | `REPORTING_PDF_MAX_ROWS` 5,000; built in memory | a few MB |
| Audit `events.jsonl` / `events.csv` | **No range or event cap.** `collect()` holds every event of the range in memory before writing | ~0.7–1.5 KB/event plus payload; the code itself says "a seven-year evidence export is hundreds of megabytes" |

**Findings:**
1. **At the default settings no export reaches 1 GiB** (`DOWNLOAD_MAX_FILE_BYTES`):
   - reports stay below ~400 MB;
   - bulk documents are ≤ 128 MiB under ICAP.
2. **An audit export large enough to pass 1 GiB cannot be produced safely today anyway.**
   `collect()` would need more than that in API memory, against a 1.5 GiB container limit. The
   real limit on audit exports is generation memory, not download.
3. A deployment that raises `REPORTING_EXPORT_MAX_ROWS` or `AV_ICAP_MAX_BYTES` could produce
   objects over 1 GiB. Today they would be signed; after the change they would be refused at issue
   with `DOWNLOAD_TOO_LARGE`.

**Proposal: do not refuse silently; make it visible before the click.**
- **(a) Status at completion.** When an export completes with an artefact larger than
  `DOWNLOAD_MAX_FILE_BYTES`, record it on the export: report → `tooLargeToDownload`; audit → per
  artefact. The screen says so on the row ("This export is larger than the 1 GiB that can be
  checked for download. Narrow the range or ask an administrator"), instead of offering a button
  that fails.
- **(b) Boot-time warning.** Log a warning when `REPORTING_EXPORT_MAX_ROWS` × a conservative
  bytes-per-row bound, or `AV_ICAP_MAX_BYTES`, exceeds `DOWNLOAD_MAX_FILE_BYTES`. That is the only
  way to reach the limit at the shipped widths.
- **(c) Not proposed: a signed-URL fallback for oversize files.** It would reintroduce exactly the
  unverified door this work removes. If the owner wants objects over 1 GiB downloadable, raise
  `DOWNLOAD_MAX_FILE_BYTES` together with `DOWNLOAD_STAGING_MAX_BYTES` and the staging volume
  (the configuration already enforces file ≤ staging).
- **(d) Separately, outside this work:** audit export generation should stream or cap its range.
  Its in-memory collection is the real exposure (recorded as a follow-up, not in the sequence
  below).

**Staging and concurrency:**
- Exports share the document downloads' budgets: 8 slots, 2 GiB staged bytes, a 30 s queue and a
  512 MiB free-disk reserve.
- A 400 MB report or a 4-artefact audit bundle takes its size of staging for as long as it is being
  verified and sent. A burst of large exports can therefore make document downloads wait, then
  503.
- Phase B measured these budgets as holding: anonymous memory ≤ 493 MiB at 8 × 128 MiB, staging
  never over budget, and a disk filling part-way answering 503.
- **No separate budget is proposed now.** If measurement on the target server shows contention,
  the follow-up is a per-kind slot reservation (e.g. 2 of 8 for exports), not a second stager.
- Memory per download stays a few staging records, whatever the size.

## 7. Failure handling (all routes)

| Situation | At issue | At redemption | Audit |
| --- | --- | --- | --- |
| Store unavailable (5xx, timeout, reset) | 503 `STORAGE_UNAVAILABLE`, nothing returned | 503 page, `Retry-After: 30`, no bytes, no quarantine | No issued row; no served row |
| Object missing | HEAD finds it absent: quarantine `UNREADABLE` after the confirming read, 409 | The same, inside delivery | `INTEGRITY_MISMATCH` |
| Bytes changed (size or digest) | HEAD may catch a size or checksum change: 409 | Staged hash mismatch → 409, **0 bytes**, quarantine `MISMATCH` | `INTEGRITY_MISMATCH` |
| Already quarantined | 409 `INTEGRITY_FAILED` before any store read | The same | — |
| Larger than `DOWNLOAD_MAX_FILE_BYTES` | Shown on the row (§6), not offered | 415 `DOWNLOAD_TOO_LARGE` if reached anyway | — |
| Staging full / slots taken / disk reserve | — | 503 `DOWNLOAD_BUSY`, `Retry-After`, nothing staged or partial files freed | — |
| Disk fills part-way | — | 503 `DOWNLOAD_BUSY` (`5bf578d`) | — |
| Link expired or edited | — | 404 page, kind-neutral sentence | — |
| Permission, ownership, state or confidentiality changed since issue | — | 404 page (indistinguishable from expiry) | No served row |
| Bulk: some items unavailable | Each item answers for itself. The list shows which and why, where allowed | — | Counts only in `BULK_EXPORT_OPENED` |
| Audit: one artefact refused | The whole issue answers that refusal; nothing is written | Each artefact link redeems independently | Nothing written for the failed issue |
| Client disconnects | — | Staging freed, budget released | Logged; no served row |

## 8. Compatibility

| Surface | Effect |
| --- | --- |
| `/api/v1/downloads` | Same route, same headers. The new kinds are refused by an old instance (no `d`), so a rolling deployment cannot misroute |
| Report and audit API responses | Same shape; `url` now points at `/api/v1/downloads` |
| Bulk API | **Breaking:** `GET …/links` is replaced by `GET …/items` and `POST …/items/:documentId/link`. Only the bulk panel calls it; both change in the same release. `/links` could answer 410 for one release to catch stale clients |
| Report screen | `window.location.assign` instead of a popup. Download shown only on the requester's own exports |
| Audit screen | No popups. Sequential `<a download>` plus per-artefact buttons |
| Arabic / RTL | No new layout. The new sentences need Arabic translations (`BULK_EXPORT_OPENED` is not shown to people; the item reasons and the kind-neutral expiry sentence are), marked for native review |
| Store and R2 | Exports stop needing browser `GET`s against the store. After this work only uploads use the store from the browser, which narrows Phase C's CORS question to `PUT` |
| `STORAGE_SIGNED_URL_TTL_SECONDS` | Still used for uploads and internal reads; no longer for any download a person receives |
| Phase B | B-10 inverts: report and audit exports must arrive through `/api/v1/downloads`. The harness's re-fetch of the link (`fetch(got.url())`) works within the 30 s test TTL and writes one more `FILE_DOWNLOAD_SERVED`. A new bulk browser case is added |

## 9. Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| D-1 | Approve this design and the sequence in §10 | — |
| D-2 | New audit action `BULK_EXPORT_OPENED` (counts only) | Approve |
| D-3 | Audit export access policy | **Keep today's: any `audit:export` holder** (preserved by this design). Requester-only is an option, below |
| D-4 | Bulk: release the current revision (single-download rule) or the exported revision (needs `document:history:view`) | Current revision, with both labels shown |
| D-5 | Bulk manifest downloadable? | Yes, requester-only, refused if it names any document the requester can no longer view (§4) |
| D-6 | Recovering a quarantined deduplicated export (E-10) | Short term: the message says "ask an administrator". Follow-up: when a re-run's digest matches a **quarantined** row, re-point that row at the freshly written key and re-verify it, instead of reusing the bad object. This is an integrity-sensitive change, needing its own approval |
| D-7 | Objects over `DOWNLOAD_MAX_FILE_BYTES` | Visible "too large" status at completion plus a boot warning (§6 a, b); **no** signed-URL fallback. Raise the limit and the staging budget together if larger exports are needed |
| D-8 | Removing the signed-URL path for these three routes | At the end of the sequence, once Phase B passes. No feature switch back |

**D-3: the requester-only option, and its trade-offs.**

| | Any `audit:export` holder (today, kept) | Requester only |
| --- | --- | --- |
| **For** | An auditor can hand a bundle to a colleague, and a team can share one long-running export. Matches today's tenant-wide list | Smallest blast radius. A person who loses the role cannot use links others issued; they never get any |
| **Against** | Anyone with the role can take any bundle, including ranges they did not choose | A second auditor must re-run the export (memory-heavy, §6 d). Admins lose the ability to retrieve a departed auditor's bundle unless a separate override exists |
| **If chosen** | — | Check `requestedById` at issue and redemption; hide others' Download buttons |

Both are compatible with this design. Only the redeemer's ownership line changes.

## 10. Implementation sequence (proposed; each step is its own commit with its tests)

1. **Link kinds and the redeemer registry, no behaviour change.**
   - The token gains `s` and the new subject keys; a missing `s` decodes as `DOCUMENT`.
   - The controller moves to storage and dispatches through `DOWNLOAD_REDEEMERS`; document
     registers today's redeemer.
   - The expiry sentence becomes kind-neutral, in English and Arabic.
   - Tests: token compatibility both ways; existing download tests unchanged.
2. **Report exports onto verified links.**
   - Reporting's redeemer; the issue switches to `createVerifiedDownloadLink` with `m` from the
     format (E-8).
   - The screen uses `location.assign`, and Download is shown only on the requester's own exports
     (E-11).
   - The Phase B report case is inverted.
3. **Audit exports onto verified links.**
   - Audit's redeemer, plus all-or-nothing issue in one transaction (E-5).
   - Screen without popups (E-12), plus a single-artefact re-issue.
   - The Phase B audit case is inverted.
4. **Bulk document links.**
   - The paged item list (E-3) and `BULK_EXPORT_OPENED` (E-4).
   - Per-item issue through the single download's `downloadLink`, with `bulkOperationId`.
   - The new bulk panel, and a Phase B bulk case.
5. **Manifest** (only if D-5 is approved): the `BULK_MANIFEST` kind, the redeemer, and the new
   counts for new exports.
6. **Size visibility** (D-7): the "too large" status at completion and the boot warning.
7. **Remove the signed-URL path** for the three routes, then rerun Phase B in full on local MinIO
   and update ADR-0026 §10 and the gap note.

Not in this sequence; each needs its own approval:
- D-6's re-pointing repair;
- streaming or capping audit export generation (§6 d);
- a per-kind staging reservation;
- Phase C (R2).

## 11. Tests

Each step carries its own tests. Every test runs against real PostgreSQL, and against MinIO where
bytes are involved. Where practical, a test is first shown to fail on the code before the step.

**Authorization changes between issue and redemption** (each must answer the 404 page and write no
served row):
- the person is disabled, or their permission version changes;
- **report:** the catalogue permission is revoked after issue;
- **audit:** `audit:export` is revoked after issue;
- **bulk:**
  - `document:download` is revoked on the document;
  - the document is reclassified to a level without download;
  - the document is moved out of reach;
  - a new revision is published (the link names the old file, so `f` no longer matches).

**Wrong type, state, owner and tenant:**
- **report:**
  - another user's export, at issue and at redemption;
  - an export not `COMPLETED` (`REQUESTED`, `RUNNING`, `FAILED`);
  - a token whose `x` names another export with the same file (a deduplicated pair): it must
    redeem only for an export the person may take.
- **audit:**
  - an artefact name not in the export;
  - an export that is not `COMPLETED`;
  - another tenant's export id, under the person's tenant.
- **bulk:**
  - the per-item issue for an item that is not APPLIED, for a document from another operation, for
    another person's operation, for a non-`EXPORT` kind and for an unfinished state;
  - the paged list beyond 1,000 items (1,500 seeded).
- **token:** each kind's token presented with the wrong kind's keys; an unknown `s`; a new-kind
  token decoded by the previous decoder, which must be MALFORMED.

**Tampered, missing, unverified, quarantined and oversized objects** (for a report CSV, each audit
artefact and a bulk document):
- same-size bytes swapped → 409, 0 bytes, `MISMATCH`, one `INTEGRITY_MISMATCH`;
- a different size → 409 before any bytes are read;
- object deleted → `UNREADABLE` only after the confirming read;
- an `UNVERIFIED` export larger than `STORAGE_INTEGRITY_MAX_BYTES` (never verified at rest) still
  verifies on download;
- already quarantined → refused before any store read;
- over `DOWNLOAD_MAX_FILE_BYTES` → shown as too large at completion; 415 if reached anyway.
- **E-9 pair:** quarantining one audit export's shared `events.jsonl` refuses the other export's
  artefact too, and that is what is reported.

**Storage outages and partial failures:**
- store stopped at issue → 503, no issued rows;
- store stopped at redemption → 503 + `Retry-After`, no quarantine, no served row;
- **audit:** one artefact missing at issue → the whole issue refuses and writes nothing;
- **bulk:** one item's store failing leaves the other items issuable.

**Audit correctness:**
- exactly one `FILE_DOWNLOAD_ISSUED` per returned link, with the correlation field;
- none for a refused or failed request;
- `BULK_DOWNLOAD` atomic with the audit issue;
- `BULK_EXPORT_OPENED` carries counts only and never the id of an unavailable item;
- `FILE_DOWNLOAD_SERVED` only on a full send, never on a refusal, a disconnect or a 503.

**Manifest** (if D-5): counts present and correct; no refused document named; refused for the
requester once any named document becomes unviewable; refused for anyone else.

**Browser compatibility and Arabic** (the Phase B harness, local MinIO):
- the report export downloads through `/api/v1/downloads`, byte for byte, with no popup;
- the audit bundle downloads every artefact (not only the first), with no popup;
- a bulk export of mixed documents: allowed items download, and unavailable ones show their reason;
- an expired link shows the kind-neutral page;
- the same flows in Arabic, right to left, with the new sentences;
- the screens at 1280×720.

**Bounded memory, staging and concurrency** (the Phase B resource cases, extended):
- a ~300 MB report CSV alongside 8 document downloads: staging never over budget, every answer the
  exact bytes or a retryable 503, staging empty afterwards, no restart;
- a 4-artefact audit bundle downloaded concurrently with documents;
- anonymous memory measured against Phase B's figures.

## 12. Blockers

- **No technical blocker.** Every step builds on what exists: the verified delivery, the registry
  pattern, the module boundary rules and the Phase B harness.
- **What the steps wait on:** the decisions D-1 to D-8. D-2, D-4, D-5 and D-7 change what is built.
  D-3 and D-6 are recorded here and change nothing unless the owner chooses otherwise.
- **Outside this work and not blocking it:**
  - audit export generation holds a whole range in memory (§6 d);
  - R2 behaviour remains Phase C;
  - ADR-0026 stays **Proposed**, and nothing here claims production readiness.
