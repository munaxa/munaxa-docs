# 16 — Enterprise Document Engine (Phase 23)

A reusable engine that generates every official school document — **Admissions** documents
(Registration Agreement) and **Finance** documents (receipts, certificates, statements) — from a
**permanent snapshot**, stores the rendered PDF **immutably**, and **archives + audits** every
generation, print, download and email. It is an _enhancement_: it **consumes** the existing Billing
Ledger / Statement / Organization data and never creates or duplicates a financial record.

> Admissions documents and Finance documents are separated, the way enterprise ERPs do it. The
> Registration Agreement is a **legal commitment**, not a receipt; receipts live entirely in Finance
> and are independent of Admissions.

## Where it lives

- **Backend:** `apps/api/src/documents/`
  - `pdf/document-layout.ts` — declarative layout types (no hardcoded layouts; templates emit data).
  - `pdf/pdf-renderer.ts` — pdfkit renderer for the declarative layout (header/fields/table/totals/
    signatures/footer). Lazily imports pdfkit.
  - `branding.service.ts` — resolves school branding from `OrganizationSettings` (Part 7).
  - `document-engine.service.ts` — the reusable core: collect → merge-branding → render → archive.
  - `document.repository.ts` — gapless numbering, immutable archive, print/download/email logging,
    context reads, registration-agreement persistence + signed-copy handling.
  - `templates/` — pure functions mapping collected data → a `DocumentLayout` (+ `tuition-calc.ts`).
  - `finance-documents.service.ts` — collectors for each finance document type.
  - `registration-agreement.service.ts` — snapshot + (idempotent, one-per-enrollment) agreement
    generation and signed-copy upload/replace/view/delete.
  - `documents.service.ts` / `documents.controller.ts` / `documents.dto.ts` — orchestration + API.
- **Frontend:** `apps/admin/.../students/[studentId]/tabs/documents-section.tsx` (Student Finance
  Card → Documents) + `apps/admin/src/lib/documents.ts` (API client).
- **Schema:** `prisma/schema.prisma` + migration `20260628140000_document_engine`.

## Data model (additive, RLS-isolated)

| Model | Purpose |
|-------|---------|
| `GeneratedDocument` | Immutable archived document. PDF stored in `pdf` (bytea) + `checksum` (sha256) + `byteSize`. Tracks `printedCount`/`lastPrintedAt`, `version`, `status` (ARCHIVED/SUPERSEDED/CANCELLED) and the `dataSnapshot` it was built from. |
| `RegistrationAgreement` | The legal commitment — **exactly one immutable agreement per enrollment** (no versioning). Permanent `feeBreakdown` + `installmentSchedule` + `grandTotal` snapshot; links to its `GeneratedDocument`. Lifecycle `status` (GENERATED → PRINTED → SIGNED, or CANCELLED/ARCHIVED). The parent's countersigned copy is referenced by `signedFileKey` (object storage — never stored inline) plus `signedBy`/`signedAt`/`signedUploadedBy`/`signedUploadedAt`. `version`/`supersedesId` are deprecated (retained for backward compatibility; always 1). |
| `DocumentSequence` | Gapless per-tenant, per-scope counter (`AGREEMENT`, `DOC:<type>`) — same row-locked pattern as `FinanceReceiptCounter` / the JoFotara ICV. |

> The archive model is named `GeneratedDocument` (not `Document`) because a `Document` model already
> exists for parent-portal shared uploads.

PDFs are stored in Postgres so reprints always serve the **exact stored snapshot** (not a re-render)
and the flow works in every environment (no object-storage dependency). A `fileKey` offload to S3 can
be added later without changing the API.

## Workflows

### Admissions (Part 1)
`Review → Commit Registration → (Student/Parent/Enrollment/Ledger/Charges/Installments/Audit) →
Registration Completed → **auto-generate Registration Agreement** → print (optional) → Open Finance`

The agreement is generated automatically right after a successful **COMMITTED** commit
(`AdmissionsService.commit`), and on approval of a held (fee-modified) enrollment
(`AdmissionsService.approve`). Generation is best-effort and never blocks/fails the registration.

**One immutable agreement per enrollment (no versioning).** The agreement captures what the parent
agreed to at registration and is **never** regenerated or superseded — generation is **idempotent**
(re-running returns the existing agreement). Later financial changes (transport, scholarship,
discount, corrections) are handled entirely by the **billing ledger**, never by editing or
re-issuing the agreement. If a school needs additional legal paperwork after registration, add a
separate document type (e.g. a Financial Amendment Agreement) — do not touch the original.

**Signed copy.** After the agreement is printed and countersigned, staff upload the signed copy
(PDF/JPG/PNG) via a pre-signed, tenant-scoped storage key (reusing `StorageService`); only the key is
stored (never the bytes). Lifecycle: `GENERATED → PRINTED` (derived from the linked document's print
counter) `→ SIGNED`. Actions are permission-gated — `document:upload_signed`,
`document:replace_signed`, `document:delete_signed` — and every upload/replace/view/delete is audited
(`document.registrationAgreement.sign{Upload,Replace,View,Delete}`), with tenant isolation enforced on
the storage key.

### Finance (Part 2)
`Receive → Verify → Allocate → Update Ledger → Generate Receipt → Print → Email`. Receipt generation
is fully independent of Admissions and is driven from the existing verified `Transaction` + ledger.

## Document types (Parts 3 & 6)

`REGISTRATION_AGREEMENT`, `PAYMENT_RECEIPT`, `ANNUAL_TUITION_CERTIFICATE`,
`OUTSTANDING_BALANCE_CERTIFICATE`, `CLEARANCE_CERTIFICATE`, `ACCOUNT_STATEMENT`, `PAYMENT_HISTORY`,
`FEE_BREAKDOWN`, `STUDENT_FINANCIAL_SUMMARY`. New types = a new enum value + a new template function.

### Annual Tuition Certificate
Computed automatically from the ledger — no manual typing. The registrar selects an **academic year**,
a **language** (EN / AR / BILINGUAL) and optional categories (transport, registration, books, …);
tuition is always included. Money actually paid (ledger) is attributed across the selected categories
in a deterministic priority order (tuition first), capped at each category's net charge
(`templates/tuition-calc.ts`). Wording is generic and tenant-configurable — there is **no hardcoded
reference to any country's tax authority**, so it localizes beyond Jordan.

## Persistence strategy (Phase 23b — storage optimisation)

Each document type declares a **persistence strategy** in `document-strategy.ts`; the engine needs no
other change to add a type:

| Strategy | Used by | Storage | On print/download/email |
|----------|---------|---------|--------------------------|
| **SNAPSHOT** | Registration Agreement (legal records) | Rendered PDF stored immutably (`pdf` bytea + `checksum` + `byteSize`) + versioned archive | Serves the **stored** bytes (never re-rendered) |
| **DYNAMIC** | All finance documents (receipts, certificates, statements) | **Metadata only** — `pdf`/`checksum`/`byteSize` are NULL; `params` holds the re-render inputs | **Re-rendered live** from the billing ledger each time, then discarded |

This removes archived PDFs (and their unbounded DB growth) for every operational report while keeping
legal documents immutable. Dynamic builders are pure (`params → layout`), so the same `build()` powers
the first generate and every later download/print/email — the **Billing Ledger remains the single
source of truth** and receipts/statements are never cached or duplicated.

Generation flows:

```
SNAPSHOT:  collect → render PDF → archive PDF → (print/download/email serve stored bytes)
DYNAMIC:   collect → persist metadata + params   (no PDF)
           on demand: rebuild from params → render in memory → stream → discard
```

## Access history & counters (Phase 23b)

Every action is recorded in **`DocumentAccessLog`** (`GENERATE`/`PRINT`/`DOWNLOAD`/`EMAIL`/`VIEW`,
with actor, status, IP, user-agent). The `printedCount` / `downloadCount` / `emailCount` +
`last*At` / `last*ById` columns on `GeneratedDocument` are a denormalised cache of that log, updated
in the same transaction. `GET /documents/:id/history` returns the full per-action history.

## Email delivery & history (Phase 23b)

`POST /documents/:id/email` resolves recipients from the requested parent roles (**primary parent by
default**, plus secondary parent / guardian) and any custom addresses, with CC/BCC, Reply-To, subject
and message overrides. SNAPSHOT docs attach the stored PDF; DYNAMIC docs are rendered immediately
before sending and **never archived**. Delivery is metadata-only in **`DocumentEmailLog`** (recipients,
cc, bcc, subject, provider response, status, retry count) — attachments are never stored. Reuses the
existing `MailService` (Resend) — no second email system.

## Security & audit (Part 8)
- All documents inherit **tenant isolation** (RLS `FORCE ROW LEVEL SECURITY`, `app_current_tenant()`).
- Stored PDFs are **immutable snapshots** (checksummed).
- Every **generate / print / download / email** writes an `AuditLog` entry.

## Permissions
- `document:read` — view/list/download/reprint archived documents.
- `document:generate` — generate official documents and email them.
- `document:upload_signed` — upload the parent's countersigned agreement.
- `document:replace_signed` — replace an uploaded signed agreement.
- `document:delete_signed` — delete an uploaded signed agreement.

`document:read`/`generate` are granted to `FinanceOfficer`, `Accountant`, `Registrar` (both) and
`Principal` (read). The signed-copy permissions are granted to `Registrar` and `FinanceOfficer`
(upload + replace + delete) and `Accountant` (upload + replace, **not** delete). `SchoolAdmin` has all
permissions.

## API (`/api/v1/documents`)
| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| GET | `/documents` | `document:read` | List the archive (by student/type/enrollment). |
| GET | `/documents/academic-years` | `document:read` | Years for the tuition-certificate picker. |
| POST | `/documents/generate` | `document:generate` | Generate & archive a finance document. |
| GET | `/documents/agreements` | `document:read` | List registration agreements (enriched: derived status, print stats, signer/uploader). |
| POST | `/documents/agreements` | `document:generate` | Generate the agreement for an enrollment (**idempotent** — one per enrollment). |
| POST | `/documents/agreements/:id/signed/presign` | `document:upload_signed` | Pre-sign a signed-copy upload (PDF/JPG/PNG). |
| POST | `/documents/agreements/:id/signed` | `document:upload_signed` | Confirm the first signed-copy upload. |
| PUT | `/documents/agreements/:id/signed` | `document:replace_signed` | Replace the signed copy (audited). |
| GET | `/documents/agreements/:id/signed` | `document:read` | Short-lived, tenant-scoped URL to view the signed copy (audited). |
| DELETE | `/documents/agreements/:id/signed` | `document:delete_signed` | Delete the signed copy (audited). |
| GET | `/documents/:id` | `document:read` | Document metadata. |
| GET | `/documents/:id/history` | `document:read` | Per-action access history. |
| GET | `/documents/:id/download` | `document:read` | Download the PDF — stored (SNAPSHOT) or re-rendered live (DYNAMIC); audited. |
| POST | `/documents/:id/print` | `document:read` | Reprint (records PRINT; re-rendered live if DYNAMIC). |
| POST | `/documents/:id/email` | `document:generate` | Email the PDF (resolves recipients; audited; metadata-only history). |

## Arabic rendering
pdfkit ships Latin-only fonts. AR/BILINGUAL labels are wired through the data layer; to render Arabic
glyphs, configure an Arabic-capable TTF via `PDF_ARABIC_FONT_PATH` (the renderer embeds it). Without
it, the standard font is used.

## Tests
- `apps/api/src/documents/**/*.spec.ts` — persistence strategy, tuition allocation, template utils,
  and real PDF rendering.
- `apps/api/test/documents.e2e-spec.ts` — DYNAMIC generate (no stored PDF), live re-render on
  download, reprint counters, per-action access history, email-log, audit and RBAC against Postgres.
