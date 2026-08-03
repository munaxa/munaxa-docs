# Administration module

**Answers:** How is this tenant configured?

| | |
| --- | --- |
| **Owns** | DocumentType, Category, MetadataField, NumberingRule and its sequences, RetentionPolicy, ConfidentialityLevel, TenantSettings |
| **Depends on** | Organization |
| **Binds in core** | `POLICY_EVALUATOR` and `FEATURE_FLAGS` — entitlements and settings are tenant configuration, which this module owns. |

## Layers

```text
administration/
├── administration.module.ts   composition for this module
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
| `administration.document-type-changed` | Affects future documents only; documents already created keep their frozen policy. |
| `administration.numbering-rule-changed` | Never renumbers anything that exists. |
| `administration.settings-changed` | Invalidates configuration caches for the tenant. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
