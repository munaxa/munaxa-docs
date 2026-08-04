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

## Authentication

Sign-in, refresh and sign-out are implemented; user and role administration, delegation and
MFA are not yet.

| Route | Public | Notes |
| --- | --- | --- |
| `POST /api/v1/auth/login` | yes | Email + password. The refresh token is set as a cookie, never returned in the body |
| `POST /api/v1/auth/refresh` | yes | Rotates the pair. Runs on an expired access token, which is why it cannot be guarded |
| `POST /api/v1/auth/logout` | yes | Revokes the session family. Idempotent |
| `GET /api/v1/auth/me` | no | Behind the global guard; reaching it proves the token verified |

Four properties are load-bearing, and each is tested:

**The tenant is resolved before anything is read.** Sign-in is public, so no token has built a
request context yet — and every repository read is under row-level security keyed on one. The
tenant comes from the host through `TenantDirectory`, which is as far as the host is ever
allowed in: what the caller may then *do* is decided by the signed `tenantId` claim, never by
where the request arrived ([21-saas §5](../../../../../docs/architecture/21-saas-commercial-architecture.md)).
`tenant` is correspondingly the one table with no policy, because it has no `tenant_id` to key
one on.

**Failure is uniform, and costs the same time.** Unknown tenant, unknown address, wrong
password, no password set and disabled account all raise one error. When no user is found a
verification still runs against a decoy hash, so absence is not measurably faster than
presence.

**Refresh tokens rotate, and replay kills the family.** A token that has already been exchanged
means someone captured it; the thief and the legitimate holder are indistinguishable, so both
are signed out. The revocation is committed in its own transaction — doing it in the one that
then throws would roll it back, and the exception reporting the theft would erase the record of
it. That defect existed, passed the unit suite, and was caught only against PostgreSQL.

**Passwords are upgradable.** The scrypt parameters travel with each hash, so raising the cost
re-hashes people on their next sign-in instead of locking them out.

### Cryptography

Both `ScryptPasswordHasher` and `JwtTokenService` are built on `node:crypto` rather than on
libraries. Fixing HS256 as a compared constant makes `alg: none` and algorithm-confusion
structurally impossible rather than configured away, and the most security-critical path in the
product carries no supply-chain surface it does not need. Replacing either — argon2id, a tenant
OIDC issuer, asymmetric keys — is a new class behind the same interface.

## Tests

`pnpm test` runs the unit suite. `pnpm test:integration` runs the real classes against a real
PostgreSQL and needs `DATABASE_URL` and `DATABASE_MIGRATION_URL`; it is excluded from the
default suite because CI has no database. Both roles are required and are not
interchangeable — seeding runs as the owner, and the code under test runs as the application
role so that row-level security is genuinely in force.

The unit suite's `UnitOfWork` double models commit and rollback rather than simply calling the
work. That is deliberate: the double that ignored transactions is what let the revocation bug
through.

## Provisioning

`pnpm --filter @edms/api provision` creates a tenant, a `TENANT_ADMIN` role holding every
permission, and one administrator who can sign in.

This is **not** administration. Creating, editing and deleting users and roles is Phase 2, and
nothing here grows into it: one operation, once per tenant, refusing to run twice. It exists for
the chicken-and-egg problem underneath every access-controlled system — the first account cannot
be created by somebody signed in, because nobody is.

| Decision | Why |
| --- | --- |
| An application context, not a script with its own Prisma client | It runs the real service, hasher, validation and audit writer. A provisioning path that reimplemented any of them would be a second way to create a user, and the second way is the one that skips a rule |
| No HTTP endpoint | "Create an organisation with a full-permission administrator" must not be a request anybody can send |
| Credentials from the environment, never arguments | A password on a command line is in the shell history, in `ps` output, and in whatever collects both |
| One transaction | A tenant with no administrator, or a role nobody holds, is a workspace nobody can enter and nobody can fix |
| The password policy applies | Unlike sign-in, this is a password being *set* — which is exactly what the policy governs |

The role is ordinary data afterwards, and Phase 2 edits it like any other. Provisioning now seeds
**eight** roles from `domain/role-seed.ts` rather than one, so a new tenant starts with a usable
permission matrix instead of a single account holding everything.

`role-seed.ts` seeds only the permission matrix's tenant-wide (`✓`) cells, plus the `own` ones. The
scoped (`S`) cells are deliberately **not** seeded: step 6 of the resolution algorithm falls back to
the tenant-level role grant, so seeding `document:delete` for a library manager would let them delete
any document in a tenant that has no ACLs yet. `TENANT_ADMIN` gets everything except
`document:approve` and `document:reject` — approving is an act, not an administrative power.

## Administration

`USER_ADMIN_SERVICE` (behind `user:manage`) and `ROLE_ADMIN_SERVICE` (behind `role:manage`) own people
and access: create, edit, soft delete, restore, search, sort, page and filter.

Three operations here are not edits, and are separate endpoints because of what they do beyond the
row they touch.

**Setting a password ends every session the person holds.** Whoever knew the old password may not be
whoever should keep the session. The tenant's password policy applies, because this is a password
being *set*, and the audit trail records that it happened without recording what it was.

**Disabling an account ends every session too**, for the same reason.

**Editing a role's permissions changes what everyone holding it may do**, on their next request rather
than at their next sign-in. A system role's *key* is fixed — the product refers to the eight seeded
roles by key, so renaming one would break the seed, the MFA policy and every report that groups by it
— but its name and its permissions are ordinary tenant data.

### Two deliberate limits

**Role grants are tenant-wide only.** `user_role` has no `scope_type`/`scope_id`, and that is a
decision rather than an omission: a role granted on one node needs the ACL resolver to enforce the
boundary, and until that exists a scoped grant would be *stored* as scoped and *enforced* as
tenant-wide — worse than not offering it.

**There is no invitation-token subsystem.** A new account is created in `INVITED` status and an
administrator sets its first password. A credential-bearing token belongs with the rest of the
credential lifecycle in the security phase, not bolted onto administration.

## Still to build

Delegation, MFA enrolment, and the events listed above — none of which are published yet.
