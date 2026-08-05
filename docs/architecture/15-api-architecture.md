# 15 — API Architecture

**Purpose:** the REST contract — resources, versioning, errors, pagination, filtering, auth.
**Audience:** API authors and every consumer.

## 1. Conventions

- **REST/JSON over HTTPS**, NestJS controllers, resource-oriented.
- **Versioned by URI prefix:** `/api/v1/…`. A breaking change means `/api/v2`, never a silent
  change to `v1`.
- **Plural nouns**, nested at most one level; deeper relationships are query filters.
- **Tenant is implicit**, taken from the token. It is never a path or body parameter.
- **Actions that are not CRUD are sub-resources**, not verbs in a query string:
  `POST /documents/{id}/submit`, not `POST /documents/{id}?action=submit`.

```text
GET    /api/v1/libraries
GET    /api/v1/libraries/{id}/folders
GET    /api/v1/documents?folderId=…&status=PUBLISHED&page=1&pageSize=25
POST   /api/v1/documents
GET    /api/v1/documents/{id}
PATCH  /api/v1/documents/{id}
DELETE /api/v1/documents/{id}                       # soft delete
POST   /api/v1/documents/{id}/restore
GET    /api/v1/documents/{id}/transitions           # what this caller may do now
POST   /api/v1/documents/{id}/submit
POST   /api/v1/documents/{id}/checkout
POST   /api/v1/documents/{id}/checkin
POST   /api/v1/documents/{id}/archive
GET    /api/v1/documents/{id}/revisions
GET    /api/v1/documents/{id}/revisions/{rev}/content     # → signed URL
GET    /api/v1/documents/{id}/revisions/{rev}/preview
GET    /api/v1/documents/{id}/revisions/compare?from=1&to=2
GET    /api/v1/documents/{id}/audit
GET    /api/v1/documents/{id}/permissions
PUT    /api/v1/documents/{id}/permissions
POST   /api/v1/uploads
POST   /api/v1/uploads/{id}/complete
GET    /api/v1/tasks?state=PENDING                  # my approval inbox
POST   /api/v1/tasks/{id}/decide
GET    /api/v1/search?q=…&type=…&facets=…
GET    /api/v1/admin/document-types
GET    /api/v1/admin/numbering-rules
GET    /api/v1/admin/workflows
GET    /api/v1/reports                              # the reports this caller may run
GET    /api/v1/reports/{key}?from=…&status=…        # one page; parameters are the report's own
POST   /api/v1/reports/{key}/exports                # 202; queued, never streamed
GET    /api/v1/reports/exports
GET    /api/v1/reports/exports/{id}
GET    /api/v1/reports/exports/{id}/download        # → signed URL
GET    /api/v1/reports/definitions                  # the caller's own saved reports
POST   /api/v1/reports/definitions
DELETE /api/v1/reports/definitions/{id}
POST   /api/v1/documents/bulk/upload                # N uploaded files become N documents
POST   /api/v1/documents/bulk/metadata              # one change, many documents
POST   /api/v1/documents/bulk/restore
POST   /api/v1/documents/bulk/exports               # a manifest; links are a second call
GET    /api/v1/documents/bulk                       # the caller's own operations
GET    /api/v1/documents/bulk/{id}
GET    /api/v1/documents/bulk/{id}/links            # → signed URLs, minted per request
POST   /api/v1/approval-tasks/bulk/decisions        # approval only; a rejection says why, singly
GET    /api/v1/document-templates
POST   /api/v1/document-templates
GET    /api/v1/document-templates/{id}
PATCH  /api/v1/document-templates/{id}
DELETE /api/v1/document-templates/{id}
POST   /api/v1/document-templates/{id}/restore
POST   /api/v1/document-templates/{id}/documents    # a new document, from this template
GET    /api/v1/documents/{id}/signatures
POST   /api/v1/documents/{id}/signatures
GET    /api/v1/documents/{id}/signatures/{sid}/verification
POST   /api/v1/documents/{id}/signatures/{sid}/withdrawal
GET    /api/v1/auth/federation?email=…                 # public: password box, or a redirect
POST   /api/v1/auth/federation/callback                # public: the provider's code, for a session
GET    /api/v1/admin/api-clients
POST   /api/v1/admin/api-clients                       # 201 with the secret, once and only here
GET    /api/v1/admin/api-clients/{id}
DELETE /api/v1/admin/api-clients/{id}                  # revokes; answers the row, never 204
GET    /api/v1/admin/webhooks
POST   /api/v1/admin/webhooks                          # 201 with the signing secret, once
GET    /api/v1/admin/webhooks/{id}
PATCH  /api/v1/admin/webhooks/{id}
DELETE /api/v1/admin/webhooks/{id}
GET    /api/v1/admin/webhooks/{id}/deliveries          # what was sent, and what became of it
GET    /api/v1/admin/identity-provider                 # at most one per tenant, so no {id}
PUT    /api/v1/admin/identity-provider
DELETE /api/v1/admin/identity-provider
GET    /api/v1/admin/audit-sink
PUT    /api/v1/admin/audit-sink
DELETE /api/v1/admin/audit-sink
GET    /api/v1/audit/stream?afterSequence=…            # the SIEM pull cursor; audit:export
GET    /api/openapi.json                               # the schema, unversioned and served in production
```

**Phase 17's routes carry two permissions, and the split is the point.** Everything under
`/admin/` above is `integration:manage` — one key for four resources, because they are not four
independent decisions: whoever may mint a key may mint one bound to an auditor, and whoever may
point a webhook at a URL can exfiltrate the same events a sink would carry. But
`GET /audit/stream` is **`audit:export`**, because an administrator who may point the trail at a
collector is not thereby somebody who may read it, and a collector polling the cursor is not
somebody who may reconfigure where it goes.

**There is no `PATCH /admin/api-clients/{id}`, and the absence is deliberate.** A key's scopes and
its subject are what its holder was told they had; changing either silently changes what a running
integration can do, and the failure surfaces as somebody's nightly job starting to `403` with
nothing in their own logs to explain it. Revoke and mint is one more step and is a fact both sides
can see. `DELETE` **revokes** rather than deletes and answers the row, because "which keys existed,
for whom, and when were they withdrawn" is what an access review reads.

**A secret appears in exactly one response per resource and in no request that reads one.** The
`POST` bodies above are the only place an API key or a webhook signing secret exists outside its
holder's hands; there is no endpoint by which either can be asked for again, and no read schema in
`@edms/contracts` has a field for one.

**`GET /audit/stream` is keyset by `sequence` rather than paged**, and that is the whole reason the
integration is worth having. `audit_event.sequence` is per-tenant, monotonic and gap-free, so a
collector that has stored N and receives N+2 *knows* it missed one — a stronger completeness
guarantee than a timestamp window, and one an offset could not give because it answers differently
depending on when it is asked.

**A machine caller presents its key in the same `Authorization: Bearer` header a person's access
token uses**, told apart by the key's own `mdk.` prefix. A second header would mean every client
library, proxy and CORS allow-list learns a second name for "the credential", and a request
carrying both would need a precedence rule nobody would remember. A key is resolved on *every*
request — it exchanges for no session and no token — which is what makes revoking one immediate
rather than effective within an access token's lifetime.

**The bulk routes are the only ones in this API that cannot carry `@ScopedTo`** — Phase 16. That
decorator binds *one* route parameter to *one* object so `AclGuard` can resolve its scope chain
before the use case runs, and a bulk route has N objects in its body and no route parameter at all.
The check is not left out: `DefaultBulkExecutor` makes it **per object**, through the same
`ACL_RESOLVER` the guard uses, inside the transaction that writes that object — which is strictly
stronger than the guard, because the guard resolves once *before* the use case and this resolves
immediately before each write. `@RequirePermission` is still on every one of them, so
`RoutePermissionRegistry` still fails the boot on a gap.

**None of them answers `204`, and that is the contract rather than a preference.** A bulk
operation's interesting half is the part that did not happen, so each returns a tally and a row per
object whose outcome is one of four values — `APPLIED`, `REFUSED` (the caller does not reach it),
`BLOCKED` (a rule said no) and `FAILED`. The three failures are not interchangeable: a screenful of
`REFUSED` means somebody selected across a boundary they cannot see and the product behaved
correctly, a screenful of `BLOCKED` means a matter is on hold, and a screenful of `FAILED` is an
incident. `204` cannot say which.

**`POST /documents/bulk/exports` produces a manifest, not an archive**, and its links are a second
request. Phase 9's evidence bundle set the precedent — artefacts and links rather than one ZIP — and
the reason holds harder here: every byte still leaves through the audited download path, so a
release of five hundred documents writes five hundred `FILE_DOWNLOAD_ISSUED` rows rather than one,
and no document's bytes are copied into a second object. The links are minted per request against
the caller's reach *now*, because an export is the record of a release having been decided and a
link is the release happening.

**`POST /approval-tasks/bulk/decisions` accepts `APPROVED` and nothing else.** A rejection or a
request for changes must say why, and one sentence covering forty documents is a reason for the
batch rather than for any of them — which in a controlled-document system is the field an auditor
reads. The single-object route takes the other two decisions and is unchanged, so `document:reject`
is unreachable in bulk by construction.

**`GET /reports/{key}` is the one endpoint in this API whose query string is not fully enumerated by
a schema** — Phase 15. Paging is the list contract's; everything else is the report's, declared by
the catalogue entry the key names and validated against it. An unknown parameter is **refused**
rather than ignored, which is the opposite of what most query parsers do and is the right direction
here: a misspelled filter that was silently dropped produces a report over more rows than somebody
asked about, and they cannot tell by looking at it.

**There is no endpoint that streams a report body.** `REPORTING_SERVICE` has said since Phase 0.5
that "large exports are queued and audited rather than streamed from a request", so an export is a
`202` and a job. It is also the only path on which a report's bytes reach `file_object` and acquire
a digest — a `GET` that rendered a CSV inline would hand a file to somebody with nothing recording
that it left.

## 2. Requests

| Concern | Rule |
| --- | --- |
| Validation | Every body and query is a DTO with `class-validator`, sharing zod schemas from `@edms/contracts`. `whitelist` + `forbidNonWhitelisted` — unknown fields are rejected, never ignored |
| Idempotency | Every mutating endpoint accepts `Idempotency-Key`; the result is stored per `(tenantId, key)` and replayed on retry |
| Concurrency | `If-Match` with the aggregate's `version`; a mismatch is `409` with both versions named |
| Localization | `Accept-Language: en\|ar` selects server-rendered messages |
| Correlation | `X-Correlation-Id` is accepted or generated, echoed, logged and stored on audit events |
| Limits | Body ≤ 1 MB (bytes go to storage, not through the API); page size ≤ 100 |

## 3. Responses

```jsonc
// collection
{
  "data": [ … ],
  "meta": { "page": 1, "pageSize": 25, "total": 1043, "hasMore": true },
  "links": { "next": "/api/v1/documents?cursor=eyJ…" }
}
```

- **Single resources are returned bare** (no `data` envelope) so client types stay simple.
- Every document response carries a `capabilities` object — the actions this caller may perform on
  it — computed server-side. The UI renders from it and decides nothing
  ([08](./08-permission-model.md)).
- Dates are ISO-8601 UTC. Enums are `SCREAMING_SNAKE`. Ids are UUID strings. Sizes are integers in
  bytes.

## 4. Error model (RFC 7807)

```jsonc
{
  "type": "https://docs.munaxa.com/errors/invalid-transition",
  "title": "Invalid state transition",
  "status": 409,
  "code": "INVALID_TRANSITION",
  "detail": "A published document cannot return to draft. Check out the document to create a new revision.",
  "errors": [{ "field": "status", "message": "PUBLISHED → DRAFT is not permitted" }],
  "correlationId": "…"
}
```

| Status | Use |
| --- | --- |
| 400 | Malformed request |
| 401 | Missing or invalid credentials |
| 403 | Authenticated, permitted to know the object exists, but not to do this |
| 404 | Not found — **or** existing but outside the caller's scope |
| 409 | Conflict: version mismatch, illegal transition, existing lock, duplicate |
| 413 | Payload too large |
| 422 | Validation failure |
| 423 | Locked — checked out by another user |
| 429 | Rate limited (`Retry-After` always set) |
| 5xx | Server error: generic message to the client, full detail to logs and Sentry with the correlation id |

Two rules that matter more than the table: **cross-scope resources return `404`, never `403`**, so
existence is not leaked; and **an error never contains a stack trace, a SQL fragment, a file path or
another user's data**.

## 5. Authentication and authorization

```mermaid
sequenceDiagram
    participant W as Web
    participant API
    participant IDP as OIDC provider (optional per tenant)

    W->>API: POST /auth/login (email + password) or OIDC callback
    API->>IDP: verify (when the tenant federates)
    API->>API: load user, tenant, roles, permissions; enforce MFA policy
    API-->>W: access token (JWT ~15 min) + refresh token (rotating, httpOnly cookie)
    W->>API: Bearer access token
    W->>API: POST /auth/refresh when expired → rotated pair
```

- Access token claims: `sub`, `tenantId`, `roles`, `permVersion`, `sessionId`. **Object-level
  permissions are never in the token** — they are resolved per request, so a revocation is
  immediate.
- Refresh tokens rotate, are stored hashed, are revocable, and reuse is detected and kills the
  session family.
- Every mutating route carries `@RequirePermission(...)`; a route without one fails a boot-time
  assertion. Public routes are explicitly marked and carry a comment saying why.

**A machine caller is a delegated subject** — [ADR-0018](./adr/0018-machine-identity-as-a-delegated-subject.md),
Phase 17. An API key is bound to a person when it is minted and acts as that person, so
`RequestContext.userId` is never absent and every reach predicate in the product is unchanged. Its
effective permissions are the *intersection* of that person's tenant-wide grants with the key's
scopes, both read at authentication rather than snapshotted — so removing a role removes it from
every key bound to them on the next call.

A key exchanges for **no session and no token**. It is presented and resolved on every request,
which is what makes a revocation immediate rather than effective within an access token's lifetime.
`sessionId` is null for such a request, and `ActorChannel.API` and `audit_event.api_client_id` are
what the trail records — the second attested by chain hash version 3, because "which credential did
this" is the first question an incident asks and an answer only a payload carries is one somebody
with write access can change.

## 6. Documentation and contracts

- **The OpenAPI document and the OpenAPI explorer are two things**, and Phase 17 split them. The
  *explorer* is an interactive surface that enumerates every route and offers a "try it" button
  against the running deployment; it stays at `/api/docs`, and configuration still refuses to boot
  with `OPENAPI_ENABLED` in production. The *document* is a contract — what an SDK is generated
  from, what a customer's integration team reads, and what §8's compatibility rule is diffed
  against between releases — and it is served at `/api/openapi.json` **in every environment**,
  production included. Refusing to publish it there meant the one deployment whose contract anybody
  cares about was the one that would not state it.
- **The document describes the route surface, not yet the body shapes**, and that limit is
  deliberate rather than unfinished. It is built from what Nest already knows — routes, methods,
  parameters — and **not** from a hand-maintained `@ApiProperty` decorator set on DTO classes,
  because every contract is already a zod schema in `@edms/contracts` and §6's next line says those
  are the source of truth. A decorator set beside them would be a second definition of each shape,
  diverging the first time somebody edited one and not the other. Closing it means a
  zod-to-JSON-Schema projection over the existing schemas — one derivation, not a second source —
  and Phase 17's report names it as the seam rather than shipping a fifth declared-but-unbound
  contract.
- `@edms/contracts` is the TypeScript source of truth shared by API and web; the typed client is
  generated from it, so a contract change that breaks a consumer breaks the build — which is the
  point of the monorepo.
- Every endpoint documents its permission, its error codes and its idempotency behaviour. An
  endpoint without them is not done.

## 7. Rate limiting and abuse

| Surface | Limit |
| --- | --- |
| Login / password reset | Strict per IP **and** per account, with lockout and audit |
| Search | Per user, weighted by cost |
| Upload presign | Per user and per tenant, plus a storage quota check |
| Export / bulk download | Per user, queued rather than rejected, and audited |
| General | Per token, with `Retry-After` |

## 8. Compatibility

Adding an optional field or a new endpoint is safe. Changing a field's meaning, removing one,
narrowing an enum consumers may receive, or changing an error code is **breaking** and requires a
new version. Deprecation is announced in OpenAPI (`deprecated: true` plus the replacement) and kept
for one release cycle
([rulebook §12](https://github.com/tam2om/munaxa/blob/main/PLATFORM_ENGINEERING_STANDARDS.md#12-backward-compatibility)).
