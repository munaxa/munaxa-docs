# Moving export downloads onto verified delivery — design

- **Status:** **Design for review. Nothing here is implemented**, and it will not be until the
  four Phase B fixes (branch `claude/amazing-turing-09vlks`) have been reviewed.
- **Date:** 2026-10-15
- **Context:** [ADR-0026](../architecture/adr/0026-hetzner-hosting-evaluation.md) §10 (Proposed);
  the gap is stated in [`hetzner-export-download-gap.md`](hetzner-export-download-gap.md). The
  verified path it extends is `5ce5185` (documents and revisions only).
- **Scope:** the three routes that still return a direct signed store URL (300 s,
  `STORAGE_SIGNED_URL_TTL_SECONDS`):
  - `GET /api/v1/documents/bulk/:id/links`;
  - `GET /api/v1/reports/exports/:id/download`;
  - `POST /api/v1/audit/exports/:id/download`.

## 1. Defects found while inspecting the routes (independent of the design)

These are present today and are **not fixed** on this branch. They are separate from the four
Phase B fixes and need their own approval. The first two are authorization defects.

| # | Defect | Where | Effect |
| --- | --- | --- | --- |
| **E-1** | **Bulk links skip the confidentiality level's `allowDownload`.** The ordinary door refuses with `ForbiddenError` (`document.service.ts` `downloadTarget`). `links()` checks only ACL `document:download` | `bulk-export.service.ts` `links()` | A person who holds `document:download` gets a link to a document whose classification forbids download. **Security; highest priority** |
| **E-2** | Bulk links check neither the operation's kind nor its state. `requireOwnOperation` checks only the tenant and the requester | `bulk-documents.controller.ts` `requireOwnOperation` | Links for every APPLIED item of any of the caller's own operations (METADATA, RESTORE, UPLOAD…), finished or not. ACL and scan are still checked per document |
| E-3 | Bulk links stop at 1,000 items, without notice (`pageSize: 1_000`), while `BULK_MAX_OBJECTS` defaults to 5,000 | `links()` | Items 1,001–5,000 are silently missing |
| E-4 | The bulk route writes no `BULK_DOWNLOAD`, although its class comment says it does; only `FILE_DOWNLOAD_ISSUED` per document | `bulk-export.service.ts` | The trail has no single "this bundle was handed out" row |
| E-5 | Bulk and audit issue one link per artefact, each in its own transaction. When one artefact is refused, the request fails, but the `FILE_DOWNLOAD_ISSUED` rows for the earlier artefacts stay committed. Audit then never writes `BULK_DOWNLOAD` | `links()`, `audit-export.service.ts` `download()` | "Issued" rows for links nobody received |
| E-6 | The bulk manifest (`storeManifest`, derived) has no download route | bulk controller | The manifest cannot be fetched |
| E-7 | Report exports deduplicate by checksum (`storeStreamed` → `findByChecksum`), so a re-run export can point at an older export's `file_object` and key | `storage.service.ts` `storeStreamed` | Harmless for integrity (same bytes), but one quarantine affects both exports |

Recommendation: fix **E-1 and E-2 first and separately**, as a small change to `links()` (call the
document service's own download-target check, and require a COMPLETED export operation). This is
independent of the design below, and the design removes both defects anyway.

## 2. What the routes do today

| | Bulk links | Report export | Audit export |
| --- | --- | --- | --- |
| **Authorization at issue** | Own operation; tenant `document:download`; per-document ACL `document:download`; **no confidentiality check (E-1)** | Own export; COMPLETED; the catalogue entry's whole permission set (`capabilitiesFor` at TENANT) | `audit:export`; COMPLETED; **no ownership** (any holder in the tenant) |
| **Object** | Each document revision's `file_object` (uploaded, CLEAN, store-held SHA-256) | One `file_object` per export: derived, SKIPPED, SHA-256 computed by the API while streaming, **no store-held checksum** (multipart) | One `file_object` per artefact (`events.jsonl`, `events.csv`, `manifest.json`, `manifest.sig` when signed); as report |
| **Checks at issue** | `refuseUnreachable`, then a HEAD (`confirmStoredBytes`): size, plus store checksum or last-modified | Same | Same, per artefact |
| **Audit** | `FILE_DOWNLOAD_ISSUED` per document | `FILE_DOWNLOAD_ISSUED` | `FILE_DOWNLOAD_ISSUED` per artefact, then `BULK_DOWNLOAD` with every digest |
| **Web** | One `<a href>` per document, listed, followed later | `window.open(url, '_blank', 'noopener,noreferrer')` | One `window.open` per artefact |
| **Size** | Up to `STORAGE_MAX_UPLOAD_BYTES` (2 GiB) per document | ≤ 250,000 rows (`REPORTING_EXPORT_MAX_ROWS`); no byte cap | Bounded only by the chosen range ("hundreds of MB" for long ranges) |

The verified delivery already accepts a derived, SKIPPED file (`unreachableBecause`). Its
verification needs only the recorded `checksumSha256` and `sizeBytes`, not a store-held checksum, so
**exports verify exactly as uploads do**. This is stronger than today's HEAD fallback, which for
exports cannot see the bytes at all.

## 3. Design

### 3.1 One link format, with a kind

`DownloadLinkGrant` today is document-specific (`documentId` required). It gains a **kind**:

| Kind | Subject fields | Who redeems |
| --- | --- | --- |
| `DOCUMENT` (today's) | `documentId`, `revisionId \| null`, `fileObjectId` | Unchanged |
| `REPORT_EXPORT` | `exportId`, `fileObjectId` | Reporting module |
| `AUDIT_ARTEFACT` | `exportId`, `artefact` (name), `fileObjectId` | Audit module |

- The other grant fields are unchanged: `tenantId`, `userId`, `permissionVersion`, `disposition`,
  `filename`, `mimeType`, `expiresAt`, signed with the same HMAC purpose `munaxa.download.link`.
- **Compatibility:** a token without `kind` decodes as `DOCUMENT`. A link issued just before a
  deployment still redeems, and links live 60 s. A decoder that meets an unknown kind refuses it
  (`MALFORMED`) rather than guessing.
- **Bulk needs no new kind.** Each bulk entry is a document and is redeemed as a `DOCUMENT` grant,
  through `downloadTarget`. That check is what closes E-1.

### 3.2 Issue

- **Report:** `downloadExport()` keeps its checks: own export, COMPLETED, catalogue permissions. It
  then calls `createVerifiedDownloadLink` with a `REPORT_EXPORT` grant, not `createDownloadUrl`. The
  response shape `{url, expiresAt, filename}` is unchanged; `url` becomes `/api/v1/downloads?token=…`.
- **Audit:** `download()` keeps `audit:export` and COMPLETED, and issues one verified link per
  artefact (`AUDIT_ARTEFACT`).
  - **All-or-nothing:** every artefact is checked (servable, size, HEAD) *before* any row is
    written; then all the `FILE_DOWNLOAD_ISSUED` rows and the `BULK_DOWNLOAD` row are written in
    **one** transaction (fixes E-5).
  - Ownership stays as today (any `audit:export` holder). Narrowing it is a policy decision; see §6.
- **Bulk:** a list of 60 s links cannot work: they are listed together and followed later. Two parts:
  1. `GET /documents/bulk/:id/links` stops returning URLs. It becomes a list of the operation's
     documents: `documentId`, `filename`, and whether each can be downloaded now. It is restricted
     to an export operation that is COMPLETED (fixes E-2) and paged rather than cut at 1,000
     (fixes E-3).
  2. The bulk panel's "download" for a row calls the existing `POST /documents/:id/content`. That
     is the verified path, with ACL, confidentiality, scan and integrity checks and
     `FILE_DOWNLOAD_ISSUED`.

  A `BULK_DOWNLOAD` row when the list is fetched (subject: the operation, `after`: the document ids)
  restores the bundle-level record (E-4). The manifest gets a `DOCUMENT`-independent route only if
  the owner wants it (E-6, §6).

### 3.3 Redemption (re-authorization when the link is followed)

`/api/v1/downloads` keeps one controller. It dispatches on the grant's kind to a per-module
redeemer, so the document module no longer owns export rules. A refusal stays the 404 "link
expired or no longer valid" page, in every case.

| Kind | Re-checked when followed |
| --- | --- |
| `DOCUMENT` | Unchanged: person active, `permissionVersion` equal, tenant `document:download` (+ `document:history:view` for a revision), ACL on the document, `downloadTarget` (confidentiality), the current file is still the granted one |
| `REPORT_EXPORT` | Person active and `permissionVersion` equal; the export exists, is the person's own and is COMPLETED; the catalogue entry's permission set is still held; `fileObjectId` equals the export's |
| `AUDIT_ARTEFACT` | Person active and `permissionVersion` equal; tenant `audit:export`; the export is COMPLETED; the named artefact exists in it and its `fileObjectId` equals the grant's |

### 3.4 Integrity, audit and failure

- **Delivery is unchanged:** `DefaultVerifiedDownloadDelivery.deliver` stages and hashes the whole
  object, then sends only if size and SHA-256 equal the record.
  - A mismatch or a confirmed absence quarantines the `file_object` (`MISMATCH`, `UNREADABLE`) and
    answers 409.
  - Transient failures answer 503 + Retry-After, including a staging disk that fills (fixed on this
    branch).
- **New sentence for a quarantined export.** "An administrator needs to restore it" is wrong for an
  export: the remedy is to run it again. Add `EXPORT_INTEGRITY_FAILED`: *"This export failed its
  integrity check. Run the export again."* Arabic is needed too, for native review.
- **Audit events:**

  | Moment | Event | Change |
  | --- | --- | --- |
  | Issue | `FILE_DOWNLOAD_ISSUED` (`delivery: 'VERIFIED'`, as documents) | Report and audit now `VERIFIED` |
  | Issue (audit) | `BULK_DOWNLOAD`, with every digest | Same transaction as the issued rows (E-5) |
  | Bulk list fetched | `BULK_DOWNLOAD` (operation, document ids) | New (E-4) |
  | Served in full | `FILE_DOWNLOAD_SERVED` (`sizeBytes`, `verifiedAfterMs`) | New for exports |
  | Mismatch | `INTEGRITY_MISMATCH` + outbox event | As documents |

### 3.5 Memory and disk

- Exports share the document downloads' budgets: `DOWNLOAD_MAX_CONCURRENT` (8), staging
  `DOWNLOAD_STAGING_MAX_BYTES` (2 GiB), `DOWNLOAD_QUEUE_TIMEOUT_MS` (30 s), the free-space reserve
  `DOWNLOAD_MIN_FREE_BYTES` (512 MiB). Memory stays a few staging records per download. Phase B
  measured anonymous memory ≤ 463 MiB at 8 × 128 MiB.
- **`DOWNLOAD_MAX_FILE_BYTES` (1 GiB) now applies to exports.** Report exports (≤ 250,000 rows)
  stay well under it. A long-range audit export, or a bulk-selected document between 1 and 2 GiB
  (uploads allow 2 GiB), would be refused `DOWNLOAD_TOO_LARGE`, where today it is signed.
  Options for the owner:
  - (a) accept and document it;
  - (b) cap audit-export ranges so `events.jsonl` stays under the limit;
  - (c) raise `DOWNLOAD_MAX_FILE_BYTES` together with the staging budget and the disk.

  Documents over 1 GiB are already refused by the ordinary verified door today.
- Opening four audit artefacts at once takes four of the eight slots. Their sizes are summed against
  the staging budget, so one large audit export can queue other downloads for up to 30 s, then 503.

### 3.6 Compatibility

| Surface | Effect |
| --- | --- |
| Report and audit API responses | Same shape. `url` points at `/api/v1/downloads`, which the proxy already routes to the API (Phase B) |
| Report and audit web screens | Unchanged: `window.open` follows a verified link as well as a store URL |
| Bulk links API | **Breaking:** no `url` in the list. The web panel changes in the same release; nothing else calls it |
| Old links in flight | `DOCUMENT` tokens without `kind` still redeem; old signed store URLs keep working for their 300 s |
| Store CORS / R2 | Exports stop needing browser GETs against the store. Only uploads use it then (relevant to Phase C) |
| `STORAGE_SIGNED_URL_TTL_SECONDS` | Still used for uploads and internal reads |

## 4. Tests the change would carry

- **Token:**
  - round trip per kind;
  - a missing kind decodes as `DOCUMENT`;
  - an unknown kind is refused;
  - a tampered kind breaks the signature.
- **Redemption (integration, real PostgreSQL):** for each kind, every check in §3.3 refused once:
  - another person's report export;
  - not COMPLETED;
  - a lost catalogue permission;
  - `audit:export` revoked;
  - an artefact name not in the export;
  - a `fileObjectId` swapped;
  - a changed `permissionVersion`.
- **Delivery against MinIO (integration):**
  - a report export and each audit artefact served byte for byte;
  - each swapped and each deleted: 0 bytes and quarantine;
  - the store down: 503, no quarantine;
  - `FILE_DOWNLOAD_SERVED` written only on a full send.
- **Bulk:**
  - E-1: a document at a level without download is not offered, and `POST /content` refuses it;
  - E-2: a non-export or unfinished operation is refused;
  - E-3: 1,500 items are all listed (paged);
  - E-5: one refused artefact writes no issued rows.
- **Phase B browser cases:** report and audit exports now follow `/api/v1/downloads` (the B-10
  expectation inverts), and the tamper cases are added for exports.

## 5. Order of work (proposed)

1. E-1 and E-2 as a small security fix (independent; can precede everything).
2. Token kind and the redeemer dispatch, with no new caller yet (behaviour unchanged).
3. Report exports onto verified links (smallest: one artefact, an own export).
4. Audit exports, with the all-or-nothing issue (E-5).
5. Bulk: the list without URLs, issuing links on click, paging, `BULK_DOWNLOAD` (E-3, E-4).
6. Remove the signed-URL path for these three routes, and rerun Phase B.

## 6. Decisions for the owner

1. Approve E-1/E-2 as a separate security fix ahead of this design.
2. Exports over `DOWNLOAD_MAX_FILE_BYTES`: options (a), (b) or (c) in §3.5.
3. Audit-export ownership: keep "any `audit:export` holder" or restrict to the requester.
4. Whether the bulk manifest (E-6) should be downloadable, and by whom.
5. The `EXPORT_INTEGRITY_FAILED` wording, English and Arabic.

ADR-0026 stays **Proposed**. Nothing here claims production readiness.
