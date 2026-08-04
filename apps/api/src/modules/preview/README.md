# Preview module

**Answers:** What does it look like, without downloading it?

| | |
| --- | --- |
| **Owns** | PreviewArtifact, PreviewRender, OcrResult, thumbnails, the renderer plugins |
| **Depends on** | Storage |
| **Binds in core** | `RENDERER_REGISTRY` and `PREVIEW_PORT` — renderers are plugins, registered per format. Bound since Phase 7. |

## Layers

```text
preview/
├── preview.module.ts   composition for this module
├── domain/                    entities, value objects, pure rules, events — no Nest, no Prisma
├── application/               use cases and the ports this module declares
├── infrastructure/            Prisma repositories, the renderers, the converters
└── presentation/              the preview stream endpoint
```

The dependency rule points inward, and it is enforced by `eslint.config.mjs` at the app root,
not merely described here. Other modules call this one through its **application service** or
react to its **events** — never through its repositories or its Prisma models.

## Events published

| Type | Meaning |
| --- | --- |
| `preview.rendered` | Artefacts exist for a revision and can be served. |
| `preview.failed` | Rendering hit a limit or an unsupported format; the reason is operator-visible. |
| `preview.ocr-completed` | Extracted text is available to the search projection (Phase 8's consumer). |

All three, declared in Phase 0.5, are published since Phase 7 — from inside the transaction
that records the artefact rows, through the outbox like every other fact.

## Phase 7 — the pipeline, the registry, the viewer's data path

`RENDERER_REGISTRY` stayed deliberately unbound through Phase 3 ("a registry with one entry
that is not a plugin would be a registry shaped by its single caller"). It binds here, with
four genuinely independent plugins:

| Renderer | Formats | What comes out |
| --- | --- | --- |
| `munaxa-pdf` | PDF | The source referenced as its own rendition; the text layer per page. Pages are drawn client-side — a canvas in Node is a native binding, and the browser has a real one |
| `munaxa-office` | Word, Excel, PowerPoint | Text by parsing the OOXML parts directly (no engine needed); a paginated PDF rendition when `OFFICE_DRIVER=LIBREOFFICE`. Legacy `.doc`/`.xls`/`.ppt` are claimed only when a converter exists to read them |
| `munaxa-image` | PNG, JPEG, GIF, WebP, BMP | The source as its own single page; a PDF rendition (watermarkable, printable) for PNG/JPEG; the Phase 3 thumbnail for PNG |
| `munaxa-text` | TXT, CSV | One normalised UTF-8 text artefact; the viewer's text pane is the presentation |

A renderer knows nothing about documents, permissions or tenants: bytes in, bytes out, limits
enforced. Fetching the source through a presigned URL and storing artefacts as derived
`FileObject`s is the orchestrator's (`application/render.service.ts`), which is what keeps a
renderer incapable of holding storage credentials rather than merely told not to.

**What deliberately has no renderer:** DWG/CAD (every real engine is proprietary or a native
toolchain an air-gapped installer meets badly — 14 §7's unsupported-format row is the designed
answer), TIFF (browsers cannot draw it; OCR reads it directly, so it becomes searchable
without becoming a picture), ZIP (an archive is a container, not a document).

**The async half.** `PreviewConsumer` subscribes `documents.preview` and `documents.ocr` — the
lanes the catalogue has carried since Phase 0.5, separated by cost so OCR cannot starve
rendering. The outbox dispatcher routes `document.created` and the `revision.*` events onto
the fast lane. Nothing renders before the scan verdict is `CLEAN`; handlers are idempotent in
the database (`preview_render` upserted per revision, `uq_preview_artifact` recreated
`NULLS NOT DISTINCT` so a page-less artefact really is unique), never in the delivery.

**OCR** (`OCR_DRIVER=TESSERACT`, `ara+eng` by default) runs only when extraction yielded
nothing usable, stores its text as an `OCR` artefact with engine, version, language and
confidence in `ocr_result`, flags low-confidence output rather than presenting it as the
document's words, and never modifies the original. `NONE` degrades honestly, the same way
`AV_DRIVER=NONE` does.

**Serving** stays split on purpose: `PreviewQueryService` answers *what exists and how to
present it*; the document module owns *whether* — permission → state → confidentiality, beside
the download path those words already live in. The stream endpoint
(`presentation/preview-stream.controller.ts`) is where an issued URL is redeemed and where a
watermark (user, timestamp, document number, "CONTROLLED COPY") is burned into the rendition
before a byte leaves — minted per request, cached never: the stronger per-user mark at the
cost of a stamp per view.

### The thumbnail contract is unchanged

`DOCUMENT_THUMBNAILER` still never fails a document, still returns nothing, and the Phase 3
PNG codec is still the encoder — the image renderer reuses it, so a check-in draws a thumbnail
the same way an upload does.
