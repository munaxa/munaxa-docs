# Search module

**Answers:** How is it found?

| | |
| --- | --- |
| **Owns** | The index projection, query, permission filtering, saved searches |
| **Depends on** | Document, Preview |
| **Binds in core** | `SEARCH_PORT` and `INDEX_PORT` — PostgreSQL today, an external engine later, behind the same port. |

## Layers

```text
search/
├── search.module.ts   composition for this module
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
| `search.document-indexed` | The read model reflects the document as of a point in time. |
| `search.rebuild-completed` | A full projection pass finished; carries the count. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
