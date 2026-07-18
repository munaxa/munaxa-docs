# 04 — Database ERD (Core)

> This is the **conceptual** ERD for the platform. The concrete Prisma schema for the core
> entities is built in **Phase 2**; later phases add their own contexts. Every business entity
> includes `tenantId`, `createdAt`, `updatedAt`, and soft-delete `deletedAt` where applicable.

## 1. Core / foundation ERD (Phase 2 target)

```mermaid
erDiagram
    TENANT ||--o{ SCHOOL : has
    SCHOOL ||--o{ CAMPUS : has
    CAMPUS ||--o{ ACADEMIC_YEAR : runs
    ACADEMIC_YEAR ||--o{ SEMESTER : contains
    CAMPUS ||--o{ GRADE : offers
    GRADE ||--o{ SECTION : split_into
    SECTION ||--o| CLASSROOM : assigned
    CAMPUS ||--o{ CLASSROOM : has

    TENANT ||--o{ USER : owns
    USER ||--o{ USER_ROLE : has
    ROLE ||--o{ USER_ROLE : granted
    ROLE ||--o{ ROLE_PERMISSION : has
    PERMISSION ||--o{ ROLE_PERMISSION : in
    TENANT ||--o{ AUDIT_LOG : records

    TENANT {
        uuid id PK
        string name
        string slug
        enum status
        timestamp createdAt
    }
    SCHOOL {
        uuid id PK
        uuid tenantId FK
        string name_en
        string name_ar
        string moeSchoolCode
    }
    CAMPUS {
        uuid id PK
        uuid tenantId FK
        uuid schoolId FK
        string name_en
        string name_ar
        string address
    }
    ACADEMIC_YEAR {
        uuid id PK
        uuid tenantId FK
        uuid campusId FK
        date startDate
        date endDate
        boolean isCurrent
    }
    SEMESTER {
        uuid id PK
        uuid tenantId FK
        uuid academicYearId FK
        string name
        date startDate
        date endDate
    }
    GRADE {
        uuid id PK
        uuid tenantId FK
        uuid campusId FK
        string name_en
        string name_ar
        int level
    }
    SECTION {
        uuid id PK
        uuid tenantId FK
        uuid gradeId FK
        string name
        uuid classroomId FK
    }
    CLASSROOM {
        uuid id PK
        uuid tenantId FK
        uuid campusId FK
        string name
        int capacity
    }
    USER {
        uuid id PK
        uuid tenantId FK
        string firebaseUid
        string email
        string phone
        string nationalId
        enum status
        boolean mustChangePassword
    }
    ROLE {
        uuid id PK
        uuid tenantId FK
        enum key
        boolean isSystem
    }
    PERMISSION {
        uuid id PK
        string key
        string description
    }
    USER_ROLE {
        uuid userId FK
        uuid roleId FK
        uuid tenantId FK
    }
    ROLE_PERMISSION {
        uuid roleId FK
        uuid permissionId FK
    }
    AUDIT_LOG {
        uuid id PK
        uuid tenantId FK
        uuid actorUserId FK
        string action
        string entityType
        string entityId
        jsonb before
        jsonb after
        string ip
        timestamp createdAt
    }
```

## 2. People & operations (forward-looking, later phases)

```mermaid
erDiagram
    USER ||--o| STUDENT : profile
    USER ||--o| PARENT : profile
    USER ||--o| TEACHER : profile
    USER ||--o| EMPLOYEE : profile
    PARENT ||--o{ PARENT_STUDENT : links
    STUDENT ||--o{ PARENT_STUDENT : links
    SECTION ||--o{ STUDENT : enrolls
    STUDENT {
        uuid id PK
        uuid tenantId FK
        uuid userId FK
        string moeStudentNumber
        string nationalId
        uuid sectionId FK
        string qrCode
    }
    PARENT { uuid id PK  uuid tenantId FK  uuid userId FK }
    TEACHER { uuid id PK  uuid tenantId FK  uuid userId FK }
    EMPLOYEE { uuid id PK  uuid tenantId FK  uuid userId FK  enum jobRole }
    PARENT_STUDENT {
        uuid parentId FK
        uuid studentId FK
        enum relation
        boolean isPrimary
    }
```

> Attendance, Timetable, Academics, Finance, Communication ERDs are defined in their phases and
> appended to this folder as `04a-…`, `04b-…` etc. to keep Phase 2 focused on the core.

## 3. Indexing strategy

- **Composite tenant indexes**: every frequent query gets a leading `tenantId`, e.g.
  `(tenantId, sectionId)`, `(tenantId, status)`, `(tenantId, createdAt)`.
- **Uniqueness scoped to tenant**: e.g. `@@unique([tenantId, moeStudentNumber])`,
  `@@unique([tenantId, email])` — identifiers are unique *within* a tenant, not globally.
- **National ID**: `@@unique([tenantId, nationalId])` where present; validated for Jordanian format.
- **Audit**: index `(tenantId, entityType, entityId)` and `(tenantId, createdAt)` for queries.
- **Hot paths** (attendance by day/section, current charges) get targeted partial/covering indexes.

## 4. Migration strategy

- **Prisma Migrate** as the single migration tool; migrations are committed and reviewed.
- **Expand → migrate → contract** pattern for zero-downtime changes (add nullable → backfill →
  enforce → drop old).
- Migrations run in CI against an ephemeral DB and in a **staging** environment before production.
- **No destructive migration** reaches production without an explicit, reviewed backfill/rollback note.
- RLS policies are managed as versioned SQL migrations alongside Prisma.

## 5. Data types & conventions

- Primary keys: **UUID v4** (avoid sequential ID enumeration leaks).
- Money: `Decimal` (never float) with currency = JOD; amounts stored in minor units where summed.
- Timestamps: `timestamptz`, UTC in DB; localized at presentation.
- Localized text fields: `_en` / `_ar` pairs (or a JSONB `{en, ar}` where many).
- Soft deletes via `deletedAt` for recoverable business records; hard delete only on purge.
