# Reporting module

**Answers:** What is the state of the whole?

| | |
| --- | --- |
| **Owns** | ReportDefinition, read models, exports |
| **Depends on** | Search, Audit, Workflow |
| **Binds in core** | Nothing in core. |

## Layers

```text
reporting/
├── reporting.module.ts   composition for this module
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
| `reporting.export-ready` | A queued export finished and is available for download. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
