# Object storage for a Hetzner deployment: options and what is still unverified

- **Status:** evaluation only. **No bucket was created, no provider API was called, and no provider
  was chosen.** Decision D-3 of ADR-0026 stays open. This note addresses R-2 of
  [the readiness report](./hetzner-test-deployment-readiness.md).
- **Date:** 2026-10-15.
- **Rule:** every provider property is labelled with where it comes from:
  - **Verified (here)** means a test in this repository ran against it.
  - **Documented** means the provider's own page says so (link given; read on this date).
  - **Third-party** means only a third-party source says so.
  - **Unknown** means nothing found.

  Documentation is a claim, not evidence: the gate P-1 tests decide.

## 1. What the product requires of the store

From the code and ADR-0026 §6 (not from any provider):

| # | Requirement | Why | Where enforced |
| --- | --- | --- | --- |
| S1 | S3 API with presigned PUT and GET, multipart upload | Browser uploads go straight to the store | `s3.adapter.ts` |
| S2 | **Presigned PUT bound to `x-amz-checksum-sha256`; tampered bytes refused** | Upload integrity; otherwise every upload is refused | `storage.service.ts` ("could not confirm the file's digest") |
| S3 | **HEAD returns the SHA-256 with `x-amz-checksum-mode: ENABLED`** | The same | same |
| S4 | CORS limited to the web origin (`PUT`/`GET`, `content-type`, `x-amz-checksum-sha256`) | Browser upload | bucket configuration |
| S5 | **Recovery from overwrite and delete** (object versioning or an equivalent) | `backup-and-restore.md` §1: "versioning + cross-region replication"; the integrity sweep can *detect* an altered blob, only a prior version can *restore* it | bucket configuration + procedure |
| S6 | A copy at a second provider | ADR-0026 §9 item 2 | `scripts/storage-backup.mjs` (exists; never run against a real provider) |
| S7 | **EU data residency**, contractually | ADR-0026 G-1 | provider contract + region |
| S8 | Credentials scoped to one bucket | Least privilege | provider IAM |
| S9 | Streaming reads for verified downloads (`openRead`) | ADR-0026 §10 | `s3.adapter.ts` |

## 2. Candidates

| Property | Hetzner Object Storage | Cloudflare R2 (EU jurisdiction) | Scaleway Object Storage | Self-hosted MinIO on a second server |
| --- | --- | --- | --- | --- |
| S1 S3 API, presigned URLs | **Documented** ([product page](https://www.hetzner.com/storage/object-storage/)); multipart **Unknown** | **Verified (here)** for presigned PUT/HEAD in ENAM (CI run 38535100979); multipart **not tested** | Documented ([concepts](https://www.scaleway.com/en/docs/object-storage/concepts.md)) | Verified (here), test stack only |
| S2 / S3 checksum contract | **Unknown** — nothing found in Hetzner's documentation | **Verified (here)**, ENAM bucket | **Unknown** | **Verified (here)** |
| S4 CORS | Unknown | Verified (here) | Documented | Verified (here) |
| S5 Versioning | **Documented** — versioning, Object Lock (legal hold, retention; must be enabled at bucket creation), expiry ([product page](https://www.hetzner.com/storage/object-storage/), [Object Lock how-to](https://docs.hetzner.com/de/storage/object-storage/howto-protect-objects/protect-object-lock-legal-hold)) | **Not available** per ADR-0026 §6 and a third-party summary of [R2's compatibility table](https://developers.cloudflare.com/r2/api/s3/api/) (versioning and Object Lock listed as unimplemented) — **re-check the live table**; an alternative would have to be designed (§3) | **Documented** — versioning and Object Lock ([versioning](https://www.scaleway.com/en/docs/object-storage/how-to/use-bucket-versioning/), [Object Lock](https://www.scaleway.com/en/docs/object-storage/how-to/use-object-lock.md)) | Versioning supported by MinIO; not tested here |
| S6 Second provider | Needs another provider | Needs another provider | Needs another provider | It *is* the second copy only if on another provider's hardware |
| S7 EU residency | Locations FSN1, NBG1 (DE), HEL1 (FI) **documented**; "GDPR-compliant" claim on the product page; **no contractual review recorded** | **Documented** EU jurisdiction restriction with its own endpoint ([data location](https://developers.cloudflare.com/r2/reference/data-location/index.md)); **the only bucket tested was ENAM, so nothing here is EU evidence** | Regions fr-par, nl-ams, pl-waw, it-mil **documented**; no contractual review recorded | Wherever the server is |
| Same provider as the server | **Yes** — a Hetzner account problem affects both | No | No | Depends |
| Price (estimate, §5) | Third-party / press: base about €5–6.50/month incl. 1 TB storage + 1 TB egress — **conflicting figures; confirm in the console** | Not estimated here | Not estimated here | One more server |

## 3. Recovery options for S5, by provider

1. **Native versioning plus Object Lock (Hetzner, Scaleway — documented).**
   - Enable both at bucket creation; Object Lock cannot be added later on Hetzner (documented).
   - Add a lifecycle rule expiring non-current versions after the retention window (for example
     35 days, matching the database PITR window).
   - A restore copies a prior version back. **To verify:**
     - versioning interacts correctly with the checksum contract (does a restored copy keep its
       SHA-256?);
     - a presigned PUT over an existing key creates a version rather than replacing it.
2. **No versioning (R2): write-once keys plus a second copy.**
   - Blob keys are already content-addressed (`blobs/<id>`), and the product never overwrites a
     blob in place; it writes a new object for new bytes.
   - What remains exposed is deletion or overwrite **by someone holding the store credentials**,
     which is exactly the case the integrity sweep detects and cannot repair.
   - The alternative is a scheduled `storage-backup.mjs` to a second provider with its own
     credentials, run more often than nightly, plus bucket credentials that cannot delete. Neither
     is designed in detail or tested. **This is why ADR-0026 does not approve R2 for production.**
3. **Either way**, a second-provider copy (S6) is required by ADR-0026 §9.
   `scripts/storage-backup.mjs` produces and verifies a SHA-256 manifest. It has run only in local
   tests.

## 4. What must be validated in a hosted TEST environment (none done)

For the provider chosen, with a disposable bucket and the owner's authorization:

1. Gate P-1 in full:
   - the checksum contract (S2, S3);
   - tampered bytes refused;
   - CORS;
   - multipart;
   - browser upload and verified download (Phase C);
   - for Hetzner, the whole of it, since nothing has been run.
2. Versioning:
   - overwrite and delete an object;
   - restore the prior version;
   - confirm the restored object passes the HEAD digest check and a verified download;
   - confirm Object Lock refuses a delete.
3. Lifecycle expiry of non-current versions.
4. `storage-backup.mjs` backup → verify → restore against the second provider.
5. Scoped credentials: the application key cannot read or write another bucket.
6. EU residency: the bucket's location as reported by the provider, plus a contract or DPA review
   by the owner.
7. Latency and throughput from the server's location (verified downloads read whole objects).

## 5. Recommendation (not a decision)

Test **Hetzner Object Storage first**, because it is the only candidate whose own documentation
claims both versioning and Object Lock in German and Finnish locations.

- **Caveat:** it shares a provider and account with the server, so S6 (a copy elsewhere) is not
  optional.
- If its checksum contract fails P-1, test **Scaleway** next.
- R2 stays a fallback, only with the §3.2 design written and tested.
