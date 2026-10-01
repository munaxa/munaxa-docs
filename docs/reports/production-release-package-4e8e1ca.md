# Production Release Package — release `4e8e1ca`

**Date:** 2026-10-01. This package records the **published production release**: the commit its
images were built from, the publishing run, the three immutable image digests and how each was
verified. **It is not a production-readiness declaration.** The images are published and verified;
nothing has been deployed to production, and the production infrastructure prerequisites are
still **NOT READY**
([production-prerequisites-checklist.md](../operations/production-prerequisites-checklist.md)).

## 1. Release identity

| Item | Value |
| --- | --- |
| **Release commit** | **`4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b`** (`4e8e1ca`), on `main` |
| Application code | **Identical to the approved application release `27a8daa`**. `git diff 27a8daa 4e8e1ca` changes nothing under `apps/`, `packages/`, `prisma/`, `infra/sql/` or the root `Dockerfile`: the same 30 migrations, the same API and web build. The approval, fixes (WEB-1, NUM-1) and application validation are recorded in [production-release-package-27a8daa.md](./production-release-package-27a8daa.md) and still apply |
| What `4e8e1ca` adds over `27a8daa` | The non-root antivirus image (#118): `infra/antivirus/Dockerfile`, `entrypoint.sh`, `verify-container.sh`, and a verification step in `.github/workflows/publish-images.yml`. Plus documentation |
| Release tag | `image/4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` → `4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` |
| Publishing run | **`36819091004`**, "Publish images" — https://github.com/munaxa/munaxa-docs/actions/runs/36819091004 — **success**, every job |
| Accepted launch limitations | WF-1 and KEY-1, unchanged ([go-live-runbook.md §1a](../operations/go-live-runbook.md)) |

## 2. Published images

Deploy **by digest only**. These three references are the release.

| Image | Immutable reference | Revision label |
| --- | --- | --- |
| API | `ghcr.io/munaxa/munaxa-docs-api@sha256:6c1a6b31fa3502ddfe6df2fdc9d6c723edc7def711bd90f5d8525f2247872f10` | `4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` |
| Web | `ghcr.io/munaxa/munaxa-docs-web@sha256:815a4aa28cf75c58bd4cd4cb4031db26ef60acaa9ba7649f7b6c0a710341d4eb` | `4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` |
| Antivirus | `ghcr.io/munaxa/munaxa-docs-antivirus@sha256:9920e03462439db55b40f6929e8fb60f11f72ddcc104d0320d171b28b8d194dc` | `4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` |

Each image is also tagged `4e8e1ca` and `sha-4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` for humans.
**No `latest` tag exists.** A deployment manifest names `image@sha256:<digest>` and nothing else.

## 3. Verification of the published digests

| Check | Result |
| --- | --- |
| Source | The run built exactly `4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` from a clean checkout |
| Revision label | `org.opencontainers.image.revision=4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` on all three, checked on each pulled digest by the run and read again from GHCR's image configuration |
| API | Runs as `node`. No credential in image history or filesystem. Carries the Prisma query engine for its runtime OpenSSL (`debian-openssl-3.0.x`) |
| Web | Runs as `node`. No credential in image history or filesystem. Serves every branding asset its login page references, and `/branding/docs/favicon/favicon-32.png`, as `200 image/png` |
| **Antivirus: non-root** | Image `USER` **101:102** (`clamav`). Every process — PID 1 `c-icap`, `clamd`, the second `c-icap` — runs as UID/GID 101; **no UID 0 process** |
| Antivirus: function | ClamAV **1.5.4**, c-icap **0.5.10**. `probe.mjs`: **clean file passed (204), EICAR blocked (`Eicar-Test-Signature`)** — on the candidate, after an unclean restart, and on the pulled digest. `freshclam` updates the signatures as `clamav`. No credential in the image history, filesystem or environment (`verify-container.sh`) |
| Antivirus: identity | The pushed digest is the image the run probed (image ID compared after a pull from the registry), with the same recorded ClamAV and c-icap versions |
| **Production pull identity** | The run's "Pull with the production identity" job logged in with `DOCS_PRODUCTION_PULL_USER` / `DOCS_PRODUCTION_PULL_TOKEN` and **pulled all three digests** |
| Independent re-check | The antivirus digest was pulled again with the production pull identity and run on a fresh volume: probe passed, `verify-container.sh` passed, and it scanned again after a kill and restart |

## 4. Superseded images — do not deploy

| Release line | Status |
| --- | --- |
| `8cb4c14454e2e0e3b4508ef4e6eba76d3e1b0051` (tag `image/8cb4c14…`, run `36722457128`) | **Superseded. Not deployable.** Its antivirus image, `ghcr.io/munaxa/munaxa-docs-antivirus@sha256:02298beca666d7db346de82e42cab2f692faa4ed417fa7259e3b1ff3999e33d4`, is the **old root-starting scanner** (no `USER`; `c-icap` ran as UID 0) and **must not be used in production**. Its API and web images carry the same application code as this release but a different revision; deploy this release's digests instead |
| `27a8daa`, `c87519e`, `f5d5bb2`, `416ca94`, `a560bb0` | Historical; never published as production images. See the runbook's release lineage |

## 5. What is still required before production

The release artifacts are **published and verified**. Production is **NO-GO** until every
prerequisite in [production-prerequisites-checklist.md](../operations/production-prerequisites-checklist.md)
is READY with production evidence: DNS/TLS, monitoring and alert routing, SMTP, the private scanner
network and its signature-update schedule, object storage, backup/PITR/failover, the load baseline,
and the secret store and versioned configuration. This is the first production deployment: there is
**no rollback target**, and that must be recorded in the change record (runbook §20).
