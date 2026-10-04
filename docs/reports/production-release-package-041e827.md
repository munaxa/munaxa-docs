# Production Release Package — release `041e827`

**Date:** 2026-10-04. This package records the **published release selected for the hosted
Production environment**: the commit its images were built from, the publishing run, the three
immutable image digests and how each was verified. **It is not a production-readiness
declaration.** The images are published and verified. Nothing has been deployed to Production,
and the production prerequisites are still **NOT READY**
([production-prerequisites-checklist.md](../operations/production-prerequisites-checklist.md)).

## 1. Release identity

| Item | Value |
| --- | --- |
| **Release commit** | **`041e8278d2808926d5aaad4c890f41ec2a648424`** (`041e827`), on `main` |
| What `041e827` adds over `4e8e1ca` | ECS task-role S3 credentials (`041e827`: `STORAGE_CREDENTIALS_SOURCE=ECS_TASK_ROLE`, refusal of static S3 keys beside it) and the database pool-size fix (`bda59e8`: `DATABASE_POOL_SIZE` now reaches each tenant client as `connection_limit`). Everything else is documentation (ADR-0021, ADR-0022) |
| Application changes after `041e827` | **None.** Every later commit on `main` (`0141544`, `d86d226`, `56a49fe`, `f5c3147`) changes documentation only |
| CI on the exact commit | Run 571 (push to `main`) and run 570 (pull request): **success**. `bda59e8`: runs 566 and 568, success |
| Release tag | `image/041e8278d2808926d5aaad4c890f41ec2a648424` → `041e8278d2808926d5aaad4c890f41ec2a648424` |
| Publishing run | **`36948766244`**, "Publish images" — https://github.com/munaxa/munaxa-docs/actions/runs/36948766244 — **success**, every job |
| Accepted launch limitations | WF-1, KEY-1 and D-1, unchanged ([go-live-runbook.md §1a](../operations/go-live-runbook.md)) |

## 2. Published images

Deploy **by digest only**. These three references are the release.

| Image | Immutable reference | Revision label |
| --- | --- | --- |
| API | `ghcr.io/munaxa/munaxa-docs-api@sha256:085352e0f06f4da7400df23006b0ff1e870ebedc444edf84e3368772a0ba23ca` | `041e8278d2808926d5aaad4c890f41ec2a648424` |
| Web | `ghcr.io/munaxa/munaxa-docs-web@sha256:4b4fac5125f7802c14208bee2ca6e2ce5e047f704165135c09b801967bd6b659` | `041e8278d2808926d5aaad4c890f41ec2a648424` |
| Antivirus | `ghcr.io/munaxa/munaxa-docs-antivirus@sha256:90f81d9806e9a330acab88134f4af9d48d5dd537902f0bce7c57d0c51bc43faf` | `041e8278d2808926d5aaad4c890f41ec2a648424` |

Each image is also tagged `041e827` and `sha-041e8278d2808926d5aaad4c890f41ec2a648424` for humans.
**No `latest` tag exists.** The same three references are in
[`infra/terraform/eu-prod/service/release.auto.tfvars.example`](../../infra/terraform/eu-prod/service/release.auto.tfvars.example),
whose variables accept digests only.

## 3. Verification of the published digests

All rows below are steps of run `36948766244`, read from its job logs, unless stated otherwise.

| Check | Result |
| --- | --- |
| Source | The run built exactly `041e8278d2808926d5aaad4c890f41ec2a648424` from a clean checkout |
| Revision label | `org.opencontainers.image.revision` verified on each pulled digest |
| API | Not root. No credential in image history or filesystem. Carries the Prisma query engine for its runtime OpenSSL |
| Web | Not root. No credential in image history or filesystem. Serves every branding asset its login page references |
| Antivirus: versions | ClamAV **1.5.4**, c-icap **0.5.10** (`clamav-daemon=1.5.4+dfsg-0ubuntu0.24.04.1`, `clamav-freshclam=1.5.4+dfsg-0ubuntu0.24.04.1`, `c-icap=1:0.5.10-6.1build2`, `libc-icap-mod-virus-scan=1:0.5.5-2build4.2`) |
| Antivirus: non-root | Image `USER` **101:102**; every process (c-icap, clamd) runs as UID 101; **no process runs as root**; `freshclam` updates as `clamav`; no credential in history, filesystem or environment (`verify-container.sh`) |
| Antivirus: function | `probe.mjs`: **clean passed (204), EICAR blocked (`Eicar-Test-Signature`)** — on the candidate, after an unclean restart, and on the pulled digest |
| Antivirus: identity | The pushed digest is the image the run probed (image ID compared after a pull from the registry) |
| **Production pull identity** | "Pull with the production identity" logged in with `DOCS_PRODUCTION_PULL_USER` / `DOCS_PRODUCTION_PULL_TOKEN` and **pulled all three digests** |
| **On AWS Fargate** (Non-Production, outside this run) | The API digest ran on Fargate in `eu-central-1`: task-role S3 credentials signed put, head, get, a presigned download and delete with no long-lived key; static S3 keys beside `ECS_TASK_ROLE` were **refused** at startup ([ADR-0024](../architecture/adr/0024-minimum-cost-first-customer-launch.md), "Evidence") |

The antivirus digest differs from `4e8e1ca`'s: the image installs unpinned Ubuntu packages and was
rebuilt. Its ClamAV and c-icap versions are the same, and it passed every check above.

## 4. Relationship to earlier releases

| Release | Status |
| --- | --- |
| `4e8e1ca` ([package](./production-release-package-4e8e1ca.md)) | **Superseded for the hosted deployment.** It predates ECS task-role S3 credentials and the pool-size fix, so it cannot run the ADR-0024 architecture. Its record stays valid as history |
| `8cb4c14` | Superseded, **not deployable** (root-starting scanner) |
| `27a8daa`, `c87519e`, `f5d5bb2`, `416ca94`, `a560bb0` | Historical; never published as production images |

## 5. Not yet proven on this release

These are part of the production prerequisites and the go-live runbook, not of publishing:

- the full API starting in production mode on AWS;
- `CREATE DATABASE`, the per-database SQL and the migrations on RDS;
- the staging smoke and browser checks re-run on these exact digests;
- image signing (no signing policy exists).

This is the first production deployment: there is **no rollback target**, and that must be
recorded in the change record (runbook §20).
