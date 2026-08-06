# Penetration testing — preparation

**Purpose:** what a tester is given, what is in scope, and what they may do to a tenant's data.
**Audience:** whoever commissions a test, and the testers.
**Status:** written in Phase 18. No test has been performed; this is the artefact that makes one
possible, and §7 says what it therefore cannot claim.

**"Security testing" and "penetration testing preparation" are not the same item**, and treating
them as one is the mistake this document exists to avoid. The first is assertions in a suite —
`security.integration.spec.ts` and the sixteen suites it deliberately does not restate. The second
is *this*: a documented surface, a scope boundary, a credential story, and an answer to the question
a tester asks first and nobody usually writes down.

## 1. What the system is, in one paragraph

An enterprise document management system. Two HTTP surfaces — a Next.js web client and a NestJS API
— one Redis, one object store, and **one PostgreSQL database per tenant**
([ADR-0015](../architecture/adr/0015-database-per-tenant.md)). The API is stateless. Every request
carries either a person's access token or a machine key, both in `Authorization: Bearer`; the token
carries a signed `tenantId` and a request naming another tenant is refused before it reaches a use
case. Business logic never knows about tenancy: the ambient context decides which database opens,
which storage prefix a key is written under, and which search index answers.

## 2. The attack surface, by what it is rather than by route

| Surface | What it is | The control a tester should attack |
| --- | --- | --- |
| **Unauthenticated** | `/api/health/live`, `/api/health/ready`, `/api/health`, `/api/openapi.json`, sign-in, refresh, the federated callback, and the `LOCAL` driver's transfer endpoints | Enumeration through health detail; the OIDC callback's `state`/`nonce`; the transfer token's signature and its `PUT`/`GET` binding |
| **Person-authenticated** | Everything else, behind four global guards in a fixed order: authenticated → not naming another tenant → holds the permission → may reach *this* object | Guard ordering; `@Public` routes that should not be; a mutating route with no permission (the process refuses to start with one, so look for one that declares the *wrong* one) |
| **Machine-authenticated** | The same routes under an API key, which is a **delegated subject** bound to a person and narrowed by scopes that can only intersect ([ADR-0018](../architecture/adr/0018-machine-identity-as-a-delegated-subject.md)) | Whether a key ever sees more than its subject; whether any scope reaches `document:sign`, `user:manage`, `role:manage` or `settings:manage`; whether revocation is immediate |
| **Object-level** | The ACL walk: capability from roles, reach from entries, both required, deny winning at any level, and a folder that may stop inheriting | Deny precedence; a broken inheritance that stops grants and lets refusals through; `*:manage` and `audit:*` crossing a break |
| **Content** | Upload, antivirus gate, preview rendering, download | The scan gate (`scan_status <> 'CLEAN'` is unattachable and undownloadable, enforced in the use case *and* by a database check); archive bombs; the watermark and print refusal |
| **Outbound** | Webhooks, OIDC discovery, SIEM push — all through one port with an operator-owned allow-list that is **empty by default** | SSRF: a lookalike host, a permitted host resolving to a private address, a redirect, credentials in a URL, DNS rebinding between check and connect |
| **Asynchronous** | The transactional outbox, eleven queue lanes, and their schedules | Whether a job payload can carry a tenant it should not; whether a consumer's context can be made to act as somebody |
| **Evidence** | The hash-chained audit trail, signed daily checkpoints, evidence bundles | Whether any path updates or deletes an audit row (the table refuses both to every role, including the owner); whether a bundle's manifest can be made to overclaim |

## 3. What is out of scope, and why each

- **`@munaxa/*`** — the shared design system, built and published from a different repository. A
  finding there is a finding against another product's supply chain and belongs in its own
  engagement.
- **The hosting provider's control plane** — the object store, the managed database, the container
  platform. Attacking them is attacking a third party under their own rules of engagement.
- **Denial of service and volumetric testing**, unless separately agreed in writing. The product
  has rate limits and per-tenant concurrency caps and both are worth testing *functionally*; a load
  generator pointed at a shared staging environment tests the runner.
- **Social engineering of Munaxa staff**, unless separately agreed.
- **Anything in a production tenant.** See §5.

## 4. What is *in* scope and usually assumed not to be

Stated explicitly because a tester who assumes otherwise will not look:

- **The tenant administrator is in the threat model.** A tenant administrator can mint an API key
  bound to an auditor and can point a webhook at any allow-listed host. The report states that a
  key bound to an administrator *is* that administrator. What is worth testing is whether an
  administrator can reach *another tenant*, or reach the audit trail's integrity — neither of which
  the design permits.
- **A person with a valid session is in the threat model**, for reach. The interesting question is
  never "can they call the route" but "does the route's total obey their reach" — a document the
  caller cannot see must be absent from a list *and from its count*, and from every report and
  dashboard tile built on it.
- **The trail's own honesty.** An evidence bundle states, per digest version, exactly which columns
  that version's hash attests, and it states which CSV profile produced its bytes. A bundle that
  could be made to claim more than the digest provides is a finding.

## 5. Test accounts, test data, and what may be done to a tenant's data

**A tester is given their own tenant, provisioned for the engagement, and never a production one.**
Under ADR-0015 a tenant is a database, so this is a stronger boundary than a filter: the blast
radius of anything a tester does is one database and one storage prefix.

The engagement's environment is a staging deployment with:

- **Two tenants**, not one. Cross-tenant isolation is the property most worth attacking and it
  cannot be attacked from inside a single-tenant installation. The second tenant holds data the
  tester is *not* given credentials for, and a document read across the boundary is the headline
  finding of any engagement against this product.
- **A full role spread in the tester's tenant** — tenant administrator, document controller,
  approver, author, reader, auditor — with credentials for each, so privilege escalation is
  testable in both directions rather than only downward.
- **At least one API key per scope**, and one bound to a subject with narrower reach than the key's
  scopes, which is the case ADR-0018's intersection rule exists for.
- **Anonymised sample content only.** 20 §1: staging holds "anonymised sample, never production
  data". A tester who finds real customer content in a staging tenant should treat that as the
  first finding and stop.

**What a tester may do to that data: anything.** Delete it, corrupt it, exfiltrate it, encrypt it.
It is theirs for the engagement and it is restored by re-provisioning rather than by a backup. What
they may **not** do is touch the second tenant's data other than to demonstrate that they *can* —
one document identifier is proof, and a dump of the tenant is not.

## 6. What to hand a tester on day one

- This document, [`17-security-architecture.md`](../architecture/17-security-architecture.md) and
  [`08-permission-model.md`](../architecture/08-permission-model.md). The permission model is the
  most useful document in the set for an attacker and withholding it would produce a shallower
  test — this is a white-box engagement by design.
- `/api/openapi.json` from the staging deployment: the whole route surface, every method and every
  parameter. It describes routes every guard still refuses; enumerating the API has never been a
  permission this product pretended to enforce.
- The credentials in §5, and the two tenants' hostnames.
- A named contact, an agreed window, and the on-call channel — because the integrity sweep, the
  chain-broken alert and the `ACCESS_DENIED` enumeration alert will all fire, and an operator who
  has not been told will treat a scheduled test as an incident.

## 7. What this preparation does not include

- **No test has been performed.** This document is the artefact, not the result. There is no report
  to read, no finding to have been remediated, and no assertion here has been checked by anyone
  outside the codebase.
- **No staging deployment exists yet.** §5 describes what to provision, not what is provisioned.
- **No scanner output.** Running a scanner and pasting its report is not what this item is, and a
  clean automated scan against an application with a permission model this size would say almost
  nothing. What a scanner *is* good for — dependency advisories — is 17 §6's Dependencies row and
  belongs in the pipeline rather than in an engagement.
- **No bug-bounty policy, and no `security.txt`.** Both are the right things for a deployed
  product, and both are commitments a running service makes rather than a repository.
