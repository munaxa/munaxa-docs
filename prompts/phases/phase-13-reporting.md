# Phase 13 — Reporting

Read-model reporting across the existing domains — **attendance, academic, financial, behavior** —
exposed as JSON for on-screen viewing and as **CSV / Excel / PDF** downloads, plus an Admin Portal
page. No new persistence: every query runs under tenant RLS over existing tables.

## 1. Deliverables

| Area | Where |
|------|-------|
| Backend | `apps/api/src/reporting/{,export}` (controller, service, repository, ExportService) |
| Admin Portal | `apps/admin/src/app/reports/page.tsx`, `apps/admin/src/lib/reporting.ts` (+ dashboard nav) |
| e2e | `apps/api/test/reporting.e2e-spec.ts` (8 cases) |

New deps: **exceljs** (xlsx), **pdfkit** (pdf) + `@types/pdfkit`. Permissions reuse the existing
`report:read` (view) and `report:export` (download); no schema or seed change.

## 2. Endpoints

For each domain `kind ∈ {attendance, academic, financial, behavior}`:

- `GET /reports/{kind}` — `report:read` — returns a `ReportTable` (`{title, subtitle, columns,
  rows, generatedAt}`).
- `GET /reports/{kind}/export?format=csv|xlsx|pdf` — `report:export` — streams the file with a
  `Content-Disposition: attachment` (via `StreamableFile`). Unknown format → 400.

Optional query filters: `sectionId`, `from`, `to` (YYYY-MM-DD), and `semesterId` (academic).

## 3. Aggregations (`ReportingRepository` + `ReportingService`)

All built from `groupBy`/`aggregate` over existing tables, scoped to the tenant's active students
(optionally one section):

- **Attendance** — per student: present / absent / late / excused counts + attendance rate
  `(present + late) / total`.
- **Academic** — per student: assessment count + average percent (`score / maxScore`).
- **Financial** — per student: charged (active charges) − paid (verified transactions) =
  outstanding, in JOD (`Decimal`, 3 dp).
- **Behavior** — per student: positive / negative / neutral counts + net points.

The same `ReportTable` feeds both the JSON response and the export, so the on-screen table and the
downloaded file are always identical.

## 4. Export (`ExportService`)

A generic `ReportTable → { buffer, contentType, filename }` renderer:

- **CSV** — built dependency-free (RFC-4180 quoting, CRLF).
- **Excel** — `exceljs`, bold header row, one sheet.
- **PDF** — `pdfkit`, landscape A4, title + filter subtitle + a simple fixed-width table with page
  breaks.

Both `exceljs` and `pdfkit` are **lazily imported** inside their methods (matching `StorageService`)
so they only load when an export is requested.

## 5. Admin Portal

`/reports` (linked from the dashboard nav): a domain switcher, optional section/date filters, a
"Run report" button that renders the table, and CSV/XLSX/PDF download buttons. The download path
fetches with the bearer token and triggers a browser save honouring the server `filename`.

## 6. Tests (8 e2e)

The four report computations (attendance rate, academic average, outstanding balance, net behavior
points); CSV export (content-type + disposition + header row); **Excel + PDF magic bytes** (`PK`,
`%PDF`); unknown-format 400; and RBAC (`report:read` lets a Teacher view but **not** export;
Secretary cannot view). Full suite: **74 e2e across 12 suites**, 42 unit.

## 7. Notes / follow-ups

- Reports currently summarize per student; richer breakdowns (per-subject academic, per-month
  trends) and charts can layer on the same `ReportTable` contract later.
- Large tenants may warrant pagination/streaming of export rows; current queries cap naturally at
  the active-student set per (optional) section.
