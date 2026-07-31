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
GET    /api/v1/reports/{key}
```

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

## 6. Documentation and contracts

- **OpenAPI** is generated from controllers and DTO decorators, served at `/api/docs` in non-production
  and emitted as a build artifact.
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
([rulebook §12](../../../PLATFORM_ENGINEERING_STANDARDS.md#12-backward-compatibility)).
