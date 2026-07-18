# JoFotara Compliance Analysis Report

**Module:** E-Invoicing Framework — Provider #1: JoFotara (Jordan)
**Status:** Phase 1 deliverable — completed **before** implementation, per the Phase 16 prompt.
**Date:** 2026-06-09

## 0. Sourcing & methodology

The primary source of truth is the official ISTD documentation. `istd.gov.jo` and
`portal.jofotara.gov.jo` return HTTP 403 to automated fetchers, so the PDFs must be downloaded in a
browser; their URLs are confirmed live. Facts below are tagged:

- **[OFFICIAL]** — istd.gov.jo / portal.jofotara.gov.jo document (URL listed). The **Joining**
  manual has now been obtained and read directly (`official/procedure_manual_for_joining.pdf` in
  this folder); its facts are marked **[OFFICIAL ✓read]**.
- **[OFFICIAL-MIRROR]** — verbatim transcription of the official linking manual (EN+AR) found in
  `github.com/aboameen22/National-E-invoicing-System-JoFotara` (Form1.vb / Form2.vb), cross-checked
  for consistency against production integrations.
- **[SECONDARY]** — production-grade vendor code/docs, principally **Odoo SA's `l10n_jo_edi`**
  module (a shipping JoFotara integration), SAP CCO plugin `E2ABS/ISTD`, and independent SDKs.
- **[SECONDARY: Daftra]** — Daftra's published Arabic linking guide (دليل الربط مع نظام الفوترة
  الأردني), reviewed 2026-06; an independent shipping accounting product. Used to corroborate the
  device-linking steps, credential terminology, the three invoice types, and the return flow.

Official documents (download manually; they override everything below if they differ):

| Document | Status | URL |
| --- | --- | --- |
| **الدليل التقني للربط — Technical Linking Guide v1.5 (2026-05-12, API)** | **✓ read — `official/procedure_manual_technical_linking_v1.5.pdf`** | (Arabic; the authoritative API spec) |
| Procedure Manual for **Linking** (EN) | superseded by the technical guide above | <https://istd.gov.jo/ebv4.0/root_storage/en/eb_list_page/procedure_manual_for_linking_to_the_jordanian_national_electronic_invoicing_system.pdf> |
| Procedure Manual for **Joining** (EN) | **✓ read — `official/procedure_manual_for_joining.pdf`** | <https://istd.gov.jo/ebv4.0/root_storage/en/eb_list_page/procedure_manual_for_joining_the_jordanian_national_electronic_invoicing_system.pdf> |
| Procedures Manual **Organizing the Invoice** (EN) | not yet read | <https://istd.gov.jo/ebv4.0/root_storage/en/eb_list_page/procedures_manual_organizing_the_invoice_in_the_jordanian_national_electronic_invoicing_system.pdf> |
| دليل إجراءات الربط (AR) + joining/organizing manuals | — | `istd.gov.jo/ebv4.0/root_storage/ar/eb_list_page/…` |
| Portal user guide | — | <https://portal.jofotara.gov.jo/ccb81f8923f9894ae4aa.pdf> |

> **Open items — RESOLVED against the official Technical Linking Guide v1.5** (read directly,
> `official/procedure_manual_technical_linking_v1.5.pdf`):
> - **`currencyID`** — the manual is explicit and repeated: the `DocumentCurrencyCode` /
>   `TaxCurrencyCode` **elements** are `JOD`, but every monetary **amount** carries
>   `currencyID="JO"` (e.g. `<cbc:TaxAmount currencyID="JO">4.480`). The UBL builder was
>   **corrected** from `currencyID="JOD"` → `currencyID="JO"` to match the manual (some production
>   integrations emit `JOD`; the official manual is the source of truth here).
> - **Error/response structure** — confirmed exactly as our adapter parses it: `EINV_RESULTS{status,
>   INFO[],WARNINGS[],ERRORS[{EINV_CODE,EINV_CATEGORY,EINV_MESSAGE}]}`, `EINV_STATUS` ∈
>   {`SUBMITTED`,`ALREADY_SUBMITTED`}, `EINV_QR`, `EINV_SINGED_INVOICE` (the official field, typo and
>   all), `EINV_NUM`, `EINV_INV_UUID`. HTTP 200 = received → check `EINV_STATUS`. (Example
>   `EINV_CODE`: `XSD_VALID` "Complied with UBL 2.1 standards"; the full common-error table is at
>   manual §C / p.101 — a future pass can enumerate it for the dashboard.)
> - **Sandbox** — the technical manual describes **no** test/sandbox host (registration → device
>   linking → submit to the one production endpoint). Our `SIMULATION` environment (local PASS) is
>   therefore the correct approach.
>
> Endpoint (`https://backend.jofotara.gov.jo/core/invoices/`), `Client-Id`/`Secret-Key` headers,
> base64-XML JSON body, UBL 2.1 `Invoice` root, type codes (011/021/012/022/013/023; 388/381), ICV
> reference, tax category block (`UN/ECE 5305` S/Z/O + `TaxScheme` VAT `UN/ECE 5153`), income-invoice
> tax omission, per-line `DISCOUNT` allowance, and 3-dp amounts were all **verified to match** the
> manual's worked examples.

## 1. Business requirements

### Who must issue e-invoices

- Phase 2 made e-invoicing **mandatory for all B2B/B2C/B2G transactions from 1 April 2025**, for
  all taxpayers under ISTD jurisdiction — no turnover threshold. Non-compliant invoices are invalid
  for VAT input deduction and accounting purposes. [SECONDARY: Pagero, VATupdate, vatit.com, EDICOM]
- Legal basis: Amended Billing and Control Regulation No. 2 of 2025 (amending No. 34 of 2019).
  [SECONDARY]
- **Implication for Munaxa:** every private school invoicing tuition/fees in Jordan must submit
  through JoFotara. This is a hard product requirement, not an optional add-on.

### Invoice families (by taxpayer registration)

| Taxpayer type | Tax content | Munaxa note |
| --- | --- | --- |
| **Income** (not VAT-registered) | **No tax elements at all** (omit, don't send 0%) | Most private schools whose tuition is VAT-exempt may register here |
| **General sales tax** | VAT per line (16% standard; 1–5, 7, 8, 10% reduced) | Schools selling taxable goods/services (uniforms, books, transport may vary) |
| **Special sales tax** | Special fixed tax + general tax per line | Unlikely for schools; supported for completeness |

[OFFICIAL-MIRROR; mirrored by Odoo `l10n_jo_edi_taxpayer_type = income | sales | special`]

### Invoice types

- Every invoice is **cash (نقدي)** or **receivable/credit (ذمم)** — encoded in
  `InvoiceTypeCode/@name` (see §3). School fee invoices issued before payment are **receivable**;
  point-of-payment receipts are **cash**. [OFFICIAL-MIRROR]
- **Credit notes / returns** = type **381** "return invoice": must reference the original invoice's
  ID, **UUID** and total; a **return reason is mandatory**; returns are allowed **on quantities
  only**, cannot exceed the original quantity, partial returns allowed until exhausted.
  [OFFICIAL-MIRROR Form2.vb] — Daftra confirms the return flow inputs are exactly **original
  invoice number + return reason (سبب الإرجاع) + quantity to return (الكمية المراد إرجاعها)**
  [SECONDARY: Daftra], matching our `createCreditNote` validation.
  - **Channel nuance:** Daftra performs returns on the **JoFotara portal** (login as sub-user →
    تنظيم الفاتورة → فاتورة إرجاع), not via its own API. Our engine instead submits the 381 credit
    note **through the API** — equally valid (the 381 document with `BillingReference` +
    `InstructionNote` is in the official manual/Form2.vb and shipping in Odoo). This is a vendor
    workflow choice, not a constraint; nothing to change.
- **Three invoice types — triple-confirmed** [OFFICIAL-MIRROR + Odoo + Daftra]:
  **فاتورة الدخل / income** carries no tax and the tax-rate dropdown is disabled (→ our `INCOME`
  omits all tax elements); **فاتورة الضريبة العامة / general tax** selects a rate from a dropdown
  and computes tax (→ `SALES`); **فاتورة الضريبة الخاصة / special tax** enters a special-tax rate
  and computes it (→ `SPECIAL`). Cash vs receivable (نقدي / ذمم) is chosen per invoice. Exactly our
  `taxpayerType` × `paymentKind` model.

### Identifiers & numbering

- `cbc:ID` — the merchant's own invoice number (no `/` character — replace with `_`).
- `cbc:UUID` — UUIDv4, the **primary key against duplication** ("Universal Unique Identifier …
  forming Primary Key to prevent invoice duplication"). [OFFICIAL-MIRROR]
- **ICV** (invoice counter value) — integer, "created sequentially from 1 onwards" **per
  device/income source**, carried in `AdditionalDocumentReference`. Gaps/duplicates are flagged.
  [OFFICIAL-MIRROR]
- Seller TIN: **digits only**.

### Buyer information

- Buyer ID schemes: **TN** (tax number), **NIN** (national ID), **PN** (passport).
- Buyer name is **mandatory if the invoice is receivable, or cash above 10,000 JOD**; optional
  below that, but retain for audit. [OFFICIAL-MIRROR + SECONDARY]
- **Munaxa mapping:** buyer = the fee-paying guardian (or the school's billing contact for B2B);
  NIN maps to our `Parent`/`User.nationalId`; school fee invoices are receivable → **buyer name is
  effectively always required for us.**

## 2. Authentication

- **Who joins** [OFFICIAL ✓read]: "all companies, establishments and institutions obligated with
  organizing invoices" — whether they have **no** invoicing system, a **traditional** one, or a
  **computerised/electronic** one. (Confirms the §1 universal mandate — a private school is in
  scope regardless of its current billing setup.)
- **Join workflow** [OFFICIAL ✓read] (`official/procedure_manual_for_joining.pdf`): on the ISTD
  website → click **National Invoicing System** → **New User** → enter the company's **tax number,
  username and password** → open the **National Invoicing** tab → enter the on-screen code → the
  system shows the **Tax ID** → set the username/password (re-enter to confirm) → **Create an
  account**. This provisions the *portal account*; device linking (which mints the Client-Id /
  Secret-Key) is a separate step in the **Linking** manual (§ below).
- **Portal password policy** [OFFICIAL ✓read]: exactly **8 characters**, must contain **numbers and
  letters**, at least two letters, and **at least one uppercase**. (This governs the human portal
  login, not the API — Munaxa never stores it; it is only relevant to the school's onboarding
  runbook.)
- **Device registration** (verbatim from the linking manual): *"Click on 'Linking Electronic
  Devices', then click on 'Link a New Device'"* → enter a username, select the **income source
  sequence** (تسلسل مصدر الدخل — the taxpayer's registered activity number) → *"The system will
  automatically create the 'Client ID' and the 'Secret Key'"*. [OFFICIAL-MIRROR]
  - Corroborated step-by-step by Daftra's published linking guide [SECONDARY: Daftra]: login →
    **ربط الأجهزة** (Link Devices) → **ربط جديد** (New Link) → enter username + select **رقم تسلسل
    مصدر الدخل** (income source sequence) → **إضافة** (Add) → copy the **رقم المستخدم** (user number
    = Client-Id), **كلمة السر** (password = Secret-Key) and income-source-sequence; "the username
    and password are assembled into a **(Header)**" for the API. Invoices are sent "matching the
    **UBL 2.1** standard in **XML**, **Encoded**". Every term matches our model 1:1.
- **Portal account roles** [SECONDARY: Daftra] — operationally useful for the school's onboarding
  runbook (these live on the JoFotara portal, not in Munaxa):
  - **admin / المستخدم الرئيسي:** sets a logo/brand **per income source sequence**, sees all
    invoices across all income sources (portal, mobile app, or API-linked), exports to Excel, links
    devices, and creates **sub-users** bound to an income source sequence.
  - **sub-user / المستخدم الفرعي:** sees/searches/prints only its own invoices; can set custom
    fields per invoice type.
- **Credentials** = (`Client-Id`, `Secret-Key`, income source sequence). Sent as **static HTTP
  headers** on every call: `Client-Id`, `Secret-Key`, `Content-Type: application/json`.
  [OFFICIAL-MIRROR; identical in Odoo; terminology confirmed by Daftra]
- **No token lifecycle** — no OAuth, no refresh. HTTP **403 = bad/blocked credentials**.
- **Storage requirement:** Secret-Key is a credential secret → encrypt at rest, restrict to
  finance-admin permission, never log it, never return it to the client after save (Odoo restricts
  both fields to system admins). **Munaxa:** AES-256-GCM at rest with a master key from the
  secrets manager; the API returns only a masked hint (last 4 chars).

## 3. Invoice XML structure (UBL 2.1)

- **UBL 2.1 `Invoice` root for everything** — credit notes also use `Invoice` (not `CreditNote`).
  `cbc:ProfileID = "reporting:1.0"`. [OFFICIAL-MIRROR + Odoo]
- `cbc:IssueDate` format `yyyy-MM-dd`. `cbc:Note` optional.
- **InvoiceTypeCode**: element text **388** (invoice) / **381** (return). The `name` attribute is a
  3-digit composite `scope + payment + taxpayer`:
  - scope: local=0, export=1, development-zone=2
  - payment: cash=1, receivable=2
  - taxpayer: income=1, general-sales=2, special=3

  Official codes: **011/021** (income cash/receivable), **012/022** (sales), **013/023** (special).
  [OFFICIAL-MIRROR + Odoo]
- **Currency**: `DocumentCurrencyCode`/`TaxCurrencyCode` = **JOD**; `currencyID="JOD"` on every
  amount. (Manual transcription shows `"JO"` in one sample; all production integrations submit
  `JOD` — flagged as an open item.)
- **ICV**: `cac:AdditionalDocumentReference` → `cbc:ID = "ICV"`, `cbc:UUID = <integer counter>`.
- **Seller** `cac:AccountingSupplierParty`: `cbc:CompanyID` = TIN (digits only),
  `cbc:RegistrationName` = registered legal name, country `JO`.
- **Income source sequence**: `cac:SellerSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID`.
- **Buyer** `cac:AccountingCustomerParty`: `cbc:ID` with `schemeID ∈ {TN, NIN, PN}`,
  `cbc:RegistrationName`, optional `PostalZone`, `CountrySubentityCode` (governorate, e.g.
  `JO-AM`), `Telephone`.
- **Lines** `cac:InvoiceLine`: sequential `cbc:ID`; `cbc:InvoicedQuantity unitCode="PCE"`;
  `cbc:LineExtensionAmount` = (unit price × qty) − line discount; `cac:Item/cbc:Name`;
  `cac:Price/cbc:PriceAmount` (pre-tax unit price); per-line `cac:AllowanceCharge`
  (`ChargeIndicator=false`, reason `DISCOUNT`); per-line `cac:TaxTotal` with `cbc:TaxAmount` and
  `cbc:RoundingAmount` (= line total incl. tax).
- **Tax categories** (`schemeID="UN/ECE 5305"`, `schemeAgencyID="6"`; TaxScheme `VAT` for
  percentage taxes, `OTH` for special fixed taxes):
  - **Z = exempt (0%)** · **O = zero-rated (0%)** · **S = standard** (1–5, 7, 8, 10, 16%).
  - ⚠️ **This is the reverse of PEPPOL/ZATCA semantics** (where Z=zero-rated, E=exempt). A generic
    UBL mapper will mis-tag taxes. [OFFICIAL-MIRROR + Odoo agree]
- **Totals** `cac:LegalMonetaryTotal`: `TaxExclusiveAmount` (gross lines before discount),
  `TaxInclusiveAmount`, `AllowanceTotalAmount` (sum of line discounts), `PayableAmount`
  (= tax-inclusive); `PrepaidAmount` only on credit notes.
- **Rounding**: JOD has 3 decimals; emit **≥3 dp** (Odoo emits 3–9 dp and computes at 9-dp
  precision so line sums equal totals exactly).
- **Income taxpayers omit all tax elements** entirely.
- **Credit notes (381)** add: `cac:BillingReference/cac:InvoiceDocumentReference` (`cbc:ID`,
  `cbc:UUID`, `cbc:DocumentDescription` = original total) + `cac:PaymentMeans` with
  `cbc:PaymentMeansCode="10"` (`listID="UN/ECE 4461"`) and **mandatory `cbc:InstructionNote`** =
  return reason.

### School-specific field mappings (Munaxa)

| JoFotara field | Munaxa source |
| --- | --- |
| Seller name / TIN | Tenant e-invoicing settings (wizard step 2) |
| Income source sequence | Settings (wizard step 3) |
| Buyer name / NIN | Guardian (`Parent`/`User`) full name + `nationalId` |
| Invoice `cbc:ID` | Munaxa invoice number (per-tenant sequence) |
| ICV | Per-tenant monotonic counter (DB-backed, race-safe) |
| Line item name | `Charge.description` / `FeePlan.name` (e.g. Tuition, Transport, Uniform, Books, Activity) |
| Amounts | `Decimal(12,3)` JOD — matches natively |
| Tax category | Per fee category from tax configuration (wizard step 5) |

## 4. Submission API

- **Endpoint**: `POST https://backend.jofotara.gov.jo/core/invoices/` [OFFICIAL-MIRROR + all
  implementations]
- **Request**: `{ "invoice": "<Base64 of UTF-8 UBL XML>" }` + the three headers. Manual verbatim:
  "After preparing the invoice in the (XML) format, the file is encrypted on the (Base64) system
  and included in a JSON file…" [OFFICIAL-MIRROR]
- **Response** (legacy/manual shape):

  ```json
  {
    "EINV_RESULTS": { "status": "PASS|ERROR", "INFO": [], "WARNINGS": [],
                      "ERRORS": [{ "EINV_CODE", "EINV_CATEGORY", "EINV_MESSAGE" }] },
    "EINV_STATUS": "SUBMITTED | ALREADY_SUBMITTED",
    "EINV_QR": "<QR string>",
    "EINV_NUM": "<invoice number>",
    "EINV_INV_UUID": "<uuid>",
    "EINV_SINGED_INVOICE": "<base64 signed invoice>"
  }
  ```

  (the API's own typo "SINGED" is real). A newer camelCase shape also exists (`invoiceStatus`,
  `qrCode`, `validationResults.status`). **Success = validation PASS AND status ∈ {SUBMITTED,
  ALREADY_SUBMITTED}** — parse both shapes defensively. [SECONDARY: PHP/C#/Java SDKs]
- **HTTP codes**: 200 = processed (still check PASS); 400 = validation errors (parse `ERRORS`);
  403 = auth failure. Timeouts are common — Odoo uses a 50 s timeout; production clients retry ×3.
- **Idempotency**: re-submitting the same UUID returns `ALREADY_SUBMITTED` → treat as success.
  This makes retries safe.
- **No published rate limits.**

## 5. QR code

- The QR string is **returned by the API** (`EINV_QR`) — it is *not* computed locally. We render it
  as a QR image. Manual verbatim: "If the process is successful, the file contains a QR Code that
  **must be shown on the seller's invoice**." [OFFICIAL-MIRROR]
- Validation: scannable with the government **Sanad** app ("More → Validate document"). [SECONDARY]

## 6. Sandbox vs production

- **No official public sandbox.** The PHP SDK states testing requires a registered entity. One
  community repo references `https://sandbox.jofotara.gov.jo/core/invoices/` — **unverified**, not
  corroborated; confirm with ISTD before relying on it.
- Practical pattern (what Odoo does): a **simulation/demo mode** in the integration that fakes a
  PASS response locally — our framework implements exactly this (`SIMULATION` environment), plus a
  configurable endpoint URL so a real sandbox can be plugged in if ISTD provides one.
- **Production activation** = join portal → link device → receive Client-Id/Secret-Key → submit.

## 7. Security, audit & retention

- Retain invoices **4 years** (Regulation No. 34 of 2019; from end of tax period / return filing /
  assessment). Store e-invoices and validation logs in a tamper-evident archive accessible to ISTD
  on audit; paper copies not required once electronically validated. [SECONDARY]
- Persist per invoice: the submitted XML, `EINV_SINGED_INVOICE`, `EINV_QR`, UUID, ICV, full
  validation results, and an immutable submission log.
- Secrets: encrypt at rest, permission-gated, masked in reads, excluded from logs.

## 8. Risks & known pitfalls

| # | Pitfall | Mitigation in Munaxa |
| --- | --- | --- |
| 1 | **Z/O inversion** vs generic UBL | Hardcode JoFotara mapping in the adapter; unit-test it |
| 2 | Negative quantities/prices rejected | Credit notes are positive-value 381 docs; validation rejects negatives |
| 3 | Document-level discounts rejected | Distribute discounts per line; engine only models line discounts |
| 4 | Rounding mismatches (line sums ≠ totals) | Compute at high precision, emit ≥3 dp, golden-file tests |
| 5 | TIN with non-digits / `/` in invoice ID | Input validation + sanitisation before build |
| 6 | Missing buyer on receivable invoices | School invoices are receivable → buyer always required; validated pre-submit |
| 7 | Credit note without original UUID/total/reason | Engine requires original document reference + reason |
| 8 | ICV gaps/duplicates | DB-backed monotonic counter allocated in the same transaction as the document |
| 9 | Arabic corruption | UTF-8 encode **before** base64; tests include Arabic names |
| 10 | Timeouts / transient failures | Queue with exponential backoff ×N, then dead-letter; UUID idempotency makes retry safe |
| 11 | Duplicate submission | `ALREADY_SUBMITTED` treated as success |
| 12 | Income-type taxpayers sending 0% VAT | Taxpayer type drives complete omission of tax elements |
| 13 | Credentials leakage | AES-256-GCM at rest, masked reads, no logging, RBAC-gated |

## 9. Go/no-go conclusion

All technical requirements are implementable with high confidence. The two open items
(currencyID sample text; official error-code table) do not block implementation — we follow the
behaviour of production integrations (JOD; defensive error parsing) and will reconcile against the
official PDFs when downloaded. **Proceed to implementation.**
