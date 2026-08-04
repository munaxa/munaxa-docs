# Preview module

**Answers:** What does it look like, without downloading it?

| | |
| --- | --- |
| **Owns** | PreviewArtifact, thumbnails, OcrResult |
| **Depends on** | Storage |
| **Binds in core** | `RENDERER_REGISTRY` — renderers are plugins, registered per format. |

## Layers

```text
preview/
├── preview.module.ts   composition for this module
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
| `preview.rendered` | Artefacts exist for a revision and can be served. |
| `preview.failed` | Rendering hit a limit or an unsupported format; the reason is operator-visible. |
| `preview.ocr-completed` | Extracted text is available to the search projection. |

## Phase 3 — the upload-time thumbnail, and only that

Page images, PDF renditions, extracted text and the viewer that shows them are Phase 7's.
`RENDERER_REGISTRY` is still unbound, and correctly so: a registry with one entry that is not a
plugin would be a registry shaped by its single caller.

What Phase 3 builds is the `preview_artifact` table and one producer for it, so a document uploaded
today has a thumbnail and Phase 7 inherits a schema rather than a migration.

### It never fails a document

That is the whole contract of `DOCUMENT_THUMBNAILER`, which is why the port returns nothing. A
thumbnail is a decoration that makes a grid legible and carries no information the document does not
already have; a create rolled back because a preview could not be drawn would lose a document in
order to protect a picture. Every failure path here ends in a logged warning and a document with no
thumbnail — which is an ordinary state every client already renders, since a Word document has never
had one.

### PNG only, and the encoder is written out

The narrowness is deliberate. A PDF's first page, an Office document's cover and a DWG's viewport
each need a renderer — a PDF engine, a headless office suite, a CAD library — and every one of those
is a sandboxed subprocess with CPU, memory and time caps. That is a phase's worth of work, and
building a fraction of it here would mean building the fraction with no sandbox.

`sharp` is the obvious dependency and is deliberately not used: it is a native binding that has to
build or download per architecture, which is exactly the dependency an air-gapped on-premise
installer meets badly. A box-filter downscale and a PNG encoder are about two hundred lines of
arithmetic with no dependency at all — and the decoder refuses a decompression bomb from the header,
before it allocates anything.

The trade is recorded rather than hidden: **every other raster format has no thumbnail until Phase
7** brings a renderer that handles it properly. A hand-written JPEG decoder would be the wrong trade
in the other direction.
