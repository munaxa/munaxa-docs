# 05 — Database Design

**Purpose:** the physical design — tables, keys, indexes, constraints, tenancy, soft delete, audit.
**Audience:** backend engineers. Read before any schema or query work.

**No migrations are generated in Phase 0.** This document is the target; Phase 0.5 turns it into
`edms/prisma/schema.prisma` and the first migration.

## 1. Conventions

| Rule | Value |
| --- | --- |
| Engine | PostgreSQL 16 |
| Primary keys | UUID v7 (`id`) — time-ordered, so index locality is preserved without exposing a sequence |
| Tenancy | Every business table carries `tenant_id uuid NOT NULL` |
| Timestamps | `created_at`, `updated_at` (`timestamptz`, UTC) |
| Actorship | `created_by`, `updated_by` (`user_id`), `deleted_by` where soft-deletable |
| Soft delete | `deleted_at timestamptz NULL` — `NULL` means live |
| Concurrency | `version int NOT NULL DEFAULT 0`, optimistic locking on every aggregate root |
| Naming | `snake_case` tables and columns, singular table names, `fk_`/`ix_`/`uq_`/`ck_` prefixes |
| Money/none | No floats anywhere; sizes are `bigint` bytes |
| Enums | Native PostgreSQL enums for closed sets owned by the code; lookup tables for tenant-configurable sets |

**Every unique constraint on soft-deletable data is partial**, so a deleted row never blocks a new
one:

```sql
CREATE UNIQUE INDEX uq_folder_name_live
  ON folder (tenant_id, parent_id, lower(name)) WHERE deleted_at IS NULL;
```

## 2. Tenancy and row-level security

Four application layers plus a database backstop
([ADR-0002](./adr/0002-multi-tenant-isolation-model.md)):

| Layer | Mechanism |
| --- | --- |
| Token | `tenant_id` is a signed claim, never client-supplied |
| Context | Request-scoped `AsyncLocalStorage`, not threaded by hand |
| Guard | Rejects any request body or query naming a different tenant |
| Data | Prisma client extension injects `where: { tenantId }` and stamps writes |
| Database | RLS policies on every tenant-scoped table, keyed on `current_setting('app.tenant_id')`, set per transaction |

The application connects as a restricted role **without** `BYPASSRLS`. Migrations run as a separate
owner role. A logic bug therefore cannot return another tenant's rows.

## 3. Core tables

### Organisation and identity

| Table | Key columns | Notes |
| --- | --- | --- |
| `tenant` | `id`, `slug`, `status`, `settings jsonb` | The only table without `tenant_id` |
| `company` | `tenant_id`, `code`, `name` | `uq (tenant_id, lower(code)) WHERE deleted_at IS NULL` |
| `entity` | `company_id`, `code`, `name`, `legal_name` | |
| `branch` | `entity_id`, `code`, `name`, `address` | Code appears in document numbers |
| `department` | `entity_id`, `branch_id NULL`, `parent_id NULL`, `code`, `name`, `path ltree` | `path` materialises the ancestry for one-query ACL walks |
| `app_user` | `tenant_id`, `email`, `status`, `password_hash NULL`, `external_subject NULL`, `mfa_*` | `uq (tenant_id, lower(email)) WHERE deleted_at IS NULL` |
| `role` | `tenant_id`, `key`, `name`, `is_system` | System roles seeded, not editable |
| `role_permission` | `role_id`, `permission_key` | `permission_key` validated against `@edms/domain` at write time |
| `user_role` | `user_id`, `role_id`, `scope_type NULL`, `scope_id NULL` | A role may be granted globally or on one scope node |
| `user_department` | `user_id`, `department_id`, `is_primary` | Drives routing and numbering defaults |
| `delegation` | `delegator_id`, `delegate_id`, `scope_*`, `starts_at`, `ends_at`, `permissions[]` | `ck (ends_at > starts_at)` |

### Configuration

| Table | Notes |
| --- | --- |
| `document_type` | `code`, `name`, `numbering_rule_id`, `workflow_definition_id NULL`, `retention_policy_id NULL`, `default_confidentiality_id`, `revision_label_style` |
| `category` | Hierarchical, `path ltree`, `uq (tenant_id, parent_id, lower(name)) WHERE deleted_at IS NULL` |
| `metadata_field` | `key`, `data_type`, `options jsonb`, `is_searchable`, `validation jsonb` |
| `type_metadata_field` | Join: `document_type_id`, `metadata_field_id`, `is_required`, `sort_order`, `default_value` |
| `numbering_rule` | `segments jsonb` (ordered segment descriptors), `reset_scope`, `padding`, `separator` ([09](./09-numbering-architecture.md)) |
| `retention_policy` | `trigger`, `period_months`, `disposition`, `review_required` |
| `confidentiality_level` | `rank smallint`, `allow_download`, `allow_print`, `watermark`, `require_reason` — `uq (tenant_id, rank)` |
| `tenant_setting` | Typed key/value with a per-key schema |

### Content

```sql
CREATE TABLE document (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL,
  folder_id               uuid NOT NULL REFERENCES folder(id),
  document_type_id        uuid NOT NULL REFERENCES document_type(id),
  category_id             uuid NULL REFERENCES category(id),
  confidentiality_id      uuid NOT NULL REFERENCES confidentiality_level(id),
  title                   text NOT NULL,
  description             text NULL,
  status                  document_status NOT NULL DEFAULT 'DRAFT',
  document_number         text NULL,                 -- assigned at approval, then immutable
  numbered_at             timestamptz NULL,
  owner_user_id           uuid NOT NULL REFERENCES app_user(id),
  owning_department_id    uuid NULL REFERENCES department(id),
  current_revision_id     uuid NULL,                 -- the published revision
  latest_revision_id      uuid NULL,                 -- including drafts
  retention_policy_id     uuid NULL,                 -- frozen copy of the type's policy
  effective_from          date NULL,
  effective_to            date NULL,
  archived_at             timestamptz NULL,
  version                 int NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NOT NULL,
  updated_at              timestamptz NOT NULL,
  updated_by              uuid NOT NULL,
  deleted_at              timestamptz NULL,
  deleted_by              uuid NULL,
  CONSTRAINT ck_document_numbered_when_published
    CHECK (status <> 'PUBLISHED' OR document_number IS NOT NULL)
);

CREATE UNIQUE INDEX uq_document_number ON document (tenant_id, document_number)
  WHERE document_number IS NOT NULL;                 -- no partial on deleted_at: numbers are never reused
CREATE INDEX ix_document_folder     ON document (tenant_id, folder_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_document_status     ON document (tenant_id, status)    WHERE deleted_at IS NULL;
CREATE INDEX ix_document_owner      ON document (tenant_id, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_document_type_cat   ON document (tenant_id, document_type_id, category_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_document_updated    ON document (tenant_id, updated_at DESC) WHERE deleted_at IS NULL;
```

> `uq_document_number` deliberately ignores `deleted_at`. A deleted document keeps its number
> forever so the number can never be re-issued ([09](./09-numbering-architecture.md)).

| Table | Key columns | Notes |
| --- | --- | --- |
| `library` | `owner_scope_type`, `owner_scope_id`, `code`, `root_folder_id` | `ck` exactly one owner scope |
| `folder` | `library_id`, `parent_id NULL`, `name`, `path ltree`, `inherit_acl bool` | `path` gives ancestors in one query |
| `document_revision` | `document_id`, `ordinal int`, `label`, `file_object_id`, `status`, `workflow_instance_id NULL`, `author_id`, `published_at NULL`, `change_summary` | `uq (document_id, ordinal)` |
| `document_metadata_value` | `document_id`, `metadata_field_id`, `value_text/num/date/bool/json` | `uq (document_id, metadata_field_id)` |
| `document_tag` | `document_id`, `tag` | `uq (document_id, lower(tag))`; `ix (tenant_id, lower(tag))` |
| `document_link` | `from_document_id`, `to_document_id`, `link_type` | `ck (from <> to)`; `uq (from, to, link_type)` |
| `document_lock` | `document_id`, `user_id`, `acquired_at`, `expires_at`, `revision_id` | `uq (document_id) WHERE released_at IS NULL` |
| `file_object` | `checksum_sha256`, `size_bytes`, `mime_type`, `storage_key`, `storage_driver`, `scan_status`, `scan_verdict`, `ref_count` | `uq (tenant_id, checksum_sha256)` → dedupe |
| `upload_session` | `intent`, `target_key`, `expires_at`, `completed_at` | Expired sessions are swept |
| `preview_artifact` | `revision_id`, `kind`, `page`, `file_object_id`, `renderer`, `renderer_version` | Disposable; rebuildable |
| `ocr_result` | `revision_id`, `text`, `language`, `confidence`, `engine`, `engine_version` | Feeds the search index |

### Control

| Table | Key columns | Notes |
| --- | --- | --- |
| `acl_entry` | `scope_type`, `scope_id`, `subject_type` (`USER`/`ROLE`/`DEPARTMENT`), `subject_id`, `permission_key`, `effect` (`ALLOW`/`DENY`) | `uq (scope_type, scope_id, subject_type, subject_id, permission_key)` |
| `workflow_definition` / `workflow_version` / `workflow_stage_def` | Versioned; a published version is immutable | |
| `workflow_instance` | `document_id`, `revision_id`, `workflow_version_id`, `status`, `current_stage_index`, `started_at`, `completed_at` | |
| `workflow_stage` | `instance_id`, `index`, `completion_rule`, `quorum`, `due_at`, `status` | |
| `approval_task` | `stage_id`, `assignee_id`, `on_behalf_of_id NULL`, `decision`, `comment`, `decided_at`, `due_at`, `reminder_sent_at`, `escalated_from_task_id NULL` | `ix (tenant_id, assignee_id, decision) WHERE decision IS NULL` — the approval inbox |
| `number_sequence` | `numbering_rule_id`, `scope_key text`, `next_value bigint` | `uq (tenant_id, numbering_rule_id, scope_key)` |
| `number_reservation` | `sequence_id`, `value bigint`, `formatted text`, `document_id NULL`, `state`, `reserved_at`, `expires_at` | `uq (tenant_id, formatted)` |
| `retention_schedule` | `document_id`, `policy_id`, `trigger_at`, `due_at`, `disposition`, `state` | `ix (tenant_id, due_at) WHERE state = 'PENDING'` |
| `legal_hold` | `document_id`, `reason`, `placed_by`, `placed_at`, `released_at NULL`, `released_by NULL` | Any live hold blocks disposition |

### Cross-cutting

| Table | Notes |
| --- | --- |
| `audit_event` | Append-only, hash-chained ([13](./13-audit-architecture.md)); no `UPDATE`/`DELETE` grant to the app role; monthly partitions |
| `outbox_message` | `aggregate_type`, `aggregate_id`, `event_type`, `payload jsonb`, `available_at`, `processed_at`, `attempts` — `ix (processed_at, available_at)` |
| `idempotency_key` | `(tenant_id, key)` unique, stored response, TTL |
| `search_index_entry` | `document_id`, `tsv tsvector`, `metadata jsonb`, `acl_hash`, GIN on `tsv` |
| `notification_message` | `recipient_id`, `channel`, `template_key`, `payload`, `state`, `attempts`, `read_at` |
| `saved_search`, `report_definition` | Owner-scoped, shareable by ACL |

## 4. Soft delete strategy

| Level | Behaviour |
| --- | --- |
| User "delete" | Sets `deleted_at`/`deleted_by`. The row stays. Audited as `DOCUMENT_DELETED` |
| Reads | Every query filters `deleted_at IS NULL` by default, in the Prisma extension |
| Recycle bin | A permission-gated view of `deleted_at IS NOT NULL` within the retention window |
| Restore | Clears `deleted_at`, revalidates uniqueness (name collisions are resolved by rename, never by overwrite), audited |
| Cascade | Deleting a folder soft-deletes its subtree; each affected row records the originating `cascade_id` so restore is exact |
| Purge | Only the retention worker, only when no legal hold exists, only after the policy's period. Purge removes rows and decrements `file_object.ref_count`; blobs with `ref_count = 0` are deleted from storage |
| Audit | **Never soft-deleted, never purged with the document.** Audit outlives its subject |

## 5. Revision strategy

- A revision is inserted, never updated once `PUBLISHED`.
- `document.current_revision_id` points at the published revision; `latest_revision_id` includes
  drafts. Both are maintained inside the same transaction that changes revision state.
- Restoring an old revision creates a **new** revision whose content is that of the old one, with
  `restored_from_revision_id` recorded. History is never rewritten.
- Detail: [10](./10-revision-architecture.md).

## 6. Concurrency

| Contention | Control |
| --- | --- |
| Two edits to one document | Optimistic `version` column; second writer gets `409` |
| Two users editing content | Check-out lock (`document_lock`), exclusive, expiring |
| Two documents drawing a number | `SELECT … FOR UPDATE` on the `number_sequence` row, held for microseconds |
| Two approvals of one task | `UPDATE … WHERE decision IS NULL` — zero rows means already decided |
| Worker double-delivery | Idempotency key per job |

## 7. Partitioning and growth

| Table | Strategy | Trigger |
| --- | --- | --- |
| `audit_event` | Range partition by month | From day one |
| `notification_message` | Range partition by month, drop after retention | From day one |
| `outbox_message` | Delete processed rows after 7 days | From day one |
| `document_revision` | Single table; revisit at 50M rows | Monitored |
| `search_index_entry` | Single table with GIN; migrate to an external engine behind the port when p95 degrades | [ADR-0008](./adr/0008-postgres-first-search.md) |

## 8. Normalisation review

The design is 3NF with two deliberate, documented denormalisations:

1. **`department.path` / `folder.path` / `category.path` (`ltree`)** — derived ancestry, maintained
   by the application on move. Without it, ACL resolution is a recursive CTE on every request.
2. **`search_index_entry`** — a read model duplicating title, number, metadata and OCR text. It is
   rebuildable from source at any time and is never authoritative.

Everything else — metadata values, tags, ACLs, approvals, numbers — is fully normalised.
`jsonb` appears only where the shape is genuinely tenant-defined (`numbering_rule.segments`,
`metadata_field.validation`, `tenant.settings`, event payloads), never as a way to avoid modelling.
