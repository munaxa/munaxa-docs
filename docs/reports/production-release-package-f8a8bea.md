# Production release package — `f8a8bea` (Option A, remediated runtime)

**Status (2026-10-25): SELECTED AND PUBLISHED. NOT DEPLOYED. APPROVAL GATES OPEN.**

- **The release.** `R` = `f8a8bea62256abb80ad4e33e367ba03bd426d1d8` is tagged, and its three images
  are published to ECR and were scanned on push (§2, §3). This package selects them as the
  `eu-prod/service` inputs (`infra/terraform/eu-prod/service/release.auto.tfvars`).
- **Not done.** Nothing has been planned, applied or deployed. Fargate behaviour is not proven (§5).
- **Risk acceptance: NOT ACCEPTED** (§6).

It supersedes the `c6a6d8c` release package proposed in #153, which must not be merged. Its digests
are recorded as obsolete in §2. It also replaces the candidate record proposed in #155.

**Why a new release.** Release `c6a6d8c` was published before #154. Its API and web images are built
on `node:22-bookworm-slim` and carry util-linux and zlib, so they keep the seven HIGH findings ECR
reported. Those images cannot be relabelled as remediated. The remediation exists only in images
built from a commit that contains #154.

## 1. Release commit

| Item | Value |
| --- | --- |
| **Release commit `R`** | **`f8a8bea62256abb80ad4e33e367ba03bd426d1d8`**: `main` after #152, the squash of reviewed head `7ee0fc2` (identical tree). The owner chose it on 2026-10-25, so the release smoke on the published digests runs with #152's hardening |
| Application code | The same as `c6a6d8c`: `041e827`'s ECS architecture plus the Docs v2 web design (#137), the i18n catalogues, `@munaxa/platform` 1.7.0, the antivirus Ubuntu updates (#143), runtime images without setuid/setgid programs (#145), the SMK-1 sign-in fix (#148) and the D-10 fix (#150) |
| Alternative not chosen | `6c79358753961c8fe7947548640f069774086485`, `main` after #154 |
| CI on `R` | "CI" run [40222555678](https://github.com/munaxa/munaxa-docs/actions/runs/40222555678) (push to `main`): passed |
| Release tag | `image/f8a8bea62256abb80ad4e33e367ba03bd426d1d8`, pushed by the owner, pointing at `R` |
| Publishing run | "Publish images" [40225272398](https://github.com/munaxa/munaxa-docs/actions/runs/40225272398): success |

**What `R` contains compared with `c6a6d8c`** (`git diff c6a6d8c f8a8bea`):

- **#151.** The runtime takes Debian 12 updates at build time, and adds
  [image-vulnerability-assessment-c6a6d8c.md](./image-vulnerability-assessment-c6a6d8c.md).
- **#154.** The API and web runtime is a minimal Debian 12 tree: no shell, package manager, util-linux,
  zlib or setuid file. The checks that ran a shell inside the image are rewritten
  ([image-vulnerability-remediation-2026-10-25.md](./image-vulnerability-remediation-2026-10-25.md)).
- **#152.** ECS task definitions (not applied):
  - web, api and ops-provision run on a read-only root with all Linux capabilities dropped;
  - the scanner and both Redis sidecars drop all capabilities and keep a writable root;
  - the release smoke runs the stack the same way, so `publish-images.yml` tests the published
    digests under these settings.
- **No change** to application code, migrations, SQL, the scanner image source or the lockfile.
  Nothing under `apps/`, `packages/`, `prisma/`, `infra/sql/` or `infra/antivirus/`, and no change to
  `pnpm-lock.yaml`.

## 2. Images

| Image | Immutable reference | Revision label | Publishing run |
| --- | --- | --- | --- |
| API | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/api@sha256:e61494a2fc44b7f488e8a04226b309fb8a20b39cc2b2db1f9b9cfddfcc5abcc8` | `R`, checked by the run ("Pull by digest and verify the revision label") | [40225272398](https://github.com/munaxa/munaxa-docs/actions/runs/40225272398) |
| Web | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/web@sha256:0f32ac71d392a374c2a8367684c861d8937b57ff490e1d5d49388fcedc6e08a8` | `R`, checked by the run (same step) | [40225272398](https://github.com/munaxa/munaxa-docs/actions/runs/40225272398) |
| Antivirus | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/antivirus@sha256:fe60b49b0266196188ee0bc8b31d8e8546ac76ecf409ce4082660d0c12b4dfdb` | `R`, checked by the run ("Verify the pushed digest is the image that was probed") | [40225272398](https://github.com/munaxa/munaxa-docs/actions/runs/40225272398) |

**Publication (2026-10-25).**
- **Tag.** `image/f8a8bea62256abb80ad4e33e367ba03bd426d1d8` points at `R`. The owner pushed it and
  approved the `image-release` jobs.
- **"Publish images" run [40225272398](https://github.com/munaxa/munaxa-docs/actions/runs/40225272398): success, all six jobs:**
  - the source commit on `main`;
  - the API, web and antivirus builds and pushes;
  - "Confirm the release in ECR";
  - "Release smoke on the published digests": **18/18 passed**, and "api and web ran read-only with
    no capabilities; no write was refused".
- **Digests.** Read from ECR on 2026-10-25, by tag. In each repository, both `f8a8bea` and
  `sha-f8a8bea62256abb80ad4e33e367ba03bd426d1d8` name the one digest above.
- **Repositories.** All three are `IMMUTABLE` with scan on push.
- **Revision label.** Checked by the publishing run, not read from ECR directly.

The antivirus source is unchanged since `c6a6d8c`. It still gets a new digest, because every
published image carries the release commit in its label.

**Obsolete: not release inputs.** These digests must not be used:

| Image | `c6a6d8c` (#153, published 2026-10-24) | `db97825` (plan-only, run 39929830650) |
| --- | --- | --- |
| API | `sha256:f8af3e0a0e78601c245c03123f032d6c859aa8e3a41f35ab2100423d664e41ae` | `sha256:e8f641e608b38e9366c88e714f07a0851bd7066f64f0964f5b188bd211d78b47` |
| Web | `sha256:9e4345a11db5970fca23cd43a6045e393b96becb46a223d665ba776c20beac0e` | `sha256:0703fafa9f887d5c815d18b0752c5de6431f40f7c279988d31b0c30757e755b3` |
| Antivirus | `sha256:e7ad4aa889abd477624e35d421150b8e95825a2e67d5eb5114b7b8d03f39f4a6` | `sha256:1278da65948893cf62c799c19cf003296154f84489192af99f627b3dec827e22` |

They stay in ECR; nothing was deleted. The `c6a6d8c` API and web images carry the seven HIGH findings.

**How each image is tied to `R`.** `publish-images.yml` enforces this:

- **Before publishing:**
  - the tag must name a full commit on `main`;
  - the run builds exactly that commit from a clean checkout;
  - it pushes by digest only.
- **After publishing:**
  - it pulls each digest back from ECR and verifies `org.opencontainers.image.revision`;
  - it checks the image runs as non-root (uid from the image's own `node`);
  - it checks there is no credential in the image history or in any `.npmrc` in the image
    filesystem;
  - for the API, it checks the Prisma engine matches the runtime's OpenSSL;
  - it confirms every digest is in ECR.
- **The release smoke, in a job with no AWS credential,** runs on those exact digests. Before any
  check runs it verifies that the image IDs match the ones pulled from ECR.

## 3. ECR results

**Previous images (`c6a6d8c`), as recorded in #153; not this release:**

| Image | CRITICAL | HIGH | MEDIUM | LOW |
| --- | --- | --- | --- | --- |
| API | 0 | 7 | 2 | 2 |
| Web | 0 | 7 | 2 | 2 |
| Antivirus | 0 | 0 | 0 | 0 |

**This release (`f8a8bea`):**

| Image | Scan status | CRITICAL | HIGH | MEDIUM | LOW |
| --- | --- | --- | --- | --- | --- |
| API | COMPLETE (scan on push, 19:20:07 UTC) | 0 | 0 | 1 | 2 |
| Web | COMPLETE (scan on push, 19:21:03 UTC) | 0 | 0 | 1 | 2 |
| Antivirus | COMPLETE (scan on push, 19:19:14 UTC) | 0 | 0 | 0 | 0 |

**Findings on the API and web digests** (identical on both):

| Finding | Severity | Package |
| --- | --- | --- |
| CVE-2026-86805 | MEDIUM | glibc `2.36-9+deb12u14` |
| CVE-2026-97399 | LOW | glibc `2.36-9+deb12u14` |
| CVE-2026-95818 | LOW | glibc `2.36-9+deb12u14` |

**What this shows.** ECR was read twice on 2026-10-25, read-only, and gave the same results both
times. No scan was started; these are the scan-on-push results.
- **The seven HIGH findings are absent.** ECR reports none of the seven util-linux and zlib CVEs on
  the new API and web digests, and no CRITICAL or HIGH finding. These are the first ECR results for
  images that contain the remediation.
- **It is not an empty scan.** ECR identified glibc `2.36-9+deb12u14` from the runtime's
  `/var/lib/dpkg/status`, so it read the package list.
- **ECR and the local scanners disagree.** ECR BASIC does not report the libc6, gcc-12 and libssl3
  findings the local Trivy and Grype scans listed (§4.3). That is a difference between the scanners'
  databases, not a fix. §4.3 still describes what is installed.
- **What ECR cannot show.** A scanner reports what it finds, so ECR alone does not prove util-linux
  and zlib are absent. That comes from the runtime's contents (§5).

## 4. Vulnerability disposition

Evidence for each finding:
[image-vulnerability-remediation-2026-10-25.md](./image-vulnerability-remediation-2026-10-25.md) §2.

### 4.1 Not applicable to the versions installed in the previous images

The vulnerable code is absent from util-linux `2.38.1-5+deb12u3` or zlib `1:1.2.13.dfsg-1`:

- CVE-2026-85091;
- CVE-2026-78408;
- CVE-2026-76642;
- CVE-2026-78409, as the CVE describes it. An analogous legacy X-mount.subdir path exists.

ECR still reported them on `c6a6d8c`. Those results stand as recorded, and nothing was suppressed or
re-rated.

### 4.2 Addressed by removing the affected software

All seven, including the confirmed CVE-2026-53613 and -53615 and the partly present CVE-2026-78410:

- The API and web runtimes of `R` contain no util-linux or zlib package or file.
- The worker image still does. It is not published and not part of the eu-prod service.

| Where the removal has been shown | Result |
| --- | --- |
| The `runtime` target built from `6c79358` (§5) | Shown |
| ECR for the published digests | **Shown** (§3): none of the seven, no CRITICAL or HIGH |

### 4.3 Local scanner findings on the release runtime

These come from local scans: Trivy 0.69.3 and Grype 0.104.0, databases of 2026-10-25, the `runtime`
target built from `6c79358`.

| Finding | Package | Debian status | Also in the `c6a6d8c` images? |
| --- | --- | --- | --- |
| CVE-2026-5450 (Critical), -19499, -5435, -5928 | libc6 `2.36-9+deb12u14` | won't fix | yes |
| CVE-2026-102010, -95619 | gcc-12 runtime libraries `12.2.0-14+deb12u1` | won't fix | yes |
| CVE-2026-84782 (DTLS) | libssl3 `3.0.22-1~deb12u1` | no fix yet | yes |

**No finding on the release runtime has a Debian fix that is not applied.** ECR BASIC does not report
them on the published digests (§3). It reports three glibc findings instead, at MEDIUM and LOW.
Neither result is an acceptance; the decision is the owner's (§6).

## 5. Evidence

| Check | Result |
| --- | --- |
| CI on `R` = `f8a8bea` (push to `main`) | Run [40222555678](https://github.com/munaxa/munaxa-docs/actions/runs/40222555678): **passed** (completed 18:56 UTC), including the release smoke with api, web and provisioning read-only and no capabilities |
| `7ee0fc2` and `f8a8bea` trees | Identical (`git diff 7ee0fc2 f8a8bea` is empty). #152 was squash-merged pinned to `7ee0fc2` after its head, mergeability and 20/20 checks were re-checked |
| Redis sidecar as the task definition runs it (local) | The pinned `redis` digest with `--user 999:999 --cap-drop ALL` and the task's `sh -c` command: running, no effective capabilities, `/tmp/redis.conf` mode 600, password not in the process arguments, the task's health check passes, an unauthenticated ping gets `NOAUTH` |
| PR #154 CI on `8cebc37` (20 checks) | Passed. Release smoke 18/18 on the shell-less API and web images. Web artwork served. Prisma engine check, integration and every end-to-end shard passed |
| `8cebc37` and `6c79358` trees | Identical (`git diff 8cebc37 6c79358` is empty) |
| CI on `6c79358` (push to `main`) | Run [40218617539](https://github.com/munaxa/munaxa-docs/actions/runs/40218617539): **passed, 10 of 10 jobs.** These include the release smoke, the image builds (API, web and worker), the Prisma engine check, integration, every end-to-end shard and "Lint · Typecheck · Test · Build" with its visual-regression step |
| `runtime` built from `6c79358` (local) | 9 Debian packages, current Debian 12 versions (`libssl3 3.0.22-1~deb12u1`, `libc6 2.36-9+deb12u14`, `ca-certificates 20250419~deb12u2`). No setuid or setgid file. No shell, package manager or `mount`. No util-linux or zlib file |
| Native modules on that runtime (local) | Lockfile versions: Prisma 6.19.3, `sharp` 0.34.5, `msgpackr-extract` 3.0.4. Run with `--read-only --cap-drop ALL --security-opt no-new-privileges`, Node v22.23.4 selects the `debian-openssl-3.0.x` engine, connects to PostgreSQL 16 with `sslmode=require` and writes; `sharp` and `msgpackr-extract` load; HTTPS works; `dumb-init` forwards SIGTERM |
| Rewritten checks (local) | Setuid: fails `node:22-bookworm-slim`, passes the runtime. Engine: passes an image with the engine, fails one without. `.npmrc`: fails an image with a planted token |
| #152 hardened smoke on the new runtime | **Passed.** `main` was merged into #152 as `7ee0fc2`; its push run and PR run ([40218768937](https://github.com/munaxa/munaxa-docs/actions/runs/40218768937)) passed 20/20 checks. Run [40218763269](https://github.com/munaxa/munaxa-docs/actions/runs/40218763269) built the API and web images from this runtime and ran api, web and provisioning with `--read-only --cap-drop ALL --security-opt no-new-privileges`, Redis and the scanner with `--cap-drop ALL`: 18/18, and "no write was refused". That is Docker on a CI runner, not Fargate |

**Not verified on Fargate.** No task of this release has run on Fargate. AWS documents
`readonlyRootFilesystem` and dropping capabilities as supported on Fargate (only *adding* is limited,
to `SYS_PTRACE`), but that is documentation, not an observed run. In particular:

- **The scanner's signature writes.** On Fargate the scanner downloads its signatures into
  `/var/lib/clamav` in its own container layer. In the smoke that path was a Docker volume, which takes
  the image's ownership (clamav), so the same result is expected, but it has not been observed.
- **Behaviour beyond the smoke.** Only the web sign-in page was exercised. That the other screens
  write nothing to disk comes from reading the code: no ISR, `revalidate`, `unstable_cache` or
  `next/image`, and the LibreOffice and Tesseract drivers are off by default.
- **`ops-dbadmin` and `ops-tunnel`** are unchanged by #152 and use their own images, but have never
  been run.

A Tier B run on Fargate is what proves these.

## 6. Residual risk

**Status: NOT ACCEPTED.** The `c6a6d8c` acceptance proposed in #153 was never signed. It covered the
`c6a6d8c` digests only and does not carry over. ECR reports no CRITICAL or HIGH finding on `R`, but
that is a scan result, not an approval of what remains.

**What needs the owner's explicit decision:**

| # | Item | Source |
| --- | --- | --- |
| 1 | ECR findings on the API and web images: CVE-2026-86805 (MEDIUM), CVE-2026-97399 (LOW) and CVE-2026-95818 (LOW), in glibc `2.36-9+deb12u14` | §3 |
| 2 | Local scanner findings that ECR does not report: libc6 (CVE-2026-5450, rated Critical by the local scanners; -19499, -5435, -5928), the gcc-12 runtime libraries (CVE-2026-102010, -95619) and libssl3 (CVE-2026-84782, DTLS). None has an unapplied Debian fix | §4.3 |
| 3 | Fargate behaviour is not proven: the read-only roots, the dropped capabilities and the scanner's signature writes into its own container layer | §5 |
| 4 | `ops-dbadmin` and `ops-tunnel` have never been run | §5 |
| 5 | Tier B (the staging smoke on these digests) has not run | [release-validation-option-a.md](../operations/release-validation-option-a.md) §2 step 7 |

**Approval.** Every field below needs a real value from the authorised owner. None may be inferred:

| Field | Value |
| --- | --- |
| Risk owner | `OWNER INPUT REQUIRED` |
| Accepted by (name, role) | `OWNER INPUT REQUIRED` |
| Date of acceptance | `OWNER INPUT REQUIRED` |
| Review date or expiry | `OWNER INPUT REQUIRED` |
| Change or ticket reference | `OWNER INPUT REQUIRED` |

## 7. Steps and their approvals

| # | Step | Status |
| --- | --- | --- |
| 1 | Choose `R` | Done: option B, `f8a8bea` (`main` after #152) |
| 2 | CI on `R` | Done: run [40222555678](https://github.com/munaxa/munaxa-docs/actions/runs/40222555678) passed |
| 3 | Tag (owner) | Done: `image/f8a8bea62256abb80ad4e33e367ba03bd426d1d8` |
| 4 | Publish (owner approves `image-release`) | Done: run [40225272398](https://github.com/munaxa/munaxa-docs/actions/runs/40225272398), all six jobs green, release smoke 18/18 |
| 5 | Read ECR (read-only) | Done: §2, §3 |
| 6 | This release package: §1 to §5, `release.auto.tfvars`, runbook §1 and §3, prerequisites checklist, Option A plan | **In review** in the release package PR. Not authorised to merge |
| 7 | Residual-risk decision (§6) | **Open: the owner's** |
| 8 | Terraform plan of `eu-prod/service` | **Open: needs the owner's separate authorisation**, after step 6 is merged |
| 9 | Tier B on these digests, any `apply` and the deployment | **Open: each needs the owner's separate authorisation** |

**The Terraform plan (step 8).**
- **When:** after this package's PR is merged.
- **How:** the owner starts "Terraform eu-prod" (`terraform-eu-prod.yml`) with `root=service` and
  `action=plan`, then approves the `production` environment.
- **What to expect:** nothing has been applied in the service root, so the plan **creates** its
  resources rather than changing them.
- **What to check:**
  - the `web`, `api` and `scanner` task definitions and `ops-provision` reference exactly the three
    digests in §2;
  - #152's settings appear: web, api and ops-provision read-only; every service container and both
    Redis sidecars `drop ["ALL"]`.

Review the plan before any apply, which is separately authorised.
