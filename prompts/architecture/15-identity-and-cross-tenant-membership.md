# ADR 15 — Identity & Cross-Tenant Membership

**Status:** Accepted (deferred implementation)
**Date:** 2026-06-10
**Decision owners:** Platform / Auth
**Related:** `03-multi-tenant-architecture.md`, `05-rbac-matrix.md`, `09-security-architecture.md`

> This is a decision record. **No code is changed by this document.** It captures the chosen
> direction for letting one human belong to more than one school, and the phased plan to get there.

## Context

Munaxa is multi-tenant: every `User` row carries a `tenantId` and is physically isolated by
PostgreSQL RLS. Authentication today resolves a single `User` within a single tenant:

- `User` uniqueness is per tenant: `@@unique([tenantId, email])`, `@@unique([tenantId, username])`,
  `@@unique([tenantId, nationalId])`.
- `User.firebaseUid` is **globally `@unique`**, so one Firebase identity maps to exactly one
  tenant user.
- Login (`AuthService.login` / `resolveUserByIdentifier`) finds one user and mints a
  tenant-scoped access token (`tid` claim).

This works for staff, who belong to one school. It does **not** model a real and common case:

- **A parent with children in two different schools.** Each school is a separate tenant, so the
  parent needs two separate accounts — two logins, two passwords, no unified view of both children.
- **A student transferring schools.** History should follow the human, not the tenant row.
- **A teacher working at two campuses run as separate tenants.**

The current model forces account duplication and cannot present a "switch school" experience.

## Decision

Adopt an **Identity / Membership split** (the workspace-switcher pattern used by Slack, Atlassian,
and Google Workspace), but **defer implementation** until the parent/student experience (mobile
app) is built, since that is the first surface that needs it.

### Target model

- **`Account`** — global, one per human. Holds the authentication credentials and identity:
  email, username, `firebaseUid`, password hash, MFA, status. Not tenant-scoped.
- **`Membership`** — the per-tenant record (today's `User`, renamed conceptually). Links an
  `Account` to a `tenant` plus its `UserRole` assignments and per-tenant profile (student/parent/
  teacher/employee). Tenant-scoped and RLS-isolated exactly as `User` is today.

```
Account (global)  1 ──── n  Membership (per tenant)  n ──── n  Role
   ▲ credentials, firebaseUid                │
   └ authenticates once                      └ RLS-scoped, holds roles + profile
```

### Authentication flow

1. Login authenticates the **Account** (email/username/National ID + password, or Firebase).
2. The server returns the Account's **list of memberships** (schools + roles).
3. The client picks a school — or auto-selects when there is exactly one — and the server mints a
   **tenant-scoped** access token for that membership (unchanged `tid`/`perms`/`roles` claims).
4. A **"switch school"** control swaps context by requesting a token for another membership. No
   re-entry of credentials.

RLS, tenant isolation, and the existing token shape are **unchanged** — only *which* membership the
token represents becomes a post-login choice.

## Alternatives considered

| Option | Summary | Verdict |
| --- | --- | --- |
| **A. Separate accounts per school** (status quo) | Parent maintains one login per school. | Acceptable short-term; poor UX, no unified view. **Current state.** |
| **B. Identity / Membership split** | Global `Account` + per-tenant `Membership`; pick/switch school after login. | **Chosen.** Correct long-term; also future-proofs transfers, alumni, multi-campus staff. |
| **C. Firebase-anchored linking** | Drop `@unique` on `firebaseUid`; one Firebase identity → many `User` rows; school picker after Firebase login. | Lighter middle ground, but leaves password-login identities duplicated. Viable interim if a parent app ships before B. |

## Consequences

### Positive
- One human, one login, many schools — with an explicit, auditable school switch.
- Student transfers and alumni access become natural (history attaches to the Account).
- No change to the tenant-isolation/RLS model or the access-token contract.

### Costs / risks
- **Schema migration:** split existing `User` into `Account` + `Membership`; backfill one Account
  per distinct human (de-duplicating by verified email/National ID is non-trivial and must be
  conservative — never merge two people).
- **Auth surface changes:** login returns a membership list; new "select/switch school" endpoint;
  refresh-token family semantics per membership.
- **`firebaseUid` constraint** moves from `User` to `Account`.
- **Cross-tenant lookups** during login must run on the platform plane (already the case via
  `withPlatform`), with care never to leak one tenant's data into another's context.
- **Audit:** the actor is now an Account acting *as* a Membership; audit entries must record both.

## Phased plan

1. **Phase A (now):** keep status quo (Option A). Not blocking — the parent portal does not yet
   exist. The email-or-username login already added (`identifier` resolution, per-tenant `username`)
   is forward-compatible: those handles live on the Account in the target model.
2. **Phase B (with the parent/student mobile app):** introduce `Account` + `Membership`, migrate
   `User`, move `firebaseUid`, add the membership-list login response and the switch-school
   endpoint, and build the school switcher in the app. Revisit Option C only if a parent app must
   ship before Phase B can land.

## Non-goals

- Merging distinct human identities automatically. Account de-duplication, if ever done, is a
  deliberate, verified, reversible admin action — out of scope here.
- Changing tenant data isolation, RLS, or the access-token claim shape.
