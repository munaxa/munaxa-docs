# 17 — Security Architecture

**Purpose:** the security model — identity, isolation, uploads, encryption, integrity, response.
**Audience:** everyone. Security is not a phase.

## 1. Threat model

| Asset | Threat | Primary control |
| --- | --- | --- |
| Controlled documents | Unauthorised read, download or print | ACL + confidentiality + preview-only mode + full read audit ([08](./08-permission-model.md)) |
| Tenant separation | Cross-tenant read or write | A database per tenant, plus the application layers and PostgreSQL RLS inside each ([ADR-0015](./adr/0015-database-per-tenant.md)) |
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
| Federation | Per-tenant **OIDC**; the tenant's domain determines the provider; JIT provisioning to pre-mapped roles. **Built in Phase 17** — see below |
| MFA | TOTP built (Phase 14). WebAuthn is not, and the role policy below is not enforced — both are limits with named blockers, not omissions |
| Sessions | Short access token, rotating refresh token in an `httpOnly`, `Secure`, `SameSite=Lax` cookie; reuse detection kills the family |
| Lockout | Progressive delay then temporary lock, per account **and** per IP; every failure audited |
| Revocation | Disabling a user, changing a role, or an administrator ending a session invalidates within one access-token lifetime; `permVersion` in the claim forces immediate re-evaluation on the next call |

### What Phase 17 built from the federation row, and what it did not

**"OIDC/SAML" is now honestly "OIDC".** One adapter serves SSO, Microsoft Entra ID and Google
Workspace, because those three are not three integrations: the two named providers differ in a
discovery URL and in which claim carries the groups, and both are columns on `identity_provider`.
SAML is absent for a reason a command answered rather than a preference — verifying an assertion
needs XML canonicalisation and XML-DSig, there is no XML parser in this lockfile at any level, and
hand-writing C14N in a security product is the trade Phase 14 refused for WebAuthn's CBOR.
`identity_provider_kind` has one value so that adding `SAML` later is a migration rather than a
redesign.

**LDAP is not federation and is not built.** It is a wire protocol rather than an HTTP redirect
flow — BER-encoded ASN.1 over a socket with its own bind, search and TLS negotiation — and needs a
dependency the lockfile cannot gain. **Microsoft 365 is a third thing again**: it is not
authentication at all but a *content* integration (SharePoint and OneDrive as a document source),
and conflating it with Entra ID because both say "Microsoft" is the mistake the phase report names.

**ID-token verification is hand-written over `node:crypto` and that is not the same trade SAML
refuses.** Node 22 imports a JWK and verifies RS256 and ES256 natively, so no cryptography is
written here — what is written is a base64url split, an `alg` allow-list matched to the key type
(closing `none` and the RS256→HS256 confusion attack), an exact issuer comparison, an audience
comparison including `azp`, an expiry, and a constant-time nonce check. Every one is a string or a
number comparison a reader can check by eye. CBOR, COSE and XML-DSig are the opposite: formats
where the *parsing* is the hard part and a subtly wrong implementation still accepts valid input.

**A provider asserts identity and group membership, never authority.** `role_mappings` runs one way
— provider value → Munaxa role key — so nothing in a token can name a role, which is what
"pre-mapped" above means. A mapped key that matches no role in the tenant is **dropped rather than
created**. A returning federated user's roles are deliberately *not* re-synchronised on each
sign-in: that would make the provider the authority on Munaxa roles, so an administrator's local
grant would silently vanish at the person's next sign-in.

### The MFA row, and why it is still not enforced

`MFA_REQUIRED_ROLES` names `TENANT_ADMIN`, `DOCUMENT_CONTROLLER` and `AUDITOR` and nothing reads it.
Phase 14 deferred enforcement here and Phase 17 declines it again, for the reason Phase 14 gave and
which has not changed: **switching it on locks out exactly the accounts that administer a tenant,
and the only way back in is [ADR-0013](./adr/0013-operator-console-as-separate-surface.md)'s
operator console, which no phase has built.** Phase 12's chain-broken alert reaches tenant
administrators as a stand-in for an operator channel, and a stand-in is not a recovery path for
people who cannot sign in.

WebAuthn is unbuilt for a dependency reason answered with a command: `cbor`, `fido2-lib` and
`@simplewebauthn/server` are absent from the store entirely, and attestation formats are the
hand-written-parser trade above.

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
([rulebook §13](https://github.com/tam2om/munaxa/blob/main/PLATFORM_ENGINEERING_STANDARDS.md#13-prohibited-actions)).

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
| SSRF | Every outbound request to a tenant-chosen address goes through `OUTBOUND_HTTP_PORT` and nothing else. **Built in Phase 17** — see below |
| Mass assignment | DTO whitelisting with `forbidNonWhitelisted` |
| Rate limiting | Per IP and per identity on auth, search, presign and export ([15](./15-api-architecture.md)) |
| Dependencies | Lockfile, automated advisories, no unpinned transitive fetch at build time |

### The outbound boundary, built in Phase 17

This row was unfalsifiable for sixteen phases: nothing fetched a user-supplied URL because nothing
fetched anything except the mail provider's fixed endpoint, and the allow-list did not exist because
nothing needed one. Phase 17 is where it describes a real risk — a webhook endpoint, an OIDC
discovery document and a SIEM collector are all *URLs a tenant administrator types*, and tenant
administrators are a role every customer has several of.

`OUTBOUND_HTTP_PORT` is the only path, and it refuses in this order, each check closing a bypass
for the one before it:

1. **Scheme.** `https` only, except where a deployment explicitly permits `http` for a development
   collector — refused outright in production.
2. **Host, against `OUTBOUND_HTTP_ALLOWLIST`.** An **operator's** setting and the only configuration
   in the phase a tenant cannot touch, because a boundary the people inside it can edit is not one.
   **Empty by default**, so webhooks, federation and audit push are inert until an operator names a
   host.
3. **Every resolved address**, against the private, loopback, link-local, CGNAT and unique-local
   ranges — `169.254.169.254` first among them. Every answer, not the first: a name resolving to one
   public and one private address is a rebinding attack pre-assembled.
4. **The connection is made to the address that was checked**, with the hostname restored in `Host`
   and SNI. Resolve-validate-then-fetch-by-name is a control that does not control anything, because
   the stack resolves again.
5. **No redirects, at all.** A permitted host answering `302 http://169.254.169.254/` would
   otherwise carry the request past every check above.

A refusal names the rule and never the resolution, so it is not a DNS oracle for the network the
server sits in. `permits()` answers the policy question without opening a socket, which is why an
administrator saving a webhook is told at that moment rather than in a delivery log an hour later.

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
