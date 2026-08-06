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
| `delegation.requested` | Somebody has asked to delegate; the named approvers must agree. |
| `delegation.approved` | The delegate may act for the delegator within the stated scope and period. |
| `delegation.revoked` | Ends a delegation before its end date. |
| `delegation.expired` | A delegation's period ended. Recorded by the sweep; never what makes it inert. |

## Authentication

Sign-in, refresh and sign-out are implemented; user and role administration and delegation are
too. MFA is not.

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

## Routing lookups — Phase 4

`USER_DIRECTORY` gained four reads, and they are on that port rather than answered by a workflow
repository for one reason: this interface is the whole of what other modules may know about a person,
and "nobody reads Identity's tables" is a rule with no exceptions in it.

| Read | Answers |
| --- | --- |
| `holdersOfRole` | Everybody with a role, narrowed to an entity or a department subtree |
| `membersOfDepartment` | A department's members, or only the people who manage it |
| `managersOf` | The managers of somebody's primary department |
| `activeAmong` | Which of these accounts can actually sign in |

Four of the workflow engine's seven participant resolver kinds are questions about people, and every
one of them is asked *at stage activation* — [07 §2](../../../../../docs/architecture/07-workflow-architecture.md)
resolves participants then precisely so an org change does not break a workflow authored before it.
None of these is cached: a cache would reintroduce exactly the staleness the design removed, and the
failure would show up as an approval routed to somebody who left.

**`user_department.is_manager` is new**, and it is what makes `MANAGER_OF` resolvable at all —
nothing in the model said who managed anything. A flag on the membership rather than a column on the
department, because a department can have two managers and a person can manage one department while
belonging to three. `managersOf` excludes the subject from their own result: "escalate to my manager"
resolving to me is an escalation that goes nowhere and hides that there is nobody above me.

`holdersOfRole` scoped to a node the document does not have narrows to **nobody**, never to the
tenant. Widening is the dangerous default — it would route an approval meant for one department's
quality manager to every quality manager in the organisation, silently.

## Two more directory reads — Phase 12

`USER_DIRECTORY` gained two, on the same port and for the same reason the Phase 4 four are there.

| Read | Answers |
| --- | --- |
| `holdersOfPermission` | Everybody who holds a permission through any of their roles |
| `authorizationSubjectFor` | One person's roles and departments, for a decision taken *about* them |

**`holdersOfPermission` exists because two of 18 §4's rows are addressed to a capability rather
than to a person or a role**: "administrators" for a security event, and the document controller
for a retention one. `holdersOfRole` cannot answer either without the caller naming role keys in
code — the coupling 07 §8 forbids the workflow engine, and no better here, because a tenant that
renamed its controller role would silently stop being told its audit chain had broken. A permission
is a catalogue entry a tenant cannot rename.

**`authorizationSubjectFor` exists because Notification asks the ACL resolver about somebody other
than the caller.** `AuthorizationSubject` has always been a parameter rather than the request
context, so the resolver needed no change; what was missing was a way to build the subject for a
recipient. It is here rather than on `USER_SERVICE` — which declares a `subjectsFor` and has been
bound to nothing since Phase 0.5 — because binding that symbol would mean building a user aggregate
repository to answer a two-join read, and this port already answers "who is this person,
organisationally".

It returns **no delegations**, deliberately. 08 §3 lost its "active delegations" clause in Phase 11
rather than the resolver gaining a subject, and a notification recipient's visibility must not
depend on cover they were given — which would make a delegation the permission grant 07 §4 says it
must never be.

## Delegation (Phase 11)

`DELEGATION_REPOSITORY` and `DELEGATION_SERVICE`, declared and unbound since Phase 0.5, are bound.
The whole of it is `07-workflow-architecture.md` §4, and one sentence from that section explains
every shape here: **delegation is a routing overlay, never a permission grant.** The task stays the
delegator's, the delegate acts on it, and nothing in this module grants reach.

| Route | Notes |
| --- | --- |
| `GET /api/v1/delegations` | Given, received, or awaiting my approval. The third is not a filter over the other two |
| `GET /api/v1/delegations/{id}/uses` | Everything decided under it — §4's visibility rule, projected from `approval_task` |
| `POST /api/v1/delegations` | A request. **No `delegatorId` on the wire**: the subject is the caller, enforced by absence |
| `POST /api/v1/delegations/emergency` | Its own route, not a flag, so the path that bypasses the approval is a different URL |
| `POST /api/v1/delegations/{id}/approve` · `/decline` | A manager of the delegator, or `user:manage`; never a party to it |
| `POST /api/v1/delegations/{id}/revoke` | Immediate. Nothing is reassigned, because nothing ever moved |

Four decisions worth knowing before changing anything here.

**`authorityFor` is the only method other modules call, and the permission is a parameter.** There
is deliberately no `isDelegate(a, b)`: the cheap question is the one that lets a delegate exceed
what the delegator holds. The delegator's grants are read *at the instant of the decision* and
nothing about them is stored on the delegation, which is §4's "checked at decision time, not at
creation" made unrepresentable to get wrong.

**Approval is `user:manage`, not `delegation:manage`.** The latter is `own`-scoped in the Phase 1
seed — every author holds it — and the request context carries a permission key with no scope
beside it. Reading it as "may administer delegations generally" would let any author approve any
other author's request, which is the control not existing.

**Expiry is a predicate; the lane only records it.** `listActiveFor` filters on the period in SQL,
so a delegation past its end date authorises nothing whether or not `identity.expire-delegations`
has run. The schedule exists because `DELEGATION_EXPIRED` is in 13 §2 and an action has to be
written by something.

**Nothing is ever deleted.** Revocation and expiry are status changes, and
`approval_task.delegation_id` restricts — so the delegation a decision was taken under is still
identifiable years later, which is what an investigation into a revoked delegation needs.

## Phase 14 — the second factor

`user.mfa_enrolled` shipped in Phase 1, read by the auth response and the admin view and **written by
nothing** — a boolean that had answered "no" for thirteen phases whatever the truth was. It is now
derived, written in the same transaction that confirms an enrolment, so nothing that reads it had to
learn a new column.

`domain/totp.ts` is RFC 6238, written rather than installed, and the file says why: the lockfile
cannot gain a dependency here, and TOTP is the one factor for which that is acceptable — HMAC-SHA1
over a counter, with an RFC that specifies every line, asserted against the RFC's own published
vectors. **WebAuthn is not**, and 17 §2's other half is deferred rather than hand-rolled.

Five properties cost something on purpose, and `application/mfa.service.ts` states each: enrolment is
two steps and the first grants nothing; a consumed time step cannot be consumed again; consecutive
failures stop the factor; recovery codes are single-use and are the only way past a lost
authenticator; and enrolling or removing ends every session.

The secret is sealed at rest with AES-256-GCM, which is defence against a database disclosure and
**not** against a compromised application — see `infrastructure/prisma-mfa.repository.ts` for what
that does and does not buy.

**Phase 18 gave the seal its own key and a rotation.** Phase 14 derived one from
`JWT_ACCESS_SECRET`, carefully — a domain-separated SHA-256, so one string was not doing two
cryptographic jobs — and that still left the two on **one rotation clock**: rotating the token
secret is routine with a fifteen-minute blast radius, and it also, silently, made every enrolled
authenticator unreadable. `MFA_TOTP_SEALING_KEY` is its own secret, required in production, and
every sealed value now names the key version that sealed it.

The rotation completes **lazily, one person at a time**: a stale row is re-sealed the next time its
owner successfully proves a code, inside the transaction that records the success. That is the only
moment the plaintext and a proof of it exist together — a deploy-time pass would need every tenant's
authenticator secrets unsealed in one process, which is the exposure sealing exists to prevent. The
consequences are stated rather than hidden: a rotation never completes for an account nobody signs
into, so the old key is discarded when an operator is willing to force re-enrolment for whoever is
left; and removing a key that rows are still sealed under produces an error naming the variable
rather than a failed sign-in that looks like a wrong code.
[ADR-0020](../../../../../docs/architecture/adr/0020-key-management-and-rotation.md) argues why the
deployment's secret store *is* the key management service Phase 14's report asked for, and why a
port with four adapters would have added an abstraction in front of a boundary the platform already
owns.

The challenge is on `/auth/login` rather than at an endpoint of its own, because a two-call flow
would have to carry a token between the calls proving the password was right — a credential with a
lifetime and a revocation story, minted for one purpose, of exactly the kind that gets reused.

Two of 13 §2's three rows are written here for the first time: `MFA_ENROLLED` (both directions, the
direction in the payload) and `MFA_FAILED` (separate from `LOGIN_FAILED`, because "knows the
password and not the factor" is the only signal that says a password has leaked). The third,
`SESSION_REVOKED`, was **already** written by Phase 1's replay detection; this adds a third call
site.

## Phase 17 — the machine caller, and federation

Two capabilities that both answer this module's own question — *who is this, and what may they do
anywhere* — and neither is a second sign-in.

### An API key is a delegated subject

[ADR-0018](../../../../../docs/architecture/adr/0018-machine-identity-as-a-delegated-subject.md), and
it is the phase's most dangerous decision because of where `userId` sits in this codebase. It is the
subject of every reach decision in the product, and
`PrismaDocumentRepository.visibilityCondition` answers a subject-less caller with an **empty
predicate** — which is every document in the tenant. Had a key authenticated with `userId: null`,
every list route would have become a full tenant dump for anybody holding one, with nothing logging
an error and every `403` passing.

So `api_client.subject_user_id` is `NOT NULL`: a key is bound to a person and acts as them, and its
effective permissions are that person's grants ∩ the key's scopes. Both are read at **authentication
time**, on every request, which is Phase 11's rule for delegation authority applied to a credential
— removing a role removes it from every key bound to them on the next call, and disabling the
account stops every key they back.

A key exchanges for **no session and no token**. It is resolved on every request, which is what
makes revocation immediate. `mdk.<prefix>.<secret>`: the prefix is the indexed selector so the
lookup is one read rather than a scan verifying every digest; the secret is scrypt-hashed with the
same parameters and the same verifier a password uses.

There is no `update` — a key's subject and scopes are what its holder was told they had, and
changing either silently changes what a running integration can do.

### Federation is one adapter, and three of the brief's items are it

SSO, Microsoft Entra ID and Google Workspace differ in a discovery URL and in which claim carries
the groups; both are columns. **LDAP is a wire protocol rather than an HTTP redirect flow** and
needs a dependency the lockfile cannot gain; **SAML** needs XML canonicalisation and DSig and there
is no XML parser here at any level; **Microsoft 365** is not authentication at all.

`domain/oidc.ts` verifies ID tokens over `node:crypto` and writes **no cryptography** — Node imports
a JWK and verifies RS256 and ES256 natively. What it writes is four checks, each a string or number
comparison a reader can check by eye: an `alg` allow-list matched to the key type (closing `none`
and the RS256→HS256 confusion attack), an exact issuer, an audience including `azp`, and a
constant-time nonce. That is why it is not the trade refused for CBOR and XML-DSig, where the
*parsing* is the hard part.

A provider asserts identity and groups, never authority: `roleMappings` runs provider-value →
role-key, and a mapped key matching no role in the tenant is dropped rather than created. Returning
users' roles are deliberately **not** re-synchronised, or the provider would become the authority on
Munaxa roles and an administrator's local grant would vanish at the next sign-in.

`user.identity_source` closes the phase's first finding: `password_hash` has been nullable since
Phase 1 and nothing recorded *where an identity came from*, so "no password because they federate"
and "no password because the invitation is open" were indistinguishable.

## Still to build

**WebAuthn**, and the *policy* half of 17 §2 — "required by policy for `TENANT_ADMIN`,
`DOCUMENT_CONTROLLER` and `AUDITOR`". Both are unchanged after Phase 17 and both have named
blockers.

WebAuthn needs CBOR decoding, COSE key parsing and attestation formats; `cbor`, `fido2-lib` and
`@simplewebauthn/server` are absent from the store entirely, and this is exactly the
hand-written-parser trade `domain/totp.ts` explains why TOTP is *not*.

The role policy is not a dependency problem. `isRequired` answers only whether this person has
enrolled; refusing a sign-in from somebody who holds one of those roles and has not is a lock-out of
exactly the accounts that administer the tenant — and the only way back in is
[ADR-0013](../../../../../docs/architecture/adr/0013-operator-console-as-separate-surface.md)'s
operator console, which no phase has built. Phase 12's chain-broken alert reaches tenant
administrators as a stand-in for an operator *channel*, and a stand-in is not a recovery path for
people who cannot sign in. Phase 17 declines it for that reason rather than deferring it again to a
phase that will meet the same wall.
