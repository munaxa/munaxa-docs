# E-Invoicing Framework Architecture

**Scope:** a provider-agnostic e-invoicing engine for Munaxa, with **JoFotara (Jordan) as
Provider #1** and a seam for ZATCA (KSA), ETA (Egypt), UAE e-invoicing, and others — adding a
provider must never require touching the Finance module.

> Stack note: the Phase 16 prompt says "Laravel"; Munaxa is **NestJS + Prisma + Next.js**, so the
> module follows the house architecture (DDD modules, RLS multi-tenancy, feature flags, RBAC).

## 1. Layering

```
Finance module (Charges / Transactions / FeePlans)        ← unchanged
        │  (reads; never writes back into finance)
        ▼
E-Invoicing Engine        apps/api/src/einvoicing/
  • EInvoiceService       create/issue/credit documents, ICV allocation, lifecycle
  • SubmissionQueue       DB-backed queue + retry/backoff + dead-letter
  • SettingsService       wizard state, per-tenant config (DB, no hardcoding)
  • CredentialService     AES-256-GCM encrypt/decrypt, masked reads
        │
        ▼
Provider abstraction      EInvoiceProvider (interface) + ProviderRegistry
        │
        ├── JoFotaraProvider      UBL 2.1 builder + HTTP client + response parser   ← Provider #1
        ├── (future) ZatcaProvider
        ├── (future) EtaProvider
        └── (future) UaeProvider
```

### The provider contract

```ts
interface EInvoiceProvider {
  readonly key: string; // 'jofotara'
  buildPayload(doc: EInvoiceDocumentModel, cfg: TenantEInvoiceConfig): ProviderPayload; // XML/JSON
  submit(payload: ProviderPayload, creds: DecryptedCredentials): Promise<ProviderResult>;
  testConnection(creds: DecryptedCredentials): Promise<ConnectionStatus>;
}
```

`ProviderResult` normalises every provider's response to: `status` (ACCEPTED / REJECTED /
TRANSIENT_ERROR), `externalUuid`, `qrCode`, `signedDocument`, `validationMessages[]`. The engine
only ever sees this shape — JoFotara's `EINV_*`/camelCase duality lives inside the adapter.

## 2. Document model & lifecycle

`EInvoiceDocument` is the engine's own record (it does not mutate finance rows). It is created
from a finance source (a `Transaction` for cash receipts, a `Charge` for receivable invoices) or
as a **credit note** referencing a previous document.

```
DRAFT ──queue──▶ QUEUED ──worker──▶ SUBMITTING ──▶ ACCEPTED   (QR + signed XML stored)
                   ▲                    │
                   └──── backoff ◀── TRANSIENT_ERROR (attempts < max)
                                        │
                                        ├─▶ REJECTED      (validation errors stored; manual fix + resubmit)
                                        └─▶ DEAD_LETTER   (attempts exhausted; manual requeue)
CANCELLED (only from DRAFT/REJECTED/DEAD_LETTER)
```

- **ICV** is allocated from a per-tenant row-locked counter **in the same transaction** that moves
  DRAFT→QUEUED, guaranteeing a gapless monotonic sequence per income source.
- **UUID** is generated at document creation and never changes → retries are idempotent
  (`ALREADY_SUBMITTED` ⇒ ACCEPTED).
- Credit notes require `originalDocumentId` + `reason`, and quantities ≤ original (validated).

## 3. Queue design

DB-backed queue (no new infra): `EInvoiceDocument.status = QUEUED` rows are claimed by a NestJS
interval worker with `FOR UPDATE SKIP LOCKED`, processed per tenant with its decrypted
credentials. Retry policy: exponential backoff (1m, 5m, 25m, 2h, 12h — 5 attempts) on
TRANSIENT_ERROR (timeout / 5xx / network); REJECTED (validation PASS=false / 400) does **not**
retry — it surfaces in the error dashboard for correction. Exhausted attempts → DEAD_LETTER with
the last error preserved; operators can requeue after fixing. The worker is a no-op for tenants
whose feature flag is off (hard kill-switch: no generation, no API calls, no queue processing).

## 4. Multi-tenancy, flags & RBAC

- All tables carry `tenantId` + **RLS** like every other module; siloed tenants work automatically
  via `TenantConnectionManager`.
- Feature flag key **`e_invoicing`** gates every controller (`@RequireFeature`) and the worker.
- Permissions: reuse `finance:manage` (configure, submit, requeue) and `finance:read` (view
  documents/dashboard). Credentials writes additionally require `finance:manage`; the Secret-Key
  is never returned (masked hint only).

## 5. Security design

- **Secrets at rest:** AES-256-GCM via `CryptoService`; master key from env/secrets manager
  (`EINVOICE_MASTER_KEY`, 32 bytes base64). Ciphertext format `v1:<iv>:<tag>:<data>` allows key
  rotation (`v2:` …).
- Secret never logged, never serialised to DTOs, masked to `••••1234` in reads.
- Input validation on all DTOs (class-validator); TIN digits-only; invoice ID sanitised.
- Immutable `EInvoiceLog` rows record every transition/submission (who, when, request id,
  response summary) → audit trail for ISTD's 4-year retention; documents store the exact
  submitted XML + signed response.
- Rate limiting: global Throttler already applies; the worker batches per tick to avoid hammering
  the provider.

## 6. Wizard (per-tenant configuration — zero hardcoding)

State machine persisted in `EInvoiceSettings` (one row per tenant), steps:

1. **Enable** — feature on/off; environment: `SIMULATION` (no real calls, fake PASS — JoFotara has
   no public sandbox) or `PRODUCTION` (+ configurable endpoint URL).
2. **School info** — legal name, TIN, VAT no., commercial registration, address/city/country,
   phone, email.
3. **Device registration** — Client-Id, Secret-Key (encrypted), income source sequence;
   **Test connection** button → provider `testConnection`.
4. **Invoice mapping** — taxpayer type (income/sales/special), buyer-ID scheme default
   (NIN/TN/PN), per-fee-category item naming (JSON mapping engine).
5. **Tax configuration** — VAT enabled, default %, default tax category (S/Z/O), invoice type
   defaults (cash vs receivable per source).
6. **Template** — bilingual PDF/print options (logo, header/footer, AR/EN/bilingual) stored as
   JSON; the validated invoice embeds **QR + UUID + status**.
7. **Test submission** — generates a test document end-to-end (XML → validate → submit →
   response) and shows the checklist; in SIMULATION this exercises the full pipeline locally.

Settings store `completedSteps[]` so the wizard is resumable ("Save draft").

## 7. Dashboard

`GET /einvoicing/dashboard`: connection status (last test result + at), invoices today / this
month, counts by status (accepted, pending=queued+submitting, rejected, dead-letter), last sync
at, last error. Rendered as a widget on the admin Integrations page.

## 8. Error handling & reporting

- **Error dashboard**: REJECTED + DEAD_LETTER lists with provider validation messages.
- **Manual resubmission**: `POST /einvoicing/documents/:id/requeue` (resets attempts; allowed from
  REJECTED/DEAD_LETTER after edit).
- Reports: submitted invoices, failures, validation errors, monthly statistics — all derivable
  from `EInvoiceDocument` + `EInvoiceLog` (and exposed via the existing Reporting module patterns).

## 9. Testing strategy

- **Unit (compliance-critical):** UBL builder golden-file tests — cash/receivable × income/sales,
  credit note, Arabic content, rounding edge cases, Z/O/S category mapping, buyer rules.
- **Unit:** CryptoService round-trip + tamper detection; response parser (both API shapes);
  backoff schedule.
- **e2e:** wizard lifecycle (steps, draft, validation), credential masking, feature-flag gating,
  RBAC, document creation → simulated submission → ACCEPTED with QR, requeue flow.
- **Load/compliance (CI-external):** batch submission against SIMULATION; reconciliation vs
  official PDFs when downloaded.

## 10. Deployment & operations

- Migration adds tables + RLS; `migrate:tenants` fans out to siloed tenants as usual.
- New env: `EINVOICE_MASTER_KEY` (required only when the feature is enabled for some tenant).
- Rollback: feature flag off ⇒ module inert; tables are additive (no finance schema changes).
- DR: documents/logs are in the tenant DB → covered by existing backup strategy (4-year retention
  satisfied by backup policy + soft immutability of logs).

## 11. Multi-country expansion

Adding ZATCA/ETA/UAE = one new adapter implementing `EInvoiceProvider` + provider-specific config
schema (JSON) + its wizard step variants. The engine, queue, document model, dashboard, RBAC and
storage are unchanged. Country specifics that differ (e.g. ZATCA's local QR generation + CSID
PKI, ETA's signing) live entirely inside the adapter; `ProviderResult` already models
locally-generated vs server-returned QR via the adapter filling the field either way.
