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

**One database per tenant** ([ADR-0015](./adr/0015-database-per-tenant.md)), with the row-level layers
retained inside each one:

| Layer | Mechanism |
| --- | --- |
| Token | `tenant_id` is a signed claim, never client-supplied |
| Context | Request-scoped `AsyncLocalStorage`, not threaded by hand |
| Guard | Rejects any request body or query naming a different tenant |
| Connection | The tenant's placement decides **which database** the transaction opens on |
| Data | The tenant predicate and stamps, applied by the repository |
| Database | RLS policies on every tenant-scoped table, keyed on `current_setting('app.tenant_id')`, set per transaction |

The application connects as a restricted role **without** `BYPASSRLS`. Migrations run as a separate
owner role. A logic bug therefore cannot return another tenant's rows — and under ADR-0015 it cannot
reach them at all, because they are not in the database the query ran against.

`tenant_id` stays on every row, and that is not vestigial. The schema is identical in both
deployments; an on-premise installation may legitimately serve two companies from one PostgreSQL, and
there the row-level layers are the whole of the separation. What changed is that they are no longer the
*only* boundary in the hosted service.

### The schema is the same in every database

Which means a partial unique index is per database rather than per cluster. Two customers may both use
the company code `HQ`, and neither is told the other took it first — the index that would have decided
between them exists once per tenant.

### Migration

`pnpm prisma:deploy` visits every tenant in the catalogue: the per-database SQL, then
`prisma migrate deploy`, then the post-migration SQL, sequentially and fail-fast. `infra/sql/` is split
by **scope** for the same reason — `cluster/` for roles, which are cluster-scoped; `database/` for
grants and `current_tenant_id()`, which are not; `post-migrate/` for anything that references a table.

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
| `number_reservation` | `numbering_rule_id`, `scope_key`, `sequence_value bigint`, `formatted text`, `state`, `origin`, `document_id NULL`, `workflow_instance_id NULL`, `reserved_at`, `assigned_at NULL`, `voided_at NULL` | `uq (tenant_id, formatted)`; partial `uq` on the live `RESERVED` row per instance and per document. No `expires_at`: every instance-ending path voids in the same transaction, so a reservation cannot outlive its approval ([09](./09-numbering-architecture.md) Phase 5 notes) |
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

## Phase 3 — the document library's tables

Eight tables, and the interesting decisions are all about what is kept *apart*.

| Table | Holds |
| --- | --- |
| `file_object` | Stored bytes: digest, size, sniffed type, key, driver, scan verdict, reference count |
| `upload_session` | One transfer in flight, and what the client *claimed* about it |
| `document` | The controlled record: where it sits, what it is, who owns it, its frozen policy |
| `document_revision` | One controlled version, binding a document to a blob |
| `document_metadata_value` | One tenant-defined field's value on one document, in a typed column |
| `document_favorite` | A document one person marked |
| `document_view` | When each person last opened each document |
| `preview_artifact` | Something rendered from a revision — a thumbnail today |

**File metadata and business metadata are separate tables** because they are facts with different
lifetimes. What a file *is* changes whenever the content does; what a document *means* survives
every replacement of it.

**A claim and a fact are separate too.** `upload_session` holds the filename, declared type and size
the client announced; `file_object` holds what the store actually reported. Keeping them apart is
what lets a mismatch be *detected* rather than overwritten.

**`document_metadata_value` has typed columns, not `jsonb`.** The tenant defines which fields exist;
the product knows what a date is. Exactly one value column is populated, decided by the field's own
`data_type` — which is why that type is immutable once a field exists.

**`document_view` is one row per (user, document), updated in place.** "Which documents did I open
lately" is a question about a screenful, and an append-only log would grow without bound to answer
it. It is deliberately not derived from the audit trail, which does record every read: audit is
evidence, and serving a convenience list from it would put a product query on the one table that
must stay cheap to write and impossible to rewrite.

### Constraints that are not `UNIQUE`

Three rules span two tables and are therefore triggers, in `infra/sql/post-migrate/03-content-gate.sql`:

- A revision may not reference a blob whose scan verdict is not `CLEAN`.
- A blob referenced by a live revision may not leave `CLEAN` — quarantine withdraws the revision first.
- A document may not name another document's revision as its current or latest one.

The last is the single worst thing a document-control system can get wrong, and `document.current_revision_id`
being unique only prevents half of it.

`ck_file_object_ref_count` refuses a negative count. A negative count means the count has already
drifted from what it counts, at which point the next retention sweep deletes a blob a document still
points at.

### The one non-partial unique index

`uq_document_number` is **not** partial on `deleted_at`. Every other unique constraint in this schema
is, so that a deleted row never blocks a new one — but a document number stays reserved forever
precisely so it can never be re-issued ([ADR-0004](./adr/0004-numbering-assigned-at-approval.md)).
`uq_revision_ordinal` is non-partial for the same kind of reason: a history with a gap and a history
with two revision 2s are both unusable as evidence.

## Phase 5 — the numbering table

One table, one column and two enums were added; nothing existing changed shape.

`number_reservation` records what became of every value a sequence has ever given out —
`RESERVED`, `ASSIGNED`, `VOIDED`, `HELD` — with the rendered text stored at drawing time, never
recomputed. `uq (tenant_id, formatted)` is the second half of the never-reused guarantee beside
`uq_document_number`, and like the sequence, a reservation is never soft-deleted. Partial unique
indexes keep at most one live `RESERVED` row per approval and per document; check constraints pair
each state with exactly the facts that make it that state.

`document.numbered_at` records the assignment instant beside the number, and
`ck_document_numbered` ties the two together both ways. `ck_document_numbered_when_published` — the
§3 sketch above — was added now, while `PUBLISHED` is not yet reachable, so the rule stands before
Phase 6 builds the transition that must obey it.
