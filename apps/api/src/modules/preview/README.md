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

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
