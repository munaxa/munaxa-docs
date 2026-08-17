# Documents Workspace — Read Dependency

**Purpose:** record why `/documents` asked for six administrative datasets it could not always
read, what changed, and the one authorization problem this slice deliberately did **not** solve.
**Scope:** the Documents page's data dependency. No permission, role seed, guard, ACL or RLS
change.
**Status:** point-in-time report. Not edited afterwards.
**Method:** measured against the running stack in this container — the shipped API artefact
(`apps/api/dist/main.js`) against real PostgreSQL 16 and Redis, `next start` over the production
web build, and Chromium signing in through the real login form. Request sets are read from the
API's own log, not inferred from what rendered.

## The defect

`DocumentsPage` fetched nine things. Seven of them shared one `Promise.all`:

```ts
const [libraries, types, categories, levels, users, departments, fields] = await Promise.all([…]);
```

Six of those seven are administrative resources — `/admin/document-types`, `/admin/categories`,
`/admin/confidentiality-levels` and `/admin/fields` behind `settings:manage`, `/admin/users` behind
`user:manage`, `/admin/departments` behind `org:manage` — and they exist for exactly two dialogues,
`UploadDialog` and `BulkMetadataDialog`. Nothing else on the screen reads them: not the tree, not
the breadcrumb, not the header, not the counts, not the list, not the toolbar. `fields` does not
even reach the browser; it assembles `documentTypes[].fields` on the server.

A caller who cannot open either dialogue holds none of those three grants, so all six answered 403.
`adminList` throws on a 403, one rejection settles the whole `Promise.all`, and a server component
that cannot load its data renders the route's error boundary. The workspace was therefore not
merely missing a dropdown — it was unopenable.

This is separate from, and was hidden by, the folder-read defect fixed in `588d851`. Restoring
folder reads to `library:view` was necessary and not sufficient: with folders fixed, the page still
died on the next six requests.

## Measured, before

Three people, each holding exactly one seeded role's catalogue from `DEFAULT_ROLE_PERMISSIONS`,
signing in through the real login form and opening `/documents`:

| Role | Grants | `/documents` | The six |
| --- | --- | --- | --- |
| Auditor | 9 | **error boundary** | all six requested → all six `FORBIDDEN` |
| Document controller | 30 | **error boundary** | all six requested → all six `FORBIDDEN` |
| Tenant administrator | 36 | renders | all six requested → all six `200` |

One of the three seeded roles that can reach this route could open it.

## The change

The dependency, not the authorization. Nothing is granted, widened or softened.

```ts
const canCreate = access.permissions.includes(Permission.DOCUMENT_CREATE);
const canBulk = { edit: …, restore: …, download: … };
const needsDialogData = canCreate || canBulk.edit;
```

`canCreate` and `canBulk` already existed on this page to gate the toolbar and the bulk actions;
they are hoisted and resolved once rather than recomputed, so there is no second permission model
here. `create` opens `UploadDialog`; `edit` opens `BulkMetadataDialog`, which takes the categories.
`download` and `restore` open neither, so neither drags the six back in.

`/admin/libraries` moves out of the group and keeps failing fast on purpose: without the libraries
there is no workspace to draw, and the error boundary is the honest answer rather than a page
pretending the tenant has none.

**Refusals are not hidden.** A caller who *can* open a dialogue still requests the six and still
throws on a 403. The distinction this slice draws is between "cannot use the feature, so do not
ask" and "can use the feature and was refused" — the second is a real authorization problem, and
swallowing it into an empty dropdown would be the page lying about what the tenant has configured.

## Measured, after

| Role | Grants | `/documents` | The six |
| --- | --- | --- | --- |
| Auditor | 9 | **renders** — `<h1>Root</h1>`, Libraries/Folders/Views, 3 rows, no create control | **none requested** |
| Document controller | 30 | error boundary | all six requested → all six `FORBIDDEN` |
| Tenant administrator | 36 | renders — create control present | all six requested → all six `200` |

The auditor's complete observed request set while rendering `/documents`:

```text
200        GET /api/v1/documents
200        GET /api/v1/dashboard
200        GET /api/v1/auth/me
FORBIDDEN  GET /api/v1/notifications/unread-count
200        GET /api/v1/admin/libraries
200        GET /api/v1/admin/folders
```

Read from the API's own log rather than from the rendered page, and from **both** of its request
records: `RbacGuard` runs before the observability interceptor, so a refused request never reaches
`Request completed`. Reading only that would have reported every 403 in the product as a request
nobody made — which is precisely the inference this measurement exists to avoid.

The caller's access is strictly smaller than before, never larger.

## Follow-up: the document controller · open

**Not solved here, and not concealed.** The document controller holds `document:create` and
`document:edit`, so it can open both dialogues, so it legitimately needs their configuration — and
it is refused all six. `/documents` therefore remains unopenable for it, now for an honest reason
rather than an incidental one.

The shape of the answer is a separate decision this slice has no mandate to make. `/admin/users` is
the highest-risk of the six: the upload dialogue needs an owner picker, not a user directory, and
granting `user:view` to make a dropdown work would expose considerably more than the screen uses.
The remaining five are configuration catalogues whose read audience is plausibly wider than
`settings:manage` — but "plausibly" is the reason this is a separate investigation and not a line
in this commit.

## Observation: `notifications/unread-count` · not investigated

The auditor is refused `/api/v1/notifications/unread-count` on every page, and the layout tolerates
it — nothing above is affected by it. `notification:manage` is granted to six of the eight seeded
roles; the two without it are the auditor and the document controller, which reads as an omission
rather than a decision given the permission's own justification (*"everybody who can receive a
notification must be able to read it, and its scope is their own inbox"*). Outside this slice, and
recorded only so the 403 in the request set above is not mistaken for a new one.
