# Phase 14 — Advanced Modules

A **feature-flag framework** that gates four optional modules — **Bus Tracking, Library,
Inventory, School Clinic** — each **disabled by default** per tenant. A tenant opts in by enabling
the module's flag via the existing `/feature-flags` admin endpoint (Phase 10); until then the whole
module returns **403**, even for a SchoolAdmin holding every permission.

## 1. Deliverables

| Area | Where |
|------|-------|
| DB models + RLS | `prisma/migrations/20260606120000_advanced_modules/` (10 tables) |
| Feature-flag framework | `apps/api/src/feature-flags/` (`FeatureGate`, `FeatureFlagGuard`, `@RequireFeature`, global module) |
| Backend | `apps/api/src/advanced/{bus,library,inventory,clinic}` |
| Admin Portal | `apps/admin/src/app/modules/page.tsx`, `apps/admin/src/lib/advanced.ts` (+ dashboard nav) |
| Flutter | `apps/mobile/lib/data/advanced`, `lib/features/advanced` |
| e2e | `apps/api/test/advanced.e2e-spec.ts` (6 cases) |

New permissions (catalog + role map, re-seeded → 56 total): `bus:*`, `library:*`, `inventory:*`,
`clinic:*` (manage/read). Secretary gets the manage side; Principal gets read; SchoolAdmin `*`.

## 2. Feature-flag framework

- **`@RequireFeature(key)`** (`require-feature.decorator.ts`) tags a controller with a flag key.
  The four keys live in `FeatureFlagKey` (`bus_tracking`, `library_management`,
  `inventory_management`, `school_clinic`).
- **`FeatureFlagGuard`** is a controller-scoped guard (`@UseGuards`) that runs **after** the global
  auth guard, reads `request.user.tenantId`, and asks **`FeatureGate.isEnabled(tenantId, key)`**.
  A missing flag row = disabled, so modules are off until explicitly enabled. On a disabled module
  it throws 403.
- **`FeatureGate`** queries the existing `FeatureFlag` table with an explicit tenant id via
  `withTenant` (the guard runs before the tenant context interceptor binds, so the id is passed in).
- **`FeatureFlagsModule`** is `@Global`, exporting `FeatureGate` + `FeatureFlagGuard` so any module
  can gate itself. Flags are toggled with the Phase 10 `PUT /feature-flags/:key { enabled }`.

This reuses the Phase 10 `FeatureFlag` model — no new flag storage, and the WhatsApp bridge flag
continues to work unchanged.

## 3. Modules (all gated + RBAC'd)

- **Bus Tracking** — `BusRoute`, `Bus` (with `lastLat/lastLng/lastSeenAt`), `BusStop`,
  `StudentBusAssignment`. Endpoints: routes & stops CRUD, register buses, **push live GPS**
  (`POST /bus/vehicles/:id/location`), assign students. (`/bus/*`)
- **Library** — `LibraryBook` (total/available copies) + `BookLoan`. Checkout **atomically**
  decrements availability (409 when none left); return restores it. (`/library/*`)
- **Inventory** — `InventoryItem` + `InventoryTransaction`. A movement applies `IN` (+), `OUT` (−),
  or `ADJUST` (set) atomically and **guards against negative stock** (409). (`/inventory/*`)
- **School Clinic** — `ClinicVisit` (reason, symptoms, treatment, temperature, outcome) and a
  one-per-student `StudentMedicalRecord` (blood type, allergies, conditions, …). (`/clinic/*`)

All ten tables carry tenant RLS (migration block) and stamp `tenantId` via `TenantRepository`.

## 4. Admin Portal

`/modules` (linked from the dashboard nav): a toggle panel for the four modules (reads
`GET /feature-flags`, toggles with `PUT`), and — for each enabled module — a compact management
panel (list + create the primary entity). Disabling a module hides its panel and re-locks the API.

## 5. Flutter

`data/advanced` + `features/advanced`: an `AdvancedApi` + Riverpod providers for the
mobile-relevant reads — **bus tracking** (routes + buses with last-known location) and the
**library** catalogue. A 403 from a disabled module surfaces as "not available".

## 6. Tests (6 e2e)

The headline: **every module returns 403 by default** (even for an all-permissions admin), proving
the disabled-by-default gate. Then, after enabling each flag: bus route/vehicle/location/assignment
flow; library checkout → **409 when no copies** → return → re-checkout; inventory `OUT` →
**409 on over-draw** + running quantity; clinic visit + medical-record upsert/get; and **RBAC**
(an enabled module still 403s a Teacher who lacks the permission — distinct from the feature gate).
Totals: **80 e2e across 13 suites**, 42 unit.

## 7. Notes / follow-ups

- Live bus tracking stores only the latest fix on `Bus`; a history/telemetry table and websocket
  push can layer on later.
- Medical records are staff-only here; exposing a child's clinic history to parents would reuse the
  Phase 11 `ParentScopeService` child-scoping.
