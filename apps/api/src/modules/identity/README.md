# Identity module

**Answers:** Who is this person, and what may they do anywhere?

| | |
| --- | --- |
| **Owns** | User, Role, RolePermission, UserRole, sessions, MFA enrolment, Delegation |
| **Depends on** | — (nothing; every other module depends on it) |
| **Binds in core** | `TOKEN_VERIFIER` — it owns sessions and signing keys, so core declares the port and this module supplies it. |

## Layers

```text
identity/
├── identity.module.ts   composition for this module
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
| `user.created` | A user record exists; it may not have signed in yet. |
| `user.disabled` | Sessions are revoked and the user holds no access from this moment. |
| `user.roles-changed` | Forces permission re-evaluation and cache invalidation. |
| `delegation.approved` | The delegate may act for the delegator within the stated scope and period. |
| `delegation.revoked` | Ends a delegation before its end date. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
