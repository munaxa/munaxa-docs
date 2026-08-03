# Audit module

**Answers:** What happened, when, by whom — provably?

| | |
| --- | --- |
| **Owns** | AuditEvent, the hash chain, evidence export |
| **Depends on** | — (written by every module through the audit port) |
| **Binds in core** | `AUDIT_WRITER` — it owns the chain, so it owns the only way to append to it. |

## Layers

```text
audit/
├── audit.module.ts   composition for this module
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
| `audit.chain-verified` | A verification pass completed; carries the range and the count. |
| `audit.chain-broken` | A digest failed to recompute. Highest severity, immediate alert. |
| `audit.export-ready` | An evidence bundle is available for download. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
