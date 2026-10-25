# Release candidate: the remediated runtime (after #154)

**Status (2026-10-25): CANDIDATE, NOT PUBLISHED.** This record prepares the next release under the
Option A process ([release-validation-option-a.md](../operations/release-validation-option-a.md)
§2). Nothing below has been tagged, published, scanned in ECR, planned or deployed. Every value that
only a publication can produce is marked **PENDING**. None is a placeholder that could be mistaken
for a real digest.

**Why a new release.** Release `c6a6d8c` was published before #154. Its API and web images are built
on `node:22-bookworm-slim` and carry util-linux and zlib, so they keep the seven HIGH findings ECR
reported. Those images cannot be relabelled as remediated. The remediation exists only in images
built from a commit that contains #154.

## 1. Release commit

| Item | Value |
| --- | --- |
| **Release commit `R`** | **PENDING: the owner chooses `R` before tagging** |
| Option A | `6c79358753961c8fe7947548640f069774086485`, `main` after #154 |
| Option B | `main` after #152 (ECS hardening), if it is merged first. `publish-images.yml` then runs the hardened release smoke (`--read-only`, `--cap-drop ALL`) on the published digests |
| CI on `R` | For option A: "CI" run [40218617539](https://github.com/munaxa/munaxa-docs/actions/runs/40218617539) (push to `main`), passed 10/10. For option B: PENDING, CI on `main` after #152 |
| Release tag | PENDING: `image/<full R>`, created by the owner |
| Publishing run | PENDING: "Publish images" on that tag |

**What `R` contains compared with `c6a6d8c`** (`git diff c6a6d8c 6c79358`):

- **#151.** The runtime takes Debian 12 updates at build time, and adds
  [image-vulnerability-assessment-c6a6d8c.md](./image-vulnerability-assessment-c6a6d8c.md).
- **#154.** The API and web runtime is a minimal Debian 12 tree: no shell, package manager, util-linux,
  zlib or setuid file. The checks that ran a shell inside the image are rewritten
  ([image-vulnerability-remediation-2026-10-25.md](./image-vulnerability-remediation-2026-10-25.md)).
- **No change** to application code, migrations, SQL, the scanner image source or the lockfile.
  Nothing under `apps/`, `packages/`, `prisma/`, `infra/sql/` or `infra/antivirus/`, and no change to
  `pnpm-lock.yaml`.

## 2. Images

| Image | Immutable reference | Revision label | Publishing run |
| --- | --- | --- | --- |
| API | PENDING | PENDING (must equal `R`) | PENDING |
| Web | PENDING | PENDING (must equal `R`) | PENDING |
| Antivirus | PENDING | PENDING (must equal `R`) | PENDING |

The antivirus source is unchanged since `c6a6d8c`. It still gets a new digest, because every
published image carries the release commit in its label. **The `c6a6d8c` digests must not be
reused.**

**How each image will be tied to `R`.** `publish-images.yml` already enforces this; nothing new is
needed:

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

Fill §2 from that run's summary, and §3 from ECR. Copy the digests only from there.

## 3. ECR results

**Previous images (`c6a6d8c`), recorded in its release package; not this candidate:**

| Image | CRITICAL | HIGH | MEDIUM | LOW |
| --- | --- | --- | --- | --- |
| API | 0 | 7 | 2 | 2 |
| Web | 0 | 7 | 2 | 2 |
| Antivirus | 0 | 0 | 0 | 0 |

**This candidate:**

| Image | Scan status | CRITICAL | HIGH | MEDIUM | LOW |
| --- | --- | --- | --- | --- | --- |
| API | PENDING | PENDING | PENDING | PENDING | PENDING |
| Web | PENDING | PENDING | PENDING | PENDING | PENDING |
| Antivirus | PENDING | PENDING | PENDING | PENDING | PENDING |

**Expected, not yet observed.** Trivy and Grype scans of runtimes built from the same Dockerfile
report none of the seven util-linux and zlib CVEs (§4). ECR BASIC (Clair) has not scanned an image of
this shape. Whether it reads the runtime's `/var/lib/dpkg/status` is part of what the scan will show.
**If ECR reports no packages at all for the API or web image, treat that as a failed scan, not a
clean result.**

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
| ECR for the published digests | **PENDING** (§3) |

### 4.3 Remaining findings on the candidate runtime

These come from local scans: Trivy 0.69.3 and Grype 0.104.0, databases of 2026-10-25, the `runtime`
target built from `6c79358`.

| Finding | Package | Debian status | Also in the `c6a6d8c` images? |
| --- | --- | --- | --- |
| CVE-2026-5450 (Critical), -19499, -5435, -5928 | libc6 `2.36-9+deb12u14` | won't fix | yes |
| CVE-2026-102010, -95619 | gcc-12 runtime libraries `12.2.0-14+deb12u1` | won't fix | yes |
| CVE-2026-84782 (DTLS) | libssl3 `3.0.22-1~deb12u1` | no fix yet | yes |

**No finding on the candidate runtime has a Debian fix that is not applied.** ECR BASIC's view of
these is PENDING. If ECR reports any of them as HIGH or CRITICAL, the owner needs a new residual-risk
record (§6).

## 5. Evidence so far

| Check | Result |
| --- | --- |
| PR #154 CI on `8cebc37` (20 checks) | Passed. Release smoke 18/18 on the shell-less API and web images. Web artwork served. Prisma engine check, integration and every end-to-end shard passed |
| `8cebc37` and `6c79358` trees | Identical (`git diff 8cebc37 6c79358` is empty) |
| CI on `6c79358` (push to `main`) | Run [40218617539](https://github.com/munaxa/munaxa-docs/actions/runs/40218617539): **passed, 10 of 10 jobs.** These include the release smoke, the image builds (API, web and worker), the Prisma engine check, integration, every end-to-end shard and "Lint · Typecheck · Test · Build" with its visual-regression step |
| `runtime` built from `6c79358` (local) | 9 Debian packages, current Debian 12 versions (`libssl3 3.0.22-1~deb12u1`, `libc6 2.36-9+deb12u14`, `ca-certificates 20250419~deb12u2`). No setuid or setgid file. No shell, package manager or `mount`. No util-linux or zlib file |
| Native modules on that runtime (local) | Lockfile versions: Prisma 6.19.3, `sharp` 0.34.5, `msgpackr-extract` 3.0.4. Run with `--read-only --cap-drop ALL --security-opt no-new-privileges`, Node v22.23.4 selects the `debian-openssl-3.0.x` engine, connects to PostgreSQL 16 with `sslmode=require` and writes; `sharp` and `msgpackr-extract` load; HTTPS works; `dumb-init` forwards SIGTERM |
| Rewritten checks (local) | Setuid: fails `node:22-bookworm-slim`, passes the runtime. Engine: passes an image with the engine, fails one without. `.npmrc`: fails an image with a planted token |
| #152 hardened smoke on the new runtime | **Passed.** `main` was merged into #152 as `7ee0fc2`; its push run and PR run ([40218768937](https://github.com/munaxa/munaxa-docs/actions/runs/40218768937)) passed 20/20 checks. Run [40218763269](https://github.com/munaxa/munaxa-docs/actions/runs/40218763269) built the API and web images from this runtime and ran api, web and provisioning with `--read-only --cap-drop ALL --security-opt no-new-privileges`, Redis and the scanner with `--cap-drop ALL`: 18/18, and "no write was refused". That is Docker on a CI runner, not Fargate |

## 6. Residual risk for this candidate

**Status: NOT ACCEPTED.** The `c6a6d8c` acceptance (#153, still unsigned) covered the three
`c6a6d8c` digests only. It does not carry over to this candidate.

What needs a decision depends on the ECR result (§3). That decision is the owner's:

| Field | Value |
| --- | --- |
| Risk owner | `OWNER INPUT REQUIRED` |
| Accepted by (name, role) | `OWNER INPUT REQUIRED` |
| Date of acceptance | `OWNER INPUT REQUIRED` |
| Review date or expiry | `OWNER INPUT REQUIRED` |
| Change or ticket reference | `OWNER INPUT REQUIRED` |

## 7. Next steps and their approvals

Steps 1 to 4 and 7 to 8 each need the owner's explicit authorisation. This record performs none of
them.

1. **Choose `R`** (§1). If option B, review #152 once its CI is green and merge it first.
2. **CI on `R`** must be green.
3. **Tag (owner):**
   ```
   git fetch origin main
   git tag image/<full R> <full R>
   git push origin image/<full R>
   ```
   The `image/*` ruleset restricts tag creation to administrators. Never move or reuse an existing
   tag.
4. **Publish (owner).** Approve the `image-release` environment for the "Publish images" run the tag
   starts. Every job must be green, including the release smoke on the published digests.
5. **Read ECR** (read-only), account `229251310592`, `eu-central-1`. For each of the three digests:
   - `describe-images`: the digest, its two tags, and that neither tag is on another digest;
   - `describe-image-scan-findings`: status `COMPLETE`, severities and findings.

   Record the results in §2 and §3. No `start-image-scan` is needed: scan on push runs it.
6. **Release package PR.**
   - Turn this record into `production-release-package-<short R>.md`, every row from evidence.
   - Set `infra/terraform/eu-prod/service/release.auto.tfvars`:
     - `release_commit` = `R`;
     - `api_image`, `web_image` and `antivirus_image` = the three references from step 5.

     The variables' validation accepts only real `sha256:` digests in these repositories.
   - Select `R` in the go-live runbook §1, the prerequisites checklist and the Option A plan. #153's
     corrections to those documents (historical labels, `4e8e1ca` steps) apply unchanged, with `R`
     in place of `c6a6d8c`.
   - Close or supersede #153.
   - Correct one runbook row: "Application runtime" in go-live-runbook.md §3 still describes the
     `node:22-bookworm-slim` base. That is true of `c6a6d8c` and must change only with the release
     that ships the new runtime.
7. **Residual-risk record** (§6), if ECR reports findings that need acceptance.
8. **Terraform plan (owner):**
   - after the release package PR is merged;
   - run "Terraform eu-prod" with `root=service` and `action=plan`;
   - approve the `production` environment.

   Nothing has been applied in the service root, so the plan **creates** its resources rather than
   changing them. Check in particular:
   - the `web`, `api` and `scanner` task definitions and `ops-provision` reference exactly the three
     digests of `R`;
   - if #152 was merged, the read-only roots and dropped capabilities appear.

   Review the plan before any apply, which is separately authorised.

**Current Terraform inputs.** `main`'s `release.auto.tfvars` still holds the superseded `db97825`
plan-only digests, and #153 holds `c6a6d8c`'s. Neither contains the remediation. Do not run a plan
until step 6 is merged.
