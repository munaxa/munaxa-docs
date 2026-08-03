# Revision module

**Answers:** What did it look like at each controlled point in time?

| | |
| --- | --- |
| **Owns** | DocumentRevision, compare, restore |
| **Depends on** | Document, Storage |
| **Binds in core** | Nothing in core. |

## Layers

```text
revision/
├── revision.module.ts   composition for this module
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
| `revision.created` | A new draft revision exists beneath its document. |
| `revision.published` | This revision is effective; the previous one is superseded. |
| `revision.superseded` | No longer effective, still readable with history permission. |
| `revision.restored` | A new revision was created carrying an older revision\u2019s content. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
