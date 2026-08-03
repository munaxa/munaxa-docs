# Retention module

**Answers:** How long must it be kept, and what happens then?

| | |
| --- | --- |
| **Owns** | RetentionSchedule, LegalHold, disposition review, purge |
| **Depends on** | Document, Storage |
| **Binds in core** | Nothing in core. |

## Layers

```text
retention/
├── retention.module.ts   composition for this module
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
| `retention.scheduled` | A disposition date is set for a document. |
| `retention.due` | A schedule reached its date and needs review or execution. |
| `retention.hold-placed` | Disposition is suspended regardless of policy. |
| `retention.hold-released` | The suspension ended; the schedule resumes. |
| `retention.document-purged` | Content destroyed. The audit trail and the number remain. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
