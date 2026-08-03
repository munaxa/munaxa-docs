# Library module

**Answers:** Where do documents live, and who may reach into that place?

| | |
| --- | --- |
| **Owns** | Library, Folder, ACL entries on both |
| **Depends on** | Organization, Administration |
| **Binds in core** | `ACL_RESOLVER` — the ACL entries live here, so the resolution algorithm lives with them. |

## Layers

```text
library/
├── library.module.ts   composition for this module
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
| `library.created` | A new governed container exists under an organisation node. |
| `library.folder-moved` | Ancestry changed; inherited permissions and search ACL fingerprints change with it. |
| `library.acl-changed` | Invalidates the permission cache and re-fingerprints affected index entries. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
