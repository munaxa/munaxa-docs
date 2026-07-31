# 17 — Security Architecture

**Purpose:** the security model — identity, isolation, uploads, encryption, integrity, response.
**Audience:** everyone. Security is not a phase.

## 1. Threat model

| Asset | Threat | Primary control |
| --- | --- | --- |
| Controlled documents | Unauthorised read, download or print | ACL + confidentiality + preview-only mode + full read audit ([08](./08-permission-model.md)) |
| Tenant separation | Cross-tenant read or write | Four application layers + PostgreSQL RLS ([ADR-0002](./adr/0002-multi-tenant-isolation-model.md)) |
| Approval integrity | Forged, bypassed or replayed approval | Server-side state machine, single-decision task update, audited delegation ([07](./07-workflow-architecture.md)) |
| Audit trail | Tampering to hide an action | Append-only grants, DB trigger, hash chain, external checkpoints ([13](./13-audit-architecture.md)) |
| Uploaded files | Malware, renderer exploit, zip bomb | AV gate, sandboxed renderers, resource caps ([14](./14-preview-architecture.md)) |
| Credentials | Theft, brute force, session hijack | MFA, rotating refresh tokens, lockout, anomaly alerts |
| Signed URLs | Sharing beyond the recipient | Short TTL, single object, method-bound, issuance audited |
| Retention | Premature or blocked destruction | Legal hold, disposition review, purge audit ([ADR-0010](./adr/0010-soft-delete-and-retention.md)) |

## 2. Authentication

| Control | Rule |
| --- | --- |
| Local credentials | Argon2id hashing, breach-list check, no composition rules beyond length, no forced rotation |
| Federation | Per-tenant OIDC/SAML; the tenant's domain determines the provider; JIT provisioning to pre-mapped roles |
| MFA | TOTP and WebAuthn. Required by policy for `TENANT_ADMIN`, `DOCUMENT_CONTROLLER` and `AUDITOR`; available to all |
| Sessions | Short access token, rotating refresh token in an `httpOnly`, `Secure`, `SameSite=Lax` cookie; reuse detection kills the family |
| Lockout | Progressive delay then temporary lock, per account **and** per IP; every failure audited |
| Revocation | Disabling a user, changing a role, or an administrator ending a session invalidates within one access-token lifetime; `permVersion` in the claim forces immediate re-evaluation on the next call |

## 3. Authorization

Server-side, on every request, closed by default, with deny precedence — [08](./08-permission-model.md).
Hiding UI is a courtesy. Cross-scope objects return `404`. Every denied attempt on an existing
object is audited.

## 4. Tenant isolation

| Layer | Mechanism | Defeats |
| --- | --- | --- |
| 1 Token | `tenantId` is a signed claim | Client-supplied tenant |
| 2 Context | Request-scoped `AsyncLocalStorage` | Accidental cross-wiring between concurrent requests |
| 3 Guard | Rejects any request naming another tenant | Parameter injection |
| 4 Data | Prisma extension scopes reads and stamps writes | A forgotten `where` clause |
| 5 Database | RLS policies on a `NOBYPASSRLS` application role | Any application bug at all |

Migrations run as a separate owner role. **Weakening or bypassing any layer is prohibited**
([rulebook §13](../../../PLATFORM_ENGINEERING_STANDARDS.md#13-prohibited-actions)).

## 5. Upload and content security

| Control | Rule |
| --- | --- |
| Type validation | Content sniffing, not extension; declared and detected type must agree; tenant allow-list |
| Size | Per-type limit; multipart above the threshold; quota enforced before presign |
| Antivirus | Mandatory. `scan_status <> 'CLEAN'` means unattachable and undownloadable — enforced in the use case and by a DB check. Infected content is quarantined, deleted from storage, and raises an audited incident |
| Archives | Depth, entry-count and expansion-ratio limits; a zip bomb fails the job, not the worker |
| Rendering | Sandboxed containers, no DB credentials, no network egress, macros disabled, CPU/memory/time caps |
| Serving | Downloads are `Content-Disposition: attachment` with a sanitised filename and `X-Content-Type-Options: nosniff`; user content is served from a separate origin so it can never inherit application privileges |
| SVG and HTML | Sanitised or rendered as an image; never served as active content |

## 6. Web application security

| Control | Implementation |
| --- | --- |
| Transport | TLS 1.2+, HSTS with preload |
| CSP | Strict, nonce-based; no `unsafe-inline`, no `unsafe-eval`; user content on its own origin |
| XSS | React escaping by default; no `dangerouslySetInnerHTML` over user content; server-side sanitisation of any rich text |
| CSRF | Bearer tokens for the API; the refresh cookie is `SameSite=Lax` and refresh requires a header the browser will not send cross-site |
| Clickjacking | `frame-ancestors 'none'` |
| Headers | `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` minimal |
| Injection | Parameterised queries only; no string-built SQL; search filters allow-listed, never passed through |
| SSRF | No user-supplied URL is fetched by the server; the OIDC discovery endpoint is the only outbound URL, from a configured allow-list |
| Mass assignment | DTO whitelisting with `forbidNonWhitelisted` |
| Rate limiting | Per IP and per identity on auth, search, presign and export ([15](./15-api-architecture.md)) |
| Dependencies | Lockfile, automated advisories, no unpinned transitive fetch at build time |

## 7. Data protection

| Data | Handling |
| --- | --- |
| Documents | Encrypted at rest by the provider; customer-managed keys per tenant where required; TLS in transit |
| Database | Encrypted at rest; backups encrypted with separate keys |
| Secrets | Environment or a secret manager. Never committed; `.env.example` carries placeholders only |
| Logs | No credential, token, file content or personal identifier. Correlation ids, not names |
| Personal data | Minimised in audit payloads and notifications; deletion requests are handled by anonymising the user record while preserving audit integrity (the actor id survives, the identity is redacted) |
| Backups | Encrypted, restore-tested quarterly ([20](./20-deployment-architecture.md)) |

## 8. Integrity

- Every blob's SHA-256 recorded at creation; a rolling verifier plus verification on every preview
  fetch; mismatch quarantines and raises an incident.
- Audit hash chain with daily verification and external checkpoints.
- Published revisions are immutable by construction; there is no code path that updates one.
- Optional WORM/object-lock for tenants with regulatory retention.

## 9. Monitoring and response

| Signal | Alert |
| --- | --- |
| Repeated `ACCESS_DENIED` by one actor | Possible enumeration |
| Bulk download or export beyond a baseline | Possible exfiltration |
| Audit chain break | Immediate, highest severity |
| `SCAN_INFECTED` | Immediate, with the uploader and the quarantined blob |
| Checksum mismatch | Immediate |
| Login anomaly (new country, impossible travel) | Notify user and administrator |
| RLS policy or grant change | Immediate |

Incidents follow a written runbook: contain (revoke sessions, quarantine content), assess with the
audit trail, notify per the tenant's contractual window, remediate, and record the outcome as a
dated report in `edms/docs/reports/`.

## 10. Prohibited, permanently

Weakening a guard, filter, validator or policy to make something pass; disabling tenant scoping or
RLS; marking a route public without a written reason; committing a secret; logging a credential;
adding a lint or type suppression to get past a security rule; skipping the antivirus gate in any
environment that holds real data.
