# 08 — Permission Model

**Purpose:** who may do what, where — RBAC, inheritance, overrides, and the permission matrix.
**Audience:** everyone. Read before adding an endpoint or a UI affordance.

## 1. The three questions

An authorisation decision answers them in order:

1. **Capability** — does the caller hold the permission at all (role-based)?
2. **Reach** — does it apply *here*, on this scope node (ACL, inherited)?
3. **State** — does the document's current state and confidentiality allow it right now?

All three are evaluated **on the server**. Hiding a button is a courtesy, not a control.

## 2. Permission catalogue

Permissions are `resource:action` keys, defined once in `@edms/domain` and imported by API and web.
**A permission that is not in the catalogue does not exist**; the UI may never invent one.

```ts
export const Permission = {
  DOCUMENT_VIEW: 'document:view',
  DOCUMENT_DOWNLOAD: 'document:download',
  DOCUMENT_PRINT: 'document:print',
  DOCUMENT_CREATE: 'document:create',
  DOCUMENT_EDIT: 'document:edit',
  DOCUMENT_SUBMIT: 'document:submit',
  DOCUMENT_APPROVE: 'document:approve',
  DOCUMENT_REJECT: 'document:reject',
  DOCUMENT_PUBLISH: 'document:publish',
  DOCUMENT_CHECKOUT: 'document:checkout',
  DOCUMENT_CHECKIN: 'document:checkin',
  DOCUMENT_FORCE_CHECKIN: 'document:force-checkin',
  DOCUMENT_MOVE: 'document:move',
  DOCUMENT_ARCHIVE: 'document:archive',
  DOCUMENT_DELETE: 'document:delete',
  DOCUMENT_RESTORE: 'document:restore',
  DOCUMENT_HISTORY_VIEW: 'document:history:view',
  DOCUMENT_PERMISSION_MANAGE: 'document:permission:manage',
  LIBRARY_VIEW: 'library:view',
  LIBRARY_MANAGE: 'library:manage',
  FOLDER_MANAGE: 'folder:manage',
  WORKFLOW_MANAGE: 'workflow:manage',
  DELEGATION_MANAGE: 'delegation:manage',
  NOTIFICATION_MANAGE: 'notification:manage',
  NUMBERING_MANAGE: 'numbering:manage',
  RETENTION_MANAGE: 'retention:manage',
  LEGAL_HOLD_MANAGE: 'legal-hold:manage',
  AUDIT_VIEW: 'audit:view',
  AUDIT_EXPORT: 'audit:export',
  SEARCH_ALL: 'search:all',
  REPORT_VIEW: 'report:view',
  REPORT_MANAGE: 'report:manage',
  USER_MANAGE: 'user:manage',
  ROLE_MANAGE: 'role:manage',
  ORG_MANAGE: 'org:manage',
  SETTINGS_MANAGE: 'settings:manage',
} as const;
```

Adding a permission means: add the key, add it to the matrix below, gate the endpoint, gate the UI
affordance, and seed it into the roles that should hold it — one commit.

## 3. Scope tree and inheritance

Permission is granted on a **scope node** and flows downward:

```text
Tenant → Company → Entity → Department → Library → Folder → (sub-folder…) → Document
```

```mermaid
graph TB
    T[Tenant grant<br/>role assignment] --> C[Company ACL]
    C --> E[Entity ACL]
    E --> D[Department ACL]
    D --> L[Library ACL]
    L --> F[Folder ACL]
    F --> F2[Sub-folder ACL]
    F2 --> DOC[Document ACL]
```

Resolution algorithm — pure, cached, and the only place a decision is made:

```text
1. Collect the caller's subjects: user id, role ids, department ids.
2. Walk the scope chain from the document up to the tenant (one query, using the ltree paths).
3. Collect every ACL entry on that chain matching any subject and the requested permission.
4. If any matching entry has effect DENY  → denied. (Deny wins, at any level.)
5. Else if any matching entry has effect ALLOW → allowed.
6. Else fall back to the role grant at tenant level.
7. Else → denied. (Closed by default.)
8. Apply state and confidentiality rules; they can only subtract.
```

[ADR-0005](./adr/0005-hierarchical-acl-with-deny-precedence.md) records why deny wins and why the
default is closed.

**Step 1 said "and active delegations" until Phase 11, and that phase removed it deliberately.**
The clause had been unbound since Phase 0.5 — `AuthorizationSubject.delegationIds` was passed `[]`
by all three of its call sites — and building delegation is what forced the question of whether it
should ever be filled in. The answer is no, and the reason is
[07 §4](./07-workflow-architecture.md)'s own first sentence: delegation is a **routing overlay,
never a permission grant**.

Making a delegation an ACL subject would make it a grant. An ACL entry could then name a delegation
on a scope node, and the delegate would gain *reach* — the ability to see or act on things the
delegator never could — which is precisely the privilege escalation §8's table forbids. It would
also make the authority question unanswerable in the place §4 requires it: the walk answers "may
this subject reach this node", and "does the delegator still hold `document:approve` right now" is
a different question about a different thing.

So delegation is resolved where it belongs. `DelegationService.authorityFor` takes the permission as
a parameter, reads the delegator's current grants at the instant of the decision, and returns the
delegation that authorises the act — or the rule that refused. `AuthorizationSubject.delegationIds`
remains on the interface and remains empty; removing the field would be a wider change than the
decision warrants, and it documents a subject the resolver deliberately does not have.

**Breaking inheritance:** a folder may set `inherit_acl = false`, which stops the walk at that node
for ACL purposes. Administrative permissions (`*:manage`, `audit:*`) are never blocked this way —
otherwise a user could hide a subtree from the administrators responsible for it.

## 4. Confidentiality and state modifiers

These **subtract only**; they never grant.

| Modifier | Effect |
| --- | --- |
| Confidentiality level | Each level may forbid download, forbid print, force a watermark, or require a stated reason (recorded in audit) even for users holding the permission |
| Document state | Content edit is impossible outside `DRAFT`/`CHANGES_REQUESTED`; delete is impossible while `PUBLISHED`; approve exists only for the assignee of a live task ([06](./06-document-lifecycle.md)) |
| Check-out lock | Edit and check-in belong to the lock holder; anyone else needs `document:force-checkin` |
| Legal hold | Delete and purge are refused regardless of permission |
| Tenant status | A suspended tenant is read-only |

## 5. Standard roles

Seeded per tenant, editable except where marked system.

| Role | Purpose |
| --- | --- |
| `TENANT_ADMIN` (system) | Full administration of the tenant |
| `DOCUMENT_CONTROLLER` | Owns numbering, types, retention, libraries; the compliance operator |
| `LIBRARY_MANAGER` | Manages one or more libraries, their folders and permissions |
| `AUTHOR` | Creates and revises documents in permitted folders |
| `APPROVER` | Decides approval tasks assigned to them |
| `READER` | Reads and, where allowed, downloads |
| `AUDITOR` | Reads everything in scope plus the audit trail; may never mutate |
| `GUEST` | Time-boxed, explicitly granted single-document or single-folder access |

## 6. Permission matrix

`✓` granted by default · `S` scoped — only where explicitly granted on a node · `T` only on a task
assigned to them · `—` never.

| Permission | Tenant admin | Doc controller | Library manager | Author | Approver | Reader | Auditor | Guest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `document:view` | ✓ | ✓ | S | S | S | S | ✓ | S |
| `document:download` | ✓ | ✓ | S | S | S | S | ✓ | S |
| `document:print` | ✓ | ✓ | S | S | S | S | ✓ | — |
| `document:create` | ✓ | ✓ | S | S | — | — | — | — |
| `document:edit` | ✓ | ✓ | S | S (own/draft) | — | — | — | — |
| `document:submit` | ✓ | ✓ | S | S | — | — | — | — |
| `document:approve` | — | — | T | — | T | — | — | — |
| `document:reject` | — | — | T | — | T | — | — | — |
| `document:publish` | ✓ | ✓ | S | — | — | — | — | — |
| `document:checkout` | ✓ | ✓ | S | S | — | — | — | — |
| `document:checkin` | ✓ | ✓ | S | S (own lock) | — | — | — | — |
| `document:force-checkin` | ✓ | ✓ | S | — | — | — | — | — |
| `document:move` | ✓ | ✓ | S | — | — | — | — | — |
| `document:archive` | ✓ | ✓ | S | — | — | — | — | — |
| `document:delete` | ✓ | ✓ | S | S (own draft) | — | — | — | — |
| `document:restore` | ✓ | ✓ | S | — | — | — | — | — |
| `document:history:view` | ✓ | ✓ | S | S | S | S | ✓ | — |
| `document:permission:manage` | ✓ | ✓ | S | — | — | — | — | — |
| `library:view` | ✓ | ✓ | S | S | S | S | ✓ | S |
| `library:manage` | ✓ | ✓ | S | — | — | — | — | — |
| `folder:manage` | ✓ | ✓ | S | — | — | — | — | — |
| `workflow:manage` | ✓ | ✓ | — | — | — | — | — | — |
| `delegation:manage` | ✓ | ✓ | — | own | own | — | — | — |
| `notification:manage` | own | own | own | own | own | own | own | own |
| `numbering:manage` | ✓ | ✓ | — | — | — | — | — | — |
| `retention:manage` | ✓ | ✓ | — | — | — | — | — | — |
| `legal-hold:manage` | ✓ | ✓ | — | — | — | — | — | — |
| `audit:view` | ✓ | ✓ | S | — | — | — | ✓ | — |
| `audit:export` | ✓ | ✓ | — | — | — | — | ✓ | — |
| `search:all` | ✓ | ✓ | — | — | — | — | ✓ | — |
| `report:view` | ✓ | ✓ | S | S | S | — | ✓ | — |
| `report:manage` | ✓ | ✓ | — | — | — | — | — | — |
| `user:manage` | ✓ | — | — | — | — | — | — | — |
| `role:manage` | ✓ | — | — | — | — | — | — | — |
| `org:manage` | ✓ | — | — | — | — | — | — | — |
| `settings:manage` | ✓ | — | — | — | — | — | — | — |

Three deliberate rows:

- **`notification:manage` is `own` for every role, including `GUEST`** — the only row in this matrix
  that is granted to everybody, and the only one where that is not a mistake. It is not reach over
  anything of the tenant's: it is a person's own inbox and their own preferences, and 18 §3 makes
  the in-app inbox authoritative, so everybody who can *receive* a notification must be able to read
  it. It exists at all because 15 §5 asserts at boot that every mutating route declares a
  permission, and no existing one fits: `document:view` was the near miss and is wrong, because
  somebody holding no document permission still receives the security notifications 18 §4 says they
  must, and could then not read them. The `own` scope is enforced by **absence** — no route under
  `/notifications` takes a recipient identifier — which is the same enforcement `delegation:manage`
  uses for its delegator.


- **Tenant admin cannot approve.** Approval authority comes from being assigned a task, never from
  seniority. An administrator who needs to approve is assigned or delegated the task, and the audit
  says so.
- **Auditor can never mutate.** Read plus export, nothing else, at any scope.

## 7. Enforcement

| Point | Mechanism |
| --- | --- |
| Route | `@RequirePermission(Permission.X)` on every mutating endpoint; a route without one fails a boot-time assertion |
| Object | `AclGuard` resolves the scope chain for the target id before the use case runs |
| Query | List endpoints filter by a permission predicate pushed into SQL — never fetch-then-filter, which leaks totals and pagination |
| Search | The index carries the ACL fingerprint; results are filtered before scoring ([12](./12-search-architecture.md)) |
| UI | `usePermission()` reads the server-provided capability set for the current object and hides affordances; it decides nothing |
| Audit | Every denied attempt on an existing object is audited as `ACCESS_DENIED` |

**Cross-scope reads return `404`, not `403`**, so existence is not leaked.

## 8. Caching

Resolved decisions are cached per `(userId, scopeId, permission)` in Redis with a short TTL, and
invalidated by event: an ACL change, role change, delegation change, department membership change,
or document move publishes an invalidation. The cache is an optimisation only — a cold cache
produces the same answer.

## 9. What Phase 8 built

`ACL_RESOLVER` binds its first real implementation — `PrismaAclResolver`, in the Library
module — because the search index must materialise `acl_subjects` from "the same pure resolver
the API uses" (12 §3) and a deny-all placeholder cannot serve an index anybody may see. It
resolves §3's algorithm over what genuinely exists: no ACL entry table yet, so steps 3–5 find
nothing, every decision falls through to step 6's tenant-level role grant, and step 7 keeps it
closed by default. `visibilityFilter` (the query-side call site) and `aclSubjectsFor` (the
projection's) are two methods of one class over one domain vocabulary
(`library/domain/acl-subjects.ts`), so §7's Query and Search rows can no longer diverge. The
entries, the walk, deny precedence, `@ScopedTo` on object routes, capabilities in responses and
§8's cache remain the ACL phase's — they extend this binding rather than replace anything that
now calls it.

## 10. What Phase 9 added

Two rows of §7 stopped being aspirations.

**`ACCESS_DENIED` has a writer.** The Audit row of §7 — "every denied attempt on an existing object
is audited" — had none: `writeStandalone` was written in Phase 1 for exactly this caller and nothing
in `core/authorization/` had ever called it. `AccessDenialRecorder` is that caller, and it is one
recorder with two call sites — `AclGuard` and the audit timeline's own refusal — because a refusal
recorded differently in two places is a compliance report that has to know which path denied it.

The "on an *existing* object" condition is a security condition: a trail that separated "denied"
from "absent" would answer, for whoever later reads it, the existence question the `404` withholds.
It cannot arise today, because `PrismaAclResolver` decides from the caller's role grants without
consulting the object at all (§9) — a refusal is a fact about the caller and carries no information
about whether the identifier names anything. When the walk arrives and decisions become
object-dependent, the condition starts to matter, and it matters in the recorder rather than in each
guard.

**A second call site for the resolver, and why it is not a second predicate.** An audit timeline is
"filtered to what the caller may see" (13 §6), and the audit row model has no scope to push a
`visibilityFilter` against — a row carries `(subject_type, subject_id)`, and a `SEARCH` row carries
the actor's own user id. So the timeline resolves the *subject* once, through `ACL_RESOLVER.resolve`,
before the query runs: one object, one question, one decision covering the whole page. That is the
same port, binding and algorithm §9 recorded, asked at a third call site rather than reimplemented —
which is what this section exists to require.

The audit **search** is not filtered by ACLs at all, and that is deliberate rather than an omission.
It crosses every subject in the tenant, so there is no object to resolve; §6's `audit:view` gates
it, and that grant is the filter. Narrowing an auditor's search by document ACLs would produce an
auditor who cannot audit — the opposite of the row §5 writes for them. The matrix's one `S` on
`audit:view`, the library manager's, is a scoped grant and arrives with the ACL entries; until then
the resolver answers it as the tenant-level grant it currently is.
