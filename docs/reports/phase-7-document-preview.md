# Phase 7 — Document Preview: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Document Preview phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 8 and after, and whoever audits what Phase 7 claimed.

Phase 7 inherited a module that was almost entirely seam. `preview_artifact` had carried its
final shape since Phase 3, with exactly one producer — the upload-time PNG thumbnail whose
encoder is hand-written because a native binding is what an air-gapped installer meets badly.
`RENDERER_REGISTRY` sat declared in core with nothing bound to it, deliberately: "a registry
with one entry that is not a plugin would be a registry shaped by its single caller." The
queue catalogue had carried `documents.preview` and `documents.ocr` since Phase 0.5, separated
by cost so OCR cannot starve rendering; Phase 4 built the dispatcher and the adapter; Phase 6
made the revision events real. `preview.rendered`, `preview.failed` and `preview.ocr-completed`
were declared with nothing publishing them. The confidentiality level had carried `allow_print`
and `watermark` since Phase 2 with nothing reading either. What this phase did was make all of
it true — and the thumbnail's precedent governed every engine choice along the way.

## 1. The registry, which was the seam

Four plugins bind the registry, each claiming its formats through `supports(mime)` and knowing
nothing about documents, permissions or tenants: `munaxa-pdf`, `munaxa-office`, `munaxa-image`,
`munaxa-text`. Adding a renderer is one class and one registration in the module factory; a
failing renderer degrades only its own formats. The dispatching `PreviewPort` is the registry
and nothing else — the choice of renderer is made per file, never per deployment.

**The renderer contract settled on bytes, and the skeleton port was replaced to say so.** The
Phase 0.5 sketch had renderers exchanging storage *keys*, which would have handed every plugin
a reach into storage — the opposite of 14 §5's least-privilege row. The orchestrator now
fetches the source through a presigned URL for that one blob (the same path a browser takes),
hands the renderer bytes and limits, and stores what comes back as derived `FileObject`s. A
renderer *cannot* hold a credential rather than being told not to. The same procedure as
Phase 6's drifted revision ports, recorded for the same reason: the next phase that trusts a
skeleton port's shape over the built one will repeat it. `OcrPort` was corrected identically.

**The server rasterises nothing, and that decision shaped the whole pipeline.** A page raster
needs a canvas; a canvas in Node is a native binding. So the PDF path stores the *rendition* —
for a PDF source, the source itself, referenced rather than copied, since the content-addressed
store would refuse the byte-identical duplicate anyway — and the browser's own canvas draws it,
one page at a time, through pdf.js bundled into the workspace (no CDN; the air-gapped
constraint again). The server reads only the text layer, through the one renderer dependency
this phase pulls in rather than writes out: `pdfjs-dist`, pure JavaScript, no native binding —
a PDF parser is years of format, not the two hundred lines the PNG codec was. `pdf-lib` (also
pure) is the other: it embeds images into renditions and stamps watermarks.

**Office splits into a parse and an engine, degrading independently.** Text is a parse: every
OOXML document is a ZIP of XML whose text lives in specification-fixed tags, so a hand-written
ZIP reader (~170 lines over `node:zlib`, refusing bombs from the header before inflating — a
`.docx` bomb is a `.zip` bomb with a different extension) and a tag scan extract words in every
deployment, per slide for presentations because slides *are* pages. Pagination is an engine:
`OFFICE_DRIVER=LIBREOFFICE` converts to PDF in a subprocess per conversion — killed at the wall
clock, throwaway profile, macros never executed, environment reduced to `PATH` and a temp
`HOME` — and the converted PDF's own text layer supersedes the raw parse, because it is the
same words paginated the way the reader will see them. `OFFICE_DRIVER=NONE` degrades honestly:
extracted text, a text-pane preview, no rendition — the same posture as `AV_DRIVER=NONE`.
Legacy `.doc`/`.xls`/`.ppt` are claimed only when a converter exists to read them; without one
they land on 14 §7's unsupported-format row, which is the honest answer for a binary format
only an office suite can open.

**DWG has no renderer, deliberately.** 14 names a CAD renderer and the phase brief demands the
format; the decision is recorded here instead. Every real DWG engine is either proprietary
(ODA) or a native toolchain, both exactly the dependency the installer meets badly — for a
format whose fidelity errors are the kind an engineer acts on. A half-sandboxed CAD engine
rendering a drawing *almost* right is worse than 14 §7's unsupported-format row: no preview,
download offered where permitted, the UI saying so. Adding one later is one plugin. TIFF is
the same decision at smaller stakes — browsers cannot draw it, decoding it server-side is a
codec to own, and a configured OCR engine reads it directly, so a scanned TIFF becomes
searchable text without becoming a picture.

## 2. The pipeline, which was the wiring

14 §2's diagram runs. The outbox dispatcher now fans an event to a *list* of lanes:
`revision.created`, `revision.published`, `revision.restored` and `document.created` go to
`documents.preview` beside `search.index` — one fact, two lanes, two costs. The `EventRoute`
registry the outbox port declares stays deliberately unbuilt: Phase 4 chose prefix routing and
recorded why (a per-module registration nothing would notice missing), and what this phase
needed was a second lane per prefix, not a registry — the decision held under its first real
test. Job identifiers gained the lane (`outbox:<row>:<lane>`) so the fan-out cannot collide.

**The event payloads widened, compatibly.** `revision.created` and `revision.restored` gained
`fileObjectId`; `document.created` gained `revisionId` and `fileObjectId`, because ordinal
zero publishes no revision event (`createInitial` predates the revision cycle) and this event
is where the pipeline hears about a new document's content. Adding fields to a frozen payload
is a widening, not a shape change; consumers of the old shape read on.

**The consumer follows Phase 4's precedent exactly.** `PreviewConsumer` lives in the API
process (`apps/worker` is still the skeleton; a consumer is a thin wrapper around a use case,
and moving it is a deployment change), establishes its own system context, treats a malformed
payload as unretryable, and keeps idempotency in the database. A restore fires
`revision.created` *and* `revision.restored` for one revision — the Phase 6 report's cost
table says so — and the second delivery finds the work done.

**Antivirus first, below the use case.** Nothing renders before the verdict is `CLEAN`,
checked before a byte is fetched. The content-gate trigger already makes an unclean revision
hard to construct; the check exists for the extraordinary case — an event replayed across a
quarantine — and the refusal is recorded as a `FAILED` render with the reason, never silently.
The integration suite hands the handler an unscanned blob and counts zero artefact rows.

**`preview_render` is the row behind "202 with status".** One row per revision, upserted by
the consumer: `PENDING` while the queue works, `READY` with renderer, version and page count,
`FAILED` with an operator-readable reason, `UNSUPPORTED` as a terminal answer rather than a
failure. It is the first thing in the codebase to answer HTTP 202.

## 3. The defect this phase found in its inheritance

**`uq_preview_artifact` could not hold its own promise.** The Phase 3 index on
`(revision_id, kind, page)` treats NULL pages as distinct — the PostgreSQL default — so the
rows whose page is NULL (a thumbnail, a rendition, unpaginated text) were not actually unique:
a redelivered render could have stored two thumbnails for one revision and nothing could say
which was current. The migration recreates the index `NULLS NOT DISTINCT` (the same reasoning
that put `uq_document_lock_live` in raw SQL: Prisma cannot express it), and the suite proves
it by raw insert, bypassing every use case.

The suite also caught this phase's own version of the same class: the first cut of artefact
saving re-referenced an unchanged blob on redelivery, growing `ref_count` by one per delivery.
The repository now answers `CREATED | UNCHANGED | REPLACED` and the service counts references
only for what actually happened — asserted in rows, twice, with the short-circuit disarmed.

## 4. The decisions the specification left open

**Artefacts that are the source are references, not copies.** A PDF's rendition and an image's
single page *are* the source blob; the artefact row points at it and `ref_count` moves by one,
exactly as restore taught in Phase 6. The schema comment that said `ref_count` counts
"revisions and preview artefacts" is finally true — every artefact row references its blob, so
`listUnreferenced` can never sweep a blob a viewer still draws.

**The watermark is per user, per request, cached never.** 14 §4 allowed a shared, time-stamped
mark cached once; this deployment takes the stronger one. The stamp (diagonal "CONTROLLED
COPY", the viewer, the instant, the document number) is burned into the rendition at the
stream endpoint per request — milliseconds against a size-capped rendition, traded for a mark
that always names who was looking. Nothing watermarked is ever stored, so nothing watermarked
can be served to the wrong viewer by a cache. The stamp is drawn with a PDF standard font,
which carries WinAnsi and nothing else: a viewer whose display name is Arabic is identified by
their account email rather than silently omitted, and embedding a shaping-capable Arabic font
is the recorded improvement, not this phase's.

**Preview URLs are minted capabilities, not presigned storage URLs.** A watermark must live
inside the bytes — a mark the client composites is a mark a client omits — and storage's own
presigned URLs cannot stamp. So the issued URL points at a preview stream endpoint and carries
a domain-separated HMAC token naming one artefact, one disposition, one expiry, and the mark
to burn: the `LOCAL` transfer token's construction, reused because it is the one pattern in
the product already written for "the token is the credential". Single-page by construction —
no token lists a directory, and each page's URL comes from the API, which re-checks
permission, state and confidentiality on every issuance. The stream serves the artefact's real
content type: 11 §2's octet-stream rule is about original files, and a rendered artefact
displayed is the entire point of the preview path.

**Permission → state → confidentiality, in three places on purpose.** Permission is the
route's: `document:view` for preview — deliberately *not* `document:download`, because preview
is what "readable, not downloadable" means — plus `document:history:view` for the
revision-addressed routes, plus `document:print` for print. State is the use case's: readers
are served the current (published) revision exactly as downloads are, and a revision addressed
through the wrong document gets nonexistence, not a hint. Confidentiality is last and
subtract-only: `allow_print = false` refuses a caller who holds the permission (the same
construction as downloads), and `watermark = true` on a format with no rendition to stamp
refuses the preview honestly rather than serving unmarked bytes. `ConfidentialityView` gained
the `watermark` column the adapter had never projected.

**The audit decisions.** A *served* view writes `DOCUMENT_VIEWED` with a preview-marked
payload, gated by `audit.readEventsAboveRank` — that setting's first consumer since Phase 1
declared it; below the rank the issuance is a plain read, because serving an unclassified
notice must not cost a hash-chained row per page turn. `open()` keeps writing `VIEWED`
unconditionally for the record being opened, unchanged — two events for two facts, not a
second read event invented. A print writes 13 §2's `PRINTED` row, made real as
`DOCUMENT_PRINTED`, unconditionally, because 13 says prints always are. Prints go through the
rendition, never the original, so the mark survives the paper.

**OCR runs where the cheap parse found nothing.** The threshold is deliberately crude — forty
characters, less than a sentence — because OCR on a document with a real text layer would
replace nothing and still cost the slow lane. Output lands as an `OCR` artefact (the kind the
enum gained this phase) with engine, version, language and mean word confidence in
`ocr_result`; below seventy the UI flags the text as a low-confidence read rather than the
document's words. `OCR_DRIVER=HOSTED`, accepted by the schema since Phase 0.5, now refuses at
boot naming the variable — no hosted adapter exists, and a value that boots but never extracts
would be `NONE` wearing a different name. The Tesseract adapter is a subprocess against a
system binary (`OCR_TESSERACT_PATH`), not a WASM build, because the WASM distributions fetch
their engine and language data from a CDN at runtime — the one thing the target deployment
cannot do.

**The compare contract filled in the way Phase 6 shaped it.** `text.state` widened from
`['UNAVAILABLE']` to `['UNAVAILABLE','PENDING','AVAILABLE']` — additive, the contract stable.
`AVAILABLE` carries paragraphs aligned by LCS with word-level spans inside changed pairs,
capped at a thousand paragraphs per side and saying so when truncated (truncation forfeits the
claim of identity). `PENDING` is 10 §4's queued comparison kept literally: the render pipeline
is the queue, and the UI says "queued" rather than showing a partial diff. `pages.comparable`
is the rendered-pages row: the client fetches each side's preview per click, because a URL in
a compare response would be an unaudited issuance. A side read by OCR flags the whole
comparison as an inference.

## 5. What was built

| Piece | What it does |
| --- | --- |
| `prisma` — `preview_render`, `ocr_result`, `OCR` kind, `uq_preview_artifact NULLS NOT DISTINCT` | One migration: the status row behind 202, the OCR metadata, the repaired uniqueness |
| `ports/preview.port.ts`, `ports/ocr.port.ts` | The byte-based contracts, replacing the storage-key sketches |
| `preview/domain` — `zip.ts`, `ooxml.ts`, `preview-stream-token.ts`, `watermark-text.ts`, `text-quality.ts`, `ocr-quality.ts` | The hand-written parsing and the pure rules: archive caps, OOXML text, the stream capability, WinAnsi fallback, the OCR thresholds |
| `preview/infrastructure` — four renderers, the registry, the LibreOffice converter, the watermark stamper, the Prisma repositories, the consumer | The plugins and their plumbing |
| `preview/application` — `render.service.ts`, `ocr.service.ts`, `preview-query.service.ts` | Orchestration: fetch, dispatch, store, record, publish; the OCR use case; the read side the document module serves from |
| `TesseractOcrAdapter`, `ocrAdapterFor` | `OCR_DRIVER=TESSERACT` as a capped subprocess; `HOSTED` refused at boot |
| Outbox dispatcher — `routesFor` | Multi-lane fan-out; `preview.*` routed to `search.index` for Phase 8 |
| Revision events + `document.created` | `fileObjectId`/`revisionId` widening, so the consumer renders from the payload |
| `document/application/document-preview.service.ts`, `presentation/document-preview.controller.ts` | Permission → state → confidentiality; manifest, content, print, text routes; the codebase's first 202 |
| `preview/presentation/preview-stream.controller.ts` | Where a minted URL is redeemed and the watermark burned in; `@Public` under the transfer-token bargain |
| `revision/domain/text-diff.ts`, compare wiring | Paragraph LCS with word spans; `text.state` and `pages.comparable` served |
| Contracts — `documents/preview.ts`, compare widening | Manifest, content, text shapes; `PreviewState`; the 202 body |
| Config — `OFFICE_DRIVER`, `OCR_TESSERACT_PATH`, `OCR_LANGUAGES`, `PREVIEW_*` caps | Every engine a deployment decision, every cap tunable |
| Web — `features/preview/` (panel + three panes), the `preview` slot, compare text UI | The modular viewer: zoom, rotate, page navigation, in-document search from the extracted text, fullscreen, print through the rendition; polling the 202 away; EN and AR in the same commit |

One migration; no new permission (`document:print` was in the catalogue since Phase 1); the
`UnconfiguredPreviewAdapter` and its dangling `PREVIEW_DRIVER` reference deleted — rendering
is built in, and the deployment decisions are the engines, not the feature.

## 6. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **Artefact bytes pass through the process** | The orchestrator fetches sources and streams artefacts through memory; the stream endpoint buffers a rendition to stamp it | Bounded by `PREVIEW_MAX_SOURCE_BYTES` / `PREVIEW_MAX_OUTPUT_BYTES`; the thumbnailer set the precedent and the reasoning — there is no client to presign for bytes the server itself makes |
| **A watermarked view stamps per request** | No cached variant exists, by decision §4 | Milliseconds against a capped rendition; revisit with a per-user cache only if serving cost ever shows up in numbers |
| **Text pages are read back blob by blob** | In-document search and compare fetch each `TEXT` artefact through storage | Artefacts are small and capped; a text column in the database was traded away to keep one artefact pattern. Phase 8's index is the real reader and consumes the event, not the blobs |
| **The render wall-clock abandons, not cancels** | An in-process parser that overruns is abandoned (slot freed, result discarded); only subprocess engines are killed outright | The subprocess engines are the heavy ones; pure-JS parse time is bounded by the source-size caps. OS-level isolation of the worker tier remains the deployment's (20), unchanged by Phase 4's in-process consumer precedent |
| **`search.index` still has no consumer** | Preview events and revision events accumulate there and expire | Phase 8's projection is the consumer; the lane is where it will look — the same position Phase 4 took for notifications |
| **LibreOffice and Tesseract are system packages** | CI installs them; an installer pins them | That is what "deployment decision" means here — `NONE` degrades honestly in both cases, and the suite probes by converting, not by `--version`, so a half-installed suite skips rather than lies |

## 7. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| No server-side page images for PDF and Office | A raster needs a canvas; a canvas in Node is a native binding. The browser draws the rendition | A deployment-decision rasteriser, if a headless consumer (Phase 15 reporting?) ever needs pixels server-side |
| DWG, TIFF, ZIP not previewable | §1's DWG decision; TIFF has no browser and OCR reads it directly; an archive is not a document | A CAD renderer plugin; a TIFF decoder if the viewer ever must draw scans |
| An image-only PDF is not OCR-read | Tesseract reads rasters; rasterising PDF pages is the job the server deliberately does not do | The same rasteriser as above, or an engine that ingests PDFs |
| Non-PNG thumbnails still absent | The Phase 3 trade stands: a hand-written JPEG decoder is the wrong trade in the other direction | A rasteriser would make first-page thumbnails a by-product |
| Text-mode print is the browser's | Plain text and unconverted Office preview as a text pane; printing the pane is printing the preview, but no server-side rendition carries the mark | A text-to-PDF layout with Arabic shaping — the same font work as the watermark improvement |
| Watermark text is WinAnsi | Standard fonts carry no Arabic; the viewer's email is the fallback identity | Embedding a shaping-capable font (`@pdf-lib/fontkit` + a vendored Noto subset) |
| Renderer upgrades re-render nothing automatically | `renderer`/`renderer_version` are recorded per artefact; 14 §7's regeneration campaign is an operator act with no tooling yet | The phase that needs a campaign builds the sweep |
| Quota accounting still does not exist | Phase 21's; what this phase guarantees is the exclusion key — every artefact `derived = true` under `derived/`, asserted in rows | Phase 21 sums `derived = false` and inherits the exclusion for free |
| Search consumes nothing yet | This phase produces `TEXT`/`OCR` artefacts and publishes the events; consuming them is Phase 8's, by the brief | Phase 8 |
| Retention, legal hold, delegation, notifications, the designer | Out of scope, named by the brief | Phases 9/10, 11, 12, 16 |

The Phase 6 report's "Text and page comparison `UNAVAILABLE`" limit row is discharged by this
phase — the compare API serves both from the artefacts this phase renders. That report is
historical and stands unedited; this line is its discharge.

## 8. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 362 API tests (up from 327 — the renderers against real files of every format, the ZIP caps, the paragraph diff, the stream token, the watermark stamp), 88 domain tests, 26 contract tests, 21 web tests |
| `pnpm test:integration` | 21 files / 349 tests (up from 20 / 331) against real PostgreSQL, two tenant databases |
| `pnpm build` | Clean, API and web — including the bundled pdf.js worker |
| `pnpm prisma:deploy` | Verified against two tenant databases, including the new migration and the recreated unique index |

The renderer suite runs against real files of each format — a PDF written by a real PDF
library, OOXML fixtures that are genuine ZIPs of the specification's parts (LibreOffice opens
and converts them in the same suite, where a probe finds a working binary), the product's own
PNG, a byte-exact libjpeg JPEG, a DWG signature for the refusal path.

`preview-pipeline.integration.spec.ts` carries the phase's own assertions, and each asks
something only the database or the filesystem can answer: a render against an unscanned blob
refused, recorded `FAILED`, zero artefact rows; redelivery — including with the READY
short-circuit disarmed — writing no second row and moving no reference count; the raw insert
of a second page-less artefact refused by `uq_preview_artifact` itself; derived blobs
`derived = true` under the `derived/` prefix with the source's count at exactly its references;
`preview.rendered` and `preview.ocr-completed` committed transactionally with their rows; OCR
queued only where extraction found nothing, recorded once, flagged low-confidence; a level
that forbids download still previewing, watermarked, with the viewer named in the issued
token; print refused by the level with no `PRINTED` row, permitted elsewhere with exactly one;
a revision addressed through the wrong document answered as nonexistence; and the compare
API's text state `AVAILABLE` from rendered artefacts and `PENDING` — queued, said out loud —
while a side still renders.
