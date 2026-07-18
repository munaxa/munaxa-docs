# Phase 11 — Parent Portal

Parent-facing self-service: the multi-child switcher + child dashboard, leave/absence requests
(with staff approval), Parent-Teacher Meeting (PTM) slot booking, and a per-child document vault.
The defining concern is **row-scoping a parent to their own linked children** — a parent may never
read or act on a student that is not linked to them via `ParentStudent` (Phase 5).

## 1. Deliverables

| Area | Where |
|------|-------|
| DB models + RLS | `prisma/migrations/20260604120000_parent_portal/` (LeaveRequest, PtmSlot, PtmBooking, Document) |
| Backend | `apps/api/src/parent-portal/{common,leave-requests,ptm,documents,dashboard}` |
| Flutter | `apps/mobile/lib/data/parent_portal`, `lib/features/parent_portal` |
| e2e | `apps/api/test/parent-portal.e2e-spec.ts` (10 cases) |

Permissions (already in the catalog/role map): `leave:request` + `leave:approve`, `ptm:book` +
`ptm:manage`, `document:manage`. Parents hold `leave:request`, `ptm:book`, `document:manage`.

## 2. Row-scoping (the core mechanic)

`ParentScopeService` (`parent-portal/common/parent-scope.service.ts`) resolves the acting user's
`Parent` profile (`Parent.userId = actorUserId`) and the linked `studentId`s. It exposes:

- `children()` — the linked children as switcher cards.
- `childIds()` / `assertChildAccess(studentId)` — reject access to non-linked students (403).
- `hasPermission(p)` — read the principal's permission set (now carried on the request-scoped
  `TenantContext.permissions`, bound by the `TenantContextInterceptor`).
- `isParent()` / `assertManageAccess(studentId)` — for routes shared by parents and staff under a
  single permission (`document:manage`): a parent is child-scoped, staff act tenant-wide.

For routes used by **both** parents and staff, a new **`@RequireAnyPermission(...)`** decorator (and
guard support) grants access when the principal holds **any one** of the listed permissions; the
service then row-scopes (parent → children; staff with the approve/manage permission → tenant-wide).

## 3. Features

- **Multi-child switcher + dashboard** — `GET /parent/children`, `GET /parent/dashboard?studentId=`.
  The dashboard aggregates per child: 30-day attendance tally, upcoming homework count, recent
  grades, outstanding balance (`Σ active charges − Σ verified transactions`), pending leave requests,
  upcoming PTM bookings, document count, and the parent's unread notification count.
- **Leave / absence requests** — `LeaveRequest` carries a `type` (`LEAVE` = planned future absence;
  `ABSENCE` = excuse for a past absence) and a status workflow `PENDING → APPROVED|REJECTED|CANCELLED`.
  Parents submit/cancel (only their own child's `PENDING` request); staff with `leave:approve` see the
  whole queue and decide (audited via `writeAudit` in the same transaction). Deciding a non-`PENDING`
  request → 400.
- **PTM booking** — staff (`ptm:manage`) open `PtmSlot`s (teacher, optional section, time window,
  `capacity`). Parents (`ptm:book`) book a slot for a child; booking is **atomic** — capacity is
  re-checked inside the transaction and the slot flips to `BOOKED` when full. Over-capacity → 409;
  double-booking the same child for a slot → 409 (unique `[slotId, studentId]`); cancelling re-opens
  the slot.
- **Document vault** — secure per-child files via the shared `StorageService` (presign → direct S3
  PUT → confirm), tenant-namespaced keys `tenants/<tenantId>/documents/<studentId>/…`. List returns
  fresh pre-signed download URLs. Parents are scoped to their children; staff (e.g. Secretary) act
  tenant-wide.

## 4. Tests (10 e2e)

Multi-child switcher; leave submit + **non-linked child 403** + parent/staff list scoping + staff
approve / parent-forbidden / non-pending 400; PTM open+book + **full-slot 409** + non-linked 403 +
**parent-cannot-open-slot RBAC 403**; document vault flow + non-linked 403; child dashboard +
non-linked 403. Full suite: **58 e2e across 10 suites**.

## 5. Notes / follow-ups

- Staff-facing approval/slot-management UI is a web (Admin Portal) concern; this phase ships the
  parent-facing Flutter layer per the phase prompt (DB / Backend / Flutter / Tests).
- Notifying parents on a leave decision can reuse the Phase 10 dispatcher later; the in-app
  notification remains the source of truth.
