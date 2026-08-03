# Storage module

**Answers:** Where are the bytes, and are they intact?

| | |
| --- | --- |
| **Owns** | FileObject, UploadSession, dedupe, the antivirus gate |
| **Depends on** | — (the StoragePort only) |
| **Binds in core** | Nothing in core. It is the only module that calls `STORAGE_PORT` and `ANTIVIRUS_PORT`. |

## Layers

```text
storage/
├── storage.module.ts   composition for this module
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
| `storage.file-created` | Bytes are stored and checksummed; scanning may still be pending. |
| `storage.scan-completed` | Carries the verdict; only CLEAN makes content reachable. |
| `storage.file-quarantined` | Infected content was isolated and an incident raised. |
| `storage.checksum-mismatch` | Stored bytes no longer match their recorded digest — highest severity. |

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
