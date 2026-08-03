# Modules

One shape for every module, so a reviewer never has to learn a module in order to review it:

```text
<module>/
├── <module>.module.ts
├── domain/           entities, value objects, pure rules, events — no Nest, no Prisma
├── application/      use cases and the ports this module declares
├── infrastructure/   Prisma repositories and adapters implementing those ports
└── presentation/     controllers, DTOs, OpenAPI decorators, view mappers
```

Each module's `README.md` states what it owns, what it depends on, and which core port it
binds. The dependency direction between modules is fixed by
[`02-backend-architecture.md` §3](../../../../docs/architecture/02-backend-architecture.md):
**a module may call downward and publish upward.** Cross-module calls go through the owning
module's application service or a domain event — never into its repositories or its Prisma
models. The rule is enforced by `apps/api/eslint.config.mjs`, not merely written here.

| Module | Answers |
| --- | --- |
| [identity](./identity/README.md) | Who is this person, and what may they do anywhere? |
| [organization](./organization/README.md) | Where in the organisation does this belong? |
| [administration](./administration/README.md) | How is this tenant configured? |
| [library](./library/README.md) | Where do documents live, and who may reach into that place? |
| [document](./document/README.md) | What is this document, in the business's terms? |
| [revision](./revision/README.md) | What did it look like at each controlled point in time? |
| [workflow](./workflow/README.md) | Who must agree before this becomes official? |
| [storage](./storage/README.md) | Where are the bytes, and are they intact? |
| [preview](./preview/README.md) | What does it look like, without downloading it? |
| [search](./search/README.md) | How is it found? |
| [audit](./audit/README.md) | What happened, when, by whom — provably? |
| [notification](./notification/README.md) | Who needs to be told? |
| [retention](./retention/README.md) | How long must it be kept, and what happens then? |
| [reporting](./reporting/README.md) | What is the state of the whole? |
| [dashboard](./dashboard/README.md) | What needs my attention right now? |

## Where "Security" lives

Security is deliberately **not** a module. Authentication, tenant isolation, RBAC, ACL
resolution, the policy engine, audit writing, rate limiting and security headers are
cross-cutting: every request passes through them, and no module owns them. They live in
[`core/`](../core) — `auth/`, `tenancy/`, `authorization/`, `audit/`, `security/` — and the
data behind a decision is owned by the module that owns the data (ACL entries by Library,
entitlements by Administration, sessions by Identity).

A "security module" would either duplicate that data or become a module every other module
must call sideways, which is the coupling the boundaries exist to prevent.
