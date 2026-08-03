# Document module

**Answers:** What is this document, in the business's terms?

| | |
| --- | --- |
| **Owns** | Document, DocumentMetadataValue, Tag, Link, check-out Lock |
| **Depends on** | Library, Administration |
| **Binds in core** | Nothing in core. It is the product's root aggregate and the busiest publisher of events. |

## Layers

```text
document/
├── document.module.ts   composition for this module
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
| `document.created` | A controlled record exists in DRAFT; it has no number yet. |
| `document.submitted` | Handed to the workflow; content is frozen from here. |
| `document.approved` | All stages passed and the number was assigned in the same transaction. |
| `document.published` | This revision is the effective one; the previous one is superseded. |
| `document.rejected` | Terminal for this attempt; no number was issued. |
| `document.checked-out` | Exclusively locked for the next revision. |
| `document.checked-in` | A new draft revision exists beneath the published one. |
| `document.moved` | Folder changed, so inherited permissions changed. |
| `document.archived` | Retired from active use, still readable. |
| `document.deleted` | Soft-deleted and recoverable; the number stays reserved forever. |
| `document.restored` | Returned to the state it was deleted from, never a higher one. |
| `document.number-assigned` | Issued once, at approval, and never reused. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
