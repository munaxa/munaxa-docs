# HR Phase 2 — Contracts, Documents & Personal Records

Adds the employment **contract** lifecycle (with renewal history), a versioned S3-backed **document**
store with expiry tracking, and the employee **personal sub-records** — emergency contacts,
dependents, education, certificates and bank accounts — all employee-scoped, tenant-isolated,
audited and permission-gated.

## 1. Deliverables

| Area | Where |
|------|-------|
| DB migration + RLS | `prisma/migrations/20260723130000_hr_contracts_documents/` |
| Prisma models | `EmploymentContract`, `EmployeeDocument`, `EmergencyContact`, `Dependent`, `EmployeeEducation`, `Certificate`, `EmployeeBankAccount`; enums `ContractType`, `ContractStatus`, `EmployeeDocumentType`, `DependentRelation` |
| Backend | `apps/api/src/people/employee-records/**` (contract, document, personal-records) |
| Storage | Reuses `common/storage.service.ts` (presigned S3 upload/download, tenant-key guard) |
| RBAC | `hr:contract:read/manage`, `hr:document:read/manage` in `@munaxa/domain` |
| Admin Portal | `people/employees/[employeeId]/tabs/**` (Contracts, Documents, Family, Qualifications, Bank tabs) + `lib/people.ts` |
| Tests | `apps/api/test/hr-records.e2e-spec.ts` (7 cases) |

## 2. Data model

- **`EmploymentContract`** — type, status (`DRAFT → ACTIVE → EXPIRED/TERMINATED/RENEWED`), dates,
  base salary + currency, `allowances` (JSON), benefits, working hours, vacation days. `renewedFromId`
  chains renewals so revision history is preserved; `signedDocumentId` links the signed PDF.
- **`EmployeeDocument`** — S3 `fileKey`, type, `version` + `supersedesId` (versioning chain),
  `issueDate`/`expiryDate` (expiry indexed for Phase-10 reminders). Files are uploaded direct-to-bucket
  via presigned URLs; keys are tenant-namespaced and validated on confirm.
- **Personal records** — `EmergencyContact`, `Dependent`, `EmployeeEducation`, `Certificate`,
  `EmployeeBankAccount` (bank details sensitive). All FK-cascade from `Employee`.

Every table enforces `tenant_isolation` RLS and is indexed on `tenantId` (+ `employeeId`, expiry).

## 3. Resources & permissions

| Resource | Path (`/api/v1/employees/:employeeId/…`) | Permission |
|----------|------------------------------------------|------------|
| Contracts (CRUD + renew) | `contracts`, `contracts/:id`, `contracts/:id/renew` | `hr:contract:read` / `hr:contract:manage` |
| Documents (presign/confirm/download/delete) | `documents`, `documents/presign`, `documents/:id/download` | `hr:document:read` / `hr:document:manage` |
| Emergency contacts / dependents / education / certificates | `emergency-contacts`, `dependents`, `education`, `certificates` | `employee:read` / `employee:manage` |
| Bank accounts | `bank-accounts` | read `hr:sensitive:read`, write `employee:manage` |

New permissions default to the **HR** role (all) and read-only to **Principal** / **VicePrincipal**
(contracts & documents read). Every mutation writes an `AuditLog` entry.

## 4. Admin Portal

New tabs on the employee profile workspace, each permission-gated:
- **Contracts** — list with status, add/edit, renew (marks the prior contract `RENEWED`), delete.
- **Documents** — presigned upload (with type + expiry), versioning, download, delete.
- **Family** — emergency contacts + dependents. **Qualifications** — education + certificates.
- **Bank** — bank accounts (only shown to holders of `hr:sensitive:read`).

The five personal sub-records share one generic `CrudList` component (single UI source of truth).

## 5. Validation

`prisma validate` ✓ · migration applies with **zero drift** ✓ · API + Admin typecheck ✓ · ESLint ✓ ·
**369** unit tests ✓ · **245** e2e tests ✓ (incl. 7 new HR-records cases) · production build ✓ · formatting ✓.
