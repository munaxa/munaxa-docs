# HR Phase 7 — Asset Management

Adds a register of **discrete, custody-tracked assets** (laptops, phones, keys, uniforms,
vehicles…) and an **assign → return** lifecycle per employee. Every asset is an individual unit with
its own status, condition and full custody history.

## 1. Deliverables

| Area | Where |
|------|-------|
| DB migration + RLS | `prisma/migrations/20260723180000_hr_asset_management/` |
| Prisma models | `Asset`, `AssetAssignment`; enums `AssetCategory`, `AssetStatus`, `AssetCondition` |
| Backend | `apps/api/src/people/assets/**` |
| RBAC | `asset:read/manage` in `@munaxa/domain` |
| Admin Portal | employee **Assets** tab, **People → Assets** register page, `lib/people.ts` |
| Tests | `apps/api/test/hr-assets.e2e-spec.ts` (7 cases) |

## 2. Model & workflow

- **`Asset`** — a tracked unit: `assetTag` (unique per tenant), name, category, serial number,
  `status` (AVAILABLE → ASSIGNED → back, plus IN_REPAIR / RETIRED / LOST), `condition`, purchase
  cost/date, warranty expiry, location. `currentAssigneeId` denormalises the active holder for fast
  directory listing.
- **`AssetAssignment`** — one custody record (issued → returned). An asset has **at most one open
  (unreturned) assignment**; assigning flips the asset to ASSIGNED and stamps the holder, returning
  closes the record with the return condition and sets the post-return status (default AVAILABLE).

Assign and return each run in a single transaction that updates the assignment **and** the asset,
and every mutation is written to the shared `AuditLog`.

### Relationship to `InventoryItem`
This is deliberately **separate** from the existing `InventoryItem` module. `InventoryItem` tracks
*fungible stock* (SKU, quantity, reorder level) for store supplies; an `Asset` is an *individual,
serial-numbered unit* whose custody is tracked to a named employee. Different concepts, no shared
table or logic.

## 3. Resources & permissions

| Resource | Path (`/api/v1`) | Permission |
|----------|------------------|------------|
| Register (list, filter) | `GET hr/assets?status=&category=` | `asset:read` |
| Asset detail (+ history) | `GET hr/assets/:id` | `asset:read` |
| Create / update / delete | `hr/assets[/:id]` | `asset:manage` |
| Assign | `POST hr/assets/:id/assign` | `asset:manage` |
| Return | `POST hr/assets/:id/return` | `asset:manage` |
| Employee custody view | `GET employees/:id/assets` | `asset:read` |

Guards: an asset must be AVAILABLE to be assigned; an ASSIGNED asset cannot be deleted (return it
first); returning an unassigned asset is rejected.

Defaults: **HR** read + manage; **Principal** read.

## 4. Admin Portal

- **People → Assets** — the register: add assets, filter by status, assign to an employee, return,
  and delete.
- **Employee profile → Assets tab** — the assets currently and previously in that employee's
  custody, with inline return.

## 5. Validation

`prisma validate` ✓ · migration applies with **zero drift** ✓ · API + Admin typecheck ✓ · ESLint ✓ ·
**380** unit tests ✓ · e2e ✓ (incl. 7 new asset cases) · production builds ✓ · formatting ✓.
