# Export downloads outside verified delivery — the gap, its risk, and the options

- **Status:** **Assessment for review. Nothing here is implemented.** The routes below still use
  direct signed-storage URLs.
- **Date:** 2026-10-14
- **Context:** [ADR-0026](../architecture/adr/0026-hetzner-hosting-evaluation.md) §10; the verified
  delivery is described in
  [`hetzner-download-integrity-proposal.md`](hetzner-download-integrity-proposal.md) and was
  implemented for document and revision downloads only (`5ce5185`).

## 1. What is and is not verified before sending

A **verified download** is read whole from the store, hashed, and sent only if its size and SHA-256
equal the record. The person is re-authorized when the link is followed, and the link lives 60 s
(`DOWNLOAD_LINK_TTL_SECONDS`).

These do **not** have that guarantee. Each returns a **signed store URL**, valid 300 s
(`STORAGE_SIGNED_URL_TTL_SECONDS`), that the browser follows straight to the object store:

| Route | Called by | What the URL serves | Checks at issue | Audit |
| --- | --- | --- | --- | --- |
| `GET /api/v1/documents/bulk/:id/links` (`bulk-export.service.ts` `links()`) | The bulk panel (`bulk-panel.tsx`), one link per document | **Document content** (each selected document's current or latest revision) | Own operation; `document:download`; ACL per document; scan; integrity status; HEAD (size, store checksum or age) | `FILE_DOWNLOAD_ISSUED` per document |
| `GET /api/v1/reports/exports/:id/download` (`reporting.service.ts` `downloadExport()`) | The reports screen, opened in a new tab with `window.open` | A report export (CSV, SpreadsheetML, PDF) the product wrote | Own export, COMPLETED; report permission; integrity status; HEAD | `FILE_DOWNLOAD_ISSUED` |
| `POST /api/v1/audit/exports/:id/download` (`audit-export.service.ts` `download()`) | The audit screen; one tab per artefact | Audit evidence bundle artefacts (streamed, multipart) | `audit:export`; COMPLETED; integrity status; HEAD per artefact | `BULK_DOWNLOAD`, with the artefacts' digests, plus `FILE_DOWNLOAD_ISSUED` per artefact |

The API also reads stored objects through signed URLs it follows itself: thumbnails, renditions,
OCR and preview text. Those bytes go to the API, not to a person. The preview stream, which does
serve people, hashes the whole artefact and refuses a mismatch before it sends (Phase A).

## 2. Risk

- **The window.** The HEAD check at issue catches an object that is missing, the wrong size, or has
  the wrong store checksum. Where the store holds no checksum, it catches an object rewritten since
  it was last vouched for. It cannot catch bytes changed during the URL's 300 s lifetime, and it
  never re-hashes. The 60 s verified link closes this window for ordinary downloads; these routes
  keep it.
- **Exports have weaker evidence to start with.** Report and audit exports are written by the API as
  streamed multipart uploads, and the store keeps no whole-object SHA-256 for them. The HEAD check
  therefore falls back to size and last-modified time. A same-size rewrite after issue, or one the
  store timestamps no later than the record, is served.
- **Bulk links are document content.** They are the same bytes as an ordinary download, so the bulk
  route is a second door to documents that does not have the verified door's guarantee. This is the
  most significant of the three.
- **Bearer lifetime.** Each URL works for whoever holds it for 300 s, with no re-authorization when
  it is followed (the verified link has 60 s and re-checks).
- **Mitigations already in place:**
  - Every issue is audited.
  - The nightly verifier re-hashes stored objects up to `STORAGE_INTEGRITY_MAX_BYTES` (128 MiB).
    Since `6973984`, larger ones are recorded UNVERIFIED rather than quarantined; they are not
    re-hashed.
  - Audit bundles carry their own digests in `BULK_DOWNLOAD`, and the evidence bundle has a
    manifest an auditor can check offline.
  - None of these stops a person receiving changed bytes inside the window.

**Assessment.** Moderate for bulk links: document content, many links at once, and the same threat
the verified path was built against. Lower for report exports: derived data the requester can
regenerate. Lower again for audit exports, whose integrity can be checked independently against the
digests in the trail and the bundle's own manifest.

## 3. Options (not decided, not implemented)

| Option | What it takes | Trade-offs |
| --- | --- | --- |
| **A. Move bulk links onto verified delivery.** Each link becomes a verified API link, redeemed through the same re-authorization (document and revision scope already exist) | Small: `links()` calls `downloadLink`. But links are listed together and followed later, so a 60 s lifetime is short for a list; the panel would mint links on click, not as a list | Closes the gap for document content. Each bulk file costs a staged verification and passes through the API twice |
| **B. Verified delivery for exports.** Generalise the link scope beyond documents: an export id, the requester, and the export's own permission | Medium: a second redemption path (report: own export plus report permission; audit: `audit:export`), and its tests | Closes the window for exports. Large audit bundles mean large staging; `DOWNLOAD_MAX_FILE_BYTES` would refuse bundles over 1 GiB, so it would need sizing |
| **C. Shorten `STORAGE_SIGNED_URL_TTL_SECONDS`** for these routes (e.g. 30 s) | Configuration | Narrows the window, does not close it; the browser must follow at once |
| **D. Keep as is, documented** | None | The window and the weaker export evidence remain; acceptable only as an explicit decision |

**Recommendation for the owner's decision:** A soon, because bulk links are documents. B for report
exports when convenient. For audit exports, either B or D: they can be verified independently.
C is a stop-gap only.

## 4. What Phase B shows about these routes

The report and audit export cases (B-10) check that the browser saves exactly what the store
serves. **That is not a verification against the record**, and the Phase B results do not claim
one.

Run 3 (2026-10-14) passed both:
- `documents.csv` (3243 bytes) and `events.jsonl` (126 941 bytes) were saved identical to the
  stored objects.
- Each was followed through a direct signed store path (`/munaxa-docs-test/…/evidence/…`), not
  `/api/v1/downloads`. That confirms these routes are outside verified delivery.

Bulk links were not exercised in the browser. Nothing in this section has changed in the code.

## 5. Design and defects found since (2026-10-15)

The design for moving these routes onto verified delivery is
[`hetzner-export-verified-delivery-design.md`](hetzner-export-verified-delivery-design.md),
revision 2. It is a design and implementation plan only; nothing in it is implemented.

- **Fixed:** E-1 (bulk links skipped the confidentiality level) and E-2 (bulk links checked
  neither the operation's kind nor its state), in `8c2476a`. That commit also stopped writing
  `FILE_DOWNLOAD_ISSUED` for documents whose content the gate refuses.
- **Still open, and addressed by the design:** E-3 to E-7.
- **Found during the revision:**
  - E-8: a verified link takes its media type from a shared `file_object`.
  - E-9: audit artefacts deduplicate across exports.
  - E-10: a quarantined deduplicated export cannot be recovered by running it again.
  - E-11: the report screen offers Download on other people's exports.
  - E-12: the audit screen's popups are blocked after the first.

**Closed (2026-10-15, local).** The design is implemented on the branch (`88af7a8`–`2c07ee7`): none
of the three routes returns a store URL any more; §1–§4 above describe the code before that. E-3 to
E-9, E-11 and E-12 are fixed; E-10 remains open. See the design's §13 and ADR-0026 §10.
