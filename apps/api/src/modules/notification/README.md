# Notification module

**Answers:** Who needs to be told?

| | |
| --- | --- |
| **Owns** | Template, NotificationMessage, delivery attempts, preferences, digests |
| **Depends on** | Identity |
| **Binds in core** | Nothing in core. It is the only module that calls `NOTIFICATION_PORT`. |

## Layers

```text
notification/
├── notification.module.ts   composition for this module
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
| `notification.queued` | A message exists for a recipient and channel. |
| `notification.sent` | The provider accepted it. |
| `notification.failed` | Delivery failed; carries whether a retry is worthwhile. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
