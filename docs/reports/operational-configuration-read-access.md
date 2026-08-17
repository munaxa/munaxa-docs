# Operational Configuration Read Access

**Purpose:** record why a document controller could not open the documents workspace, what two new
read capabilities do and do not grant, and what was deliberately left out of each response.
**Scope:** read access to the tenant's document vocabulary and to its people and organisational
units. No mutation, no existing endpoint, no ACL, no RLS.
**Status:** point-in-time report. Not edited afterwards.
**Method:** measured against the running stack in this container — the shipped API artefact against
real PostgreSQL 16 and Redis, `next start` over the production web build, Chromium signing in
through the real login form. Request sets are read from the API's own log, both its
`Request completed` and its `Request rejected` records, because `RbacGuard` runs before the
observability interceptor and a refusal never reaches the first.

## The defect

`08-permission-model.md` §6 marks `settings:manage`, `user:manage` and `org:manage` `—` for the
document controller column, which is right: that role does not administer the tenant. But those
three keys also gated every *read* of the vocabulary the role files documents against, and the
consequence was not a missing dropdown.

A document controller holds `document:create` and `document:edit`. Opening `/documents` meant
fetching document types, categories, confidentiality levels, metadata fields, users and
departments; each answered 403; `adminList` throws on a 403; a server component that cannot load
its data renders the route's error boundary. Measured before this change:

| Page | Auditor | Document controller | Tenant administrator |
| --- | --- | --- | --- |
| `/documents` | renders | **error boundary** | renders |
| `/documents/:id` ▸ Properties | n/a | **would refuse** | opens |

The previous slice made the dependency conditional, which fixed the auditor — a role that opens
neither dialogue stopped asking for what fills them. It could not fix the controller, because the
controller genuinely needs the data. That was recorded as a follow-up and is what this phase
answers.

## What was added

Two read-only keys, gating five new routes. Nothing existing moved.

| Key | Gates | Seeded to |
| --- | --- | --- |
| `configuration:view` | `GET /v1/configuration/{document-types,categories,confidentiality-levels}` | tenant admin, document controller |
| `directory:view` | `GET /v1/directory/{people,departments}` | tenant admin, document controller |

The rows come from the same application services the administrative routes use —
`ConfigurationService`, `UserAdminService`, `ScopeAdminService` — with the same tenant scoping and
the same soft-delete rules. Only the projection differs.

## Why new routes rather than a softer guard

Phase 6.3 moved the library read to `library:view`, and `588d851` moved the folder read to the
same key, because in both cases the administrative response was also the right response for a
reader. Here it is not. Each administrative response carries material a picker has no use for and
a filing clerk has no business holding:

| Resource | Carried, and excluded from the read model |
| --- | --- |
| Document type | numbering rule, workflow definition, retention policy, revision-label style, description, administered stamps |
| Confidentiality level | `allowDownload`, `allowPrint`, `watermark`, `requireReason`, description, `documentTypeCount` |
| Metadata field | `validation` (tenant-authored regular expressions), `isSearchable`, `documentTypeCount`, and every field attached to no type |
| Category | description, `childCount`, administered stamps |
| User | email, status, **MFA enrolment**, **last sign-in**, password state, **roles**, department memberships |
| Department | **`memberCount`**, entity and branch ancestry |

`operations/read-models.spec.ts` asserts each of those absences **by name** rather than asserting
the shape positively — a positive assertion passes just as happily with an extra property on it.
Thirty-one tests, and every exclusion above is one of them.

Two further reductions worth stating:

- **The operational list query has no `deleted` parameter.** The administration lists offer
  `deleted=live|deleted|all` because an administrator has a recycle bin; a picker does not, and a
  caller who may only consume the vocabulary should not be able to enumerate the parts of it that
  were withdrawn. Expressed as an absent parameter rather than as a check.
- **People are active accounts only, and not as a filter the caller may turn off.** A picker
  offering a disabled account offers an assignment that resolves to nobody.

## `/admin/fields` needed no permission at all

It was never rendered. It existed so the server could join `options` and `description` onto
`documentTypes[].fields`; everything else in that join already travelled on the type. Both columns
now travel on the type too, so the tenant's whole metadata catalogue stopped being a dependency of
anything in Documents — and with it the tenant-authored validation patterns and every field
attached to no type.

That is a reduction rather than a re-gating: no key reaches `/admin/fields`, and nothing asks for
it. The client never rendered `validation`, and it is still not sent — the API enforces it, which
is where a rule that must not be negotiable belongs.

## The dependency narrowed further

The read models made the data reachable; the page still asks for as little of it as the workflow
needs.

| Caller | Requests |
| --- | --- |
| No create, no edit (auditor) | `/admin/libraries`, `/admin/folders`, `/documents` — nothing else |
| Bulk-edit only | the above, plus `/configuration/categories` |
| Create | the above, plus `/configuration/document-types?isActive=true` and `/configuration/confidentiality-levels` |
| Create, and a type defines a `USER` field | plus `/directory/people` |
| Create, and a type defines a `DEPARTMENT` field | plus `/directory/departments` |

Two of those are new judgements. `BulkMetadataDialog` renders exactly one control and it is the
category picker, so a bulk-edit-only caller was previously being sent a tenant's whole
classification vocabulary to fill in a form with no field for it. And the directory is read on the
strength of the *configuration*, not the capability: the capability says a dialogue can open, and
the type's fields say whether that dialogue has a control needing a list of people. A tenant whose
document types define no such field never touches `/directory` at all.

Refusals are still refusals. A caller who *can* use a feature and is refused its data still throws;
the distinction drawn throughout is between "cannot use the feature, so do not ask" and "can use
the feature and was refused", and swallowing the second into an empty dropdown would be the page
lying about what the tenant has configured.

## Inactive document types

Verified from the consumers rather than assumed. `/documents` filters to active types, because
that is what a *new* document may be filed as. The properties form resolves a document's **own**
type by id — and a type that has been retired stays attached to the documents already filed under
it. Serving only active types would have rendered an empty metadata section for every one of those
documents: a silent trap, not a tightening. So `isActive` is a query filter and the workspace
passes `isActive=true`; the properties form does not.

## Existing tenants

The seed reaches new tenants. `20260817120000_operational_read_permissions` reaches the ones that
exist, in one statement, and its rules are chosen so that only one of them changes what anybody can
see:

1. any role holding `settings:manage` gains `configuration:view`
2. any role holding `user:manage` or `org:manage` gains `directory:view`
3. the seeded `DOCUMENT_CONTROLLER` (`is_system = true`, not deleted) gains both

Rules 1 and 2 grant a read key only to roles that already hold the *management* key over the same
data — they could read all of it, and more of it, before the migration ran, so applying them to
tenant-authored roles changes no caller's reach. (They are still necessary: `RbacGuard` requires
*all* declared permissions rather than any, so holding the management key does not by itself reach
a route declaring the read key.)

Rule 3 is the one real change, and it is bounded: read-only, narrow, and confined to the role the
product created and refers to by key. A tenant that built its own controller-shaped role is left
alone, because that role's permission set is a decision they made. **The auditor is named nowhere**
— it holds no management key, and rule 3 names one role key.

Nothing is removed. The whole thing is one statement so the permission-version bump can see what
*this run* granted: a separate `UPDATE` could not distinguish "granted now" from "granted
previously" and would bump every counter on every re-run, invalidating every live session in the
estate for nothing. A re-run inserts no rows and moves no counter. Thirteen integration tests
against a real database assert exactly that, including the two roles the migration must leave
untouched.

## Permission version

Not documented away as "takes effect on next sign-in". The migration takes the same step the
product takes: `RoleAdminService.update` calls `bumpPermissionVersion(userIdsWithRole(id))` inside
the transaction that replaces a role's permissions, *"so there is no window in which the role says
one thing and the tokens still in flight say another"*, and the migration increments
`user.permission_version` for the holders of every role it changed.

What that does, exactly: the permission *set* an outstanding access token carries was baked in when
it was minted, and that is the set `RbacGuard` reads. `AuthenticationService.refresh` re-reads
`credential.permissions` from the database, so the new keys reach a live session at its next
refresh — bounded by `JWT_ACCESS_TTL_SECONDS`, default 900. That is precisely the behaviour of a
role edit made through the API, and there is no stronger revocation path in this repository to
reach for. Only holders of a role that actually changed are bumped.

## Boundaries verified

The document controller can now open the workspace, create, edit and bulk-edit. It still cannot:
create, rename, deactivate or delete a document type, category, confidentiality level or metadata
field; read `/admin/document-types`, `/admin/categories`, `/admin/confidentiality-levels`,
`/admin/fields`, `/admin/users`, `/admin/departments` or `/admin/settings`; or manage users, roles
or the organisation. Asserted three ways — declaration tests over the decorator metadata, the DTO
absence tests, and the running stack.

The auditor's behaviour is unchanged in every respect, including its request set, and it holds
neither new key.

## Follow-ups, recorded and not solved here

- **`/search`** is unopenable for the auditor *and* the document controller: it fetches document
  types, categories, departments and `/admin/entities` in one `Promise.all`. Three of those four
  now have an operational read model; entities do not.
- **`/documents/:id/permissions`** fails for the document controller, which holds
  `document:permission:manage`: it needs `/admin/roles` (`role:manage`) to offer role subjects.
  Who holds which authority is not a picker, and widening `directory:view` to cover it would be
  the wrong call made for convenience.
- **`/delegations`** fails for the document controller, which holds `delegation:manage`: it reads
  `/admin/users`. `/directory/people` is the endpoint it wants.
- **`notification:manage`** is held by six of the eight seeded roles; the two without it are the
  auditor and the document controller, which reads as an omission rather than a decision.
