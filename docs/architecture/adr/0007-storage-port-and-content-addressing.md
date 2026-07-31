# ADR-0007 — One storage port; blobs are content-addressed and deduplicated

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

The product must run as SaaS on S3, Azure Blob or Cloudflare R2, and on-premise on local disk or
MinIO — with the provider chosen per deployment and changeable later. Storage is also the largest
cost line: revisions repeat content constantly (a revision that changes one page, a document
re-uploaded unchanged, the same standard attached to fifty documents).

## Decision

1. Every storage operation goes through a single **`StoragePort`** whose vocabulary is the domain's
   (`createUploadTarget`, `createDownloadUrl`, `head`, `copy`, `delete`, `setStorageClass`). No
   provider type appears above the adapter.
2. Blobs are **content-addressed**: `storage_key = <tenantId>/<sha256 prefix fan-out>/<sha256>`.
3. Identical content within a tenant is stored **once** (`uq (tenant_id, checksum_sha256)`) and
   reference-counted.
4. **Dedupe never crosses tenants**, even for identical content.
5. Blobs are **immutable**: changed content is different content and gets a different key.
6. **Bytes never pass through the API** — presigned, direct-to-storage in both directions.

## Alternatives considered

1. **Path-based keys (`/tenant/library/folder/file.pdf`)** — human-readable, but renaming a folder
   would have to move objects, and dedupe becomes impossible. Rejected.
2. **Global cross-tenant dedupe** — the largest storage saving, but one tenant's costs and even the
   existence of their content would be inferable from another's. Rejected on isolation grounds.
3. **Storing files in PostgreSQL (bytea / large objects)** — destroys backup and replication
   economics at 200 TB. Rejected.
4. **Streaming uploads through the API** — simpler permission story, but couples file size to
   application capacity and makes a 2 GB upload an application-tier problem. Rejected; the
   permission check happens at presign time instead.

## Consequences

- Adding a provider is one adapter class plus one configuration value; no use case changes.
- Reverting to an earlier revision's content costs no storage.
- Reference counting must be transactional, with a reconciliation sweeper that **reports** drift
  rather than silently fixing it.
- Provider migration is copy-through: `storage_driver` is recorded per blob, so both providers are
  readable during the move.
- Presigned URLs are a security surface: short TTL, single object, method- and size-bound, and
  every issuance is audited ([17](../17-security-architecture.md)).
