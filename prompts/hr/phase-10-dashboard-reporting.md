# HR Phase 10 — HR Dashboard, Alerts, Reporting & Automation

The capstone phase ties the HR platform together with a single read surface: an aggregate
**HR dashboard**, an actionable **alerts feed**, a **headcount roster export**, and the
**automation / AI-ready** data surface.

## 1. Deliverables

| Area | Where |
|------|-------|
| Backend | `apps/api/src/people/hr-dashboard/**` (read-only aggregations; no new tables) |
| RBAC | `hr:dashboard:read` in `@munaxa/domain` |
| Admin Portal | **People → HR dashboard** page, `lib/people.ts` |
| Tests | `apps/api/test/hr-dashboard.e2e-spec.ts` (4 cases) |

## 2. Surfaces

### Dashboard — `GET /hr/dashboard`
A single aggregate payload: total headcount, headcount **by status** and **by department** (top 10),
pending leave approvals, open postings + active applicants, asset totals (total/assigned/available),
active performance cycles + reviews awaiting acknowledgement, and expiring-item counts (documents,
contracts, certificates, training, probation) within a 60-day window.

### Alerts — `GET /hr/dashboard/alerts?within=`
The actionable feed: every expiring/overdue item (employee documents, employment contracts, staff
certificates, training certifications, and probation periods ending) within the look-ahead window,
each with `dueDate`, `daysRemaining` and a `severity` (`overdue` / `due_soon`).

**Automation source of truth.** The alerts query is deliberately the single place expiry logic
lives, so a future scheduled job dispatches reminders by consuming the *same* query — no duplicated
expiry rules.

**AI-ready.** The dashboard and alerts payloads are clean, normalised, tenant-scoped and
permission-gated JSON — the structured data surface an assistant/agent would summarise or act on,
without scraping individual modules.

### Roster export — `GET /hr/dashboard/roster/export?format=csv|xlsx|pdf`
The employee headcount roster rendered through the shared `ExportService` (the same renderer used by
Reporting and payroll-prep) — no second exporter.

## 3. Permissions

| Resource | Path (`/api/v1`) | Permission |
|----------|------------------|------------|
| Dashboard | `GET hr/dashboard` | `hr:dashboard:read` |
| Alerts | `GET hr/dashboard/alerts` | `hr:dashboard:read` |
| Roster export | `GET hr/dashboard/roster/export` | `hr:dashboard:read` |

Defaults: **HR**, **Principal**, **VicePrincipal**.

## 4. Admin Portal

**People → HR dashboard** — KPI stat tiles, headcount-by-status and by-department breakdowns, the
alerts list (severity-coloured), and CSV/Excel roster download.

## 5. Validation

`prisma validate` ✓ · zero schema drift ✓ · API + Admin typecheck ✓ · ESLint ✓ · **380** unit tests
✓ · e2e ✓ (incl. 4 new dashboard/alerts cases) · production builds ✓ · formatting ✓.
