# Phase 4 — School Structure Management

CRUD for the school hierarchy — **School → Campus → AcademicYear → Semester**, and
**Campus → Grade → Section**, plus **Classroom** — all tenant-scoped and permission-guarded.
The data models were created in Phase 2; this phase adds the backend modules, Admin UI, and tests.

## 1. Deliverables

| Area | Where |
|------|-------|
| Backend modules (7 entities) | `apps/api/src/structure/**` |
| Shared tenant repository | `apps/api/src/common/tenant.repository.ts`, `tenant.util.ts` |
| Admin Portal | `apps/admin/src/app/structure/schools`, `src/lib/structure.ts` |
| Tests | `apps/api/test/structure.e2e-spec.ts` (full chain + RBAC + isolation) |

## 2. Resources & permissions

| Resource | Path (`/api/v1`) | Parent | Permission |
|----------|------------------|--------|------------|
| School | `/schools` | tenant | `school:manage` |
| Campus | `/campuses?schoolId=` | School | `campus:manage` |
| AcademicYear | `/academic-years?campusId=` | Campus | `academicyear:manage` |
| Semester | `/semesters?academicYearId=` | AcademicYear | `academicyear:manage` |
| Grade | `/grades?campusId=` | Campus | `grade:manage` |
| Classroom | `/classrooms?campusId=` | Campus | `classroom:manage` |
| Section | `/sections?gradeId=` | Grade (+ optional Classroom) | `section:manage` |

Each resource supports `POST` (create), `GET` (list, filterable by parent), `GET /:id`,
`PATCH /:id`, `DELETE /:id`. Schools and Campuses use **soft delete** (`deletedAt`); the others
hard-delete (they cascade from their parents).

## 3. Architecture

Each entity follows the Clean Architecture module layout:

```
structure/<entity>/
├── <entity>.dto.ts         # class-validator DTOs + Swagger (Create + Update via PartialType)
├── <entity>.repository.ts  # extends TenantRepository — all access via withTenant(RLS)
├── <entity>.service.ts     # use cases: validation, parent-existence checks, NotFound
└── <entity>.controller.ts  # HTTP + @RequirePermissions
```

- **`TenantRepository`** base wraps every operation in `withTenant(prisma, requireTenantId(), …)`,
  so PostgreSQL RLS physically scopes the query to the active tenant (resolved from the
  request-scoped `TenantContext` bound by the auth interceptor). Writes auto-stamp `tenantId`.
- **Parent validation** is tenant-safe: e.g. creating a Campus verifies the `schoolId` exists
  *within the caller's tenant* (the check itself runs under the tenant RLS scope), so cross-tenant
  parent references fail with `400`.

## 4. Verified behavior (e2e, real PostgreSQL)
- ✅ Full create chain: school → campus → academic year → semester; grade → classroom → section.
- ✅ Invalid/cross-tenant parent reference → `400`.
- ✅ RBAC: a Student (lacking `school:manage`) creating a school → `403`.
- ✅ Unauthenticated request → `401`.
- ✅ **Tenant isolation**: tenant B never sees tenant A's schools.

## 5. Admin Portal
`/structure/schools` lists/creates/deletes schools and, for a selected school, its campuses
(bilingual EN/AR inputs). Uses the auth client's refresh-on-401 fetch.

## 6. Notes
- Reads currently require the same `*:manage` permission as writes (the Phase 2 permission catalog
  has no dedicated structure `:read` scope). Read-only roles for structure can be added when the
  catalog is extended.
- Tenant provisioning (creating a tenant + seeding system roles via `RbacService` + an initial
  admin) is exercised in tests; a platform provisioning API is part of Phase 14/platform work.

## How to run
```bash
pnpm docker:up && pnpm --filter @munaxa/api prisma:deploy && pnpm --filter @munaxa/api db:seed
pnpm --filter @munaxa/api test:e2e   # includes structure.e2e-spec.ts
```

## Next: Phase 5 — People Management
Students, Parents, Teachers, Employees, Secretary accounts; bulk CSV import; QR ID generation;
parent-student linking; teacher assignment.
