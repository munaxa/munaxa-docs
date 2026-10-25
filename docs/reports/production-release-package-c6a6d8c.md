# Production Release Package: release `c6a6d8c`

**Date:** 2026-10-25.

**What this package is.** It records the release selected under Option A
([release-validation-option-a.md](../operations/release-validation-option-a.md)):
- the commit its images were built from;
- the publishing run;
- the three immutable ECR digests and how each was verified;
- the ECR scan results;
- the residual vulnerability risk proposed for acceptance.

**What it is not.** It is not a production-readiness declaration, and nothing has been deployed:
- the risk acceptance in §6 still needs the owner's sign-off;
- Tier B validation has not run;
- the production prerequisites are still open
  ([production-prerequisites-checklist.md](../operations/production-prerequisites-checklist.md)).

## 1. Release identity

| Item | Value |
| --- | --- |
| **Release commit** | **`c6a6d8cefe14f26670de9e8a413bcdd87851306d`** (`c6a6d8c`), on `main` |
| What the images contain | `041e827`'s ECS architecture, plus: the Docs v2 web design (#137); the antivirus Ubuntu updates (#143); runtime images without setuid/setgid programs (#145); sign-in refused for a catalogue tenant that is not provisioned yet (SMK-1, #148); a malformed id answered 404/422 instead of 500 (D-10, #150) |
| Test and CI only (not in the images) | the release smoke harness and its publish job (#147); the antivirus event-order test (#149) |
| CI on the exact commit | "CI" run [40130559927](https://github.com/munaxa/munaxa-docs/actions/runs/40130559927) (push to `main`): **success**, every job |
| Release tag | `image/c6a6d8cefe14f26670de9e8a413bcdd87851306d` → `c6a6d8cefe14f26670de9e8a413bcdd87851306d` (verified with `git ls-remote`, 2026-10-25). Pushed by the owner |
| Publishing run | "Publish images" run [40133309866](https://github.com/munaxa/munaxa-docs/actions/runs/40133309866), 2026-10-24: **success**, all six jobs |
| Accepted launch limitations | WF-1, KEY-1 and D-1 (go-live runbook §1a), unchanged; D-4 as recorded in the RC validation. **Plus the residual image risk in §6, which awaits sign-off** |

## 2. Published images

Deploy **by digest only**. These three references are the release.

| Image | Immutable reference | Revision label |
| --- | --- | --- |
| API | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/api@sha256:f8af3e0a0e78601c245c03123f032d6c859aa8e3a41f35ab2100423d664e41ae` | `c6a6d8cefe14f26670de9e8a413bcdd87851306d` |
| Web | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/web@sha256:9e4345a11db5970fca23cd43a6045e393b96becb46a223d665ba776c20beac0e` | `c6a6d8cefe14f26670de9e8a413bcdd87851306d` |
| Antivirus | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/antivirus@sha256:e7ad4aa889abd477624e35d421150b8e95825a2e67d5eb5114b7b8d03f39f4a6` | `c6a6d8cefe14f26670de9e8a413bcdd87851306d` |

- **Tags:** each image is also tagged `c6a6d8c` and `sha-c6a6d8cefe14f26670de9e8a413bcdd87851306d`, both
  immutable. There is no `latest` tag.
- **Repositories:** `IMMUTABLE` tags, scan on push, AES256 encryption. Registry scanning is
  **BASIC**.
- **Where this is used:** the same three references are the selected inputs in
  [`infra/terraform/eu-prod/service/release.auto.tfvars`](../../infra/terraform/eu-prod/service/release.auto.tfvars).

## 3. Verification of the published digests

Rows come from run `40133309866`'s job logs unless stated otherwise.

| Check | Result |
| --- | --- |
| Source | The tag names a full SHA on `main`; the run built exactly `c6a6d8c` from a clean checkout ("Resolve the source commit") |
| Revision label | Verified on each digest pulled back from ECR ("Pull by digest and verify the revision label"), and again by the release smoke on the loaded images |
| Non-root | API and web `USER node`; antivirus `USER 101:102`. Release smoke image checks |
| No setuid/setgid | API and web: none (`find / -xdev -perm /6000` is empty). Release smoke image checks |
| API | Carries the Prisma query engine for its runtime OpenSSL |
| Web | Serves the Munaxa artwork its pages reference |
| Antivirus: versions | ClamAV **1.5.4**, c-icap **0.5.10** (`clamav-daemon=1.5.4+dfsg-0ubuntu0.24.04.1`, `clamav-freshclam=1.5.4+dfsg-0ubuntu0.24.04.1`, `c-icap=1:0.5.10-6.1build2`, `libc-icap-mod-virus-scan=1:0.5.5-2build4.2`) |
| Antivirus: function | `probe.mjs` (clean file passes, EICAR blocked) on the candidate and after an unclean restart; the pushed digest is the image that was probed. The candidate runs as non-root and carries no credential |
| In ECR | "Every digest is in ECR": each digest found by `describe-images` with the publisher role |
| Release smoke | **18/18 passed, every blocking check passed**, on images pulled from ECR by digest and checked against the image IDs recorded at the pull (§5) |

**Image IDs** of the pulled digests, as loaded by the smoke: API `sha256:789a49d8…`, web
`sha256:957bad46…`, antivirus `sha256:56c1f344…`.

**Direct ECR reads (2026-10-24, account `229251310592`, `eu-central-1`, read-only):**
- each digest exists with the two tags above;
- pushed at 21:16:33 (antivirus), 21:17:21 (API) and 21:17:30 (web) UTC.

**Re-verification on 2026-10-25: PENDING.** The AWS connector needed re-authorisation, so the ECR
reads could not be repeated. Repeat `describe-images` and `describe-image-scan-findings` for the
three digests before this package is approved.

## 4. ECR scan results (BASIC; scans COMPLETE, 2026-10-24)

| Image | Scan completed (UTC) | CRITICAL | HIGH | MEDIUM | LOW |
| --- | --- | --- | --- | --- | --- |
| API | 21:17:41 | 0 | 7 | 2 | 2 |
| Web | 21:17:51 | 0 | 7 | 2 | 2 |
| Antivirus | 21:16:41 | 0 | 0 | 0 | 0 |

**HIGH (API and web, identical):**

| CVE | Package (installed) | CVSS 3 | Debian 12 fix |
| --- | --- | --- | --- |
| CVE-2026-78408 | util-linux `2.38.1-5+deb12u3` | 7.9 | none |
| CVE-2026-78409 | util-linux `2.38.1-5+deb12u3` | 7.0 | none |
| CVE-2026-78410 | util-linux `2.38.1-5+deb12u3` | 7.8 | none |
| CVE-2026-76642 | util-linux `2.38.1-5+deb12u3` | not given | none |
| CVE-2026-53613 | util-linux `2.38.1-5+deb12u3` | 7.0 | none (fixed in Debian 13, `2.41.5-0+deb13u1`, DSA-6442-1) |
| CVE-2026-53615 | util-linux `2.38.1-5+deb12u3` | 8.0 | none (fixed in Debian 13, `2.41.5-0+deb13u1`) |
| CVE-2026-85091 | zlib `1:1.2.13.dfsg-1` | not given | none (unfixed in Debian 13 and unstable too) |

**MEDIUM and LOW (API and web):**
- CVE-2026-86805 (glibc, MEDIUM);
- CVE-2026-13595 (util-linux, MEDIUM);
- CVE-2026-97399 and CVE-2026-95818 (glibc, LOW).

**Where the evidence is.** The per-CVE status, how it was checked (`apt-cache policy` in the base
image and the Debian security tracker, 2026-10-24) and the exposure analysis are in
[image-vulnerability-assessment-c6a6d8c.md](./image-vulnerability-assessment-c6a6d8c.md) (PR #151).

**What these results are not.** They are the BASIC scanner's operating-system findings. They are
not a statement that the images are free of vulnerabilities, and no finding has been suppressed or
re-rated.

## 5. Release smoke on the published digests

Run `40133309866`, job "Release smoke on the published digests", 2026-10-24 21:21–21:24 UTC.

**Before any check ran:**
- the job held no AWS or OIDC credential;
- each loaded image matched the digest the run published and the image ID pulled from ECR.

| Check | Result |
| --- | --- |
| H1–H3 | liveness 200; readiness `UP` (databases, cache, scanner); OpenAPI not served (404) |
| A1–A6 | sign-in; `/auth/me`; blank organisation refused (422, no token); decoy tenant refused (401); refresh without a tenant refused (401); sign-out revokes the refresh token |
| **A7** (blocking) | sign-in to a migrated catalogue tenant that is not provisioned: **HTTP 401 `UNAUTHENTICATED`, no token, no cookie** |
| C1 | numbering rule, confidentiality, document type and library created |
| S1–S3 | presigned upload scanned `CLEAN`; filed (201); download SHA-256 equals the upload |
| V1–V2 | EICAR scanned `INFECTED`; filing refused (409 `CONTENT_NOT_SCANNED`) |
| W1–W2 | web sign-in page renders; all 5 branding assets served |

This covers the Tier A rows of the Option A plan that the harness automates. It does not cover the
browser checks (Docs v2 screens, cookies, TOTP enrolment) or any Tier B row.

## 6. Residual vulnerability risk: proposed acceptance for this release

**Decision recorded (owner, Option A):** release `c6a6d8c` keeps its published Debian 12 images,
with the residual risk documented. **This is not a remediation and not a permanent waiver.** It
applies only to the three digests in §2.

**The risk**

- **Findings:** the seven HIGH findings in §4 affect the API and web images. Debian has published
  no fixed Debian 12 package for any of them. The installed versions are the newest Debian 12
  candidates, and the Debian tracker lists bookworm as vulnerable.
- **Mitigations in place.** These limit exposure; none of them fixes a finding:
  - **util-linux:** no setuid or setgid program exists in either image, so `mount`, `umount` and
    `nsenter` cannot be driven with elevated privilege. Both images run as `node`, never as root.
  - **CVE-2026-53615:** nothing in the product calls libblkid.
  - **zlib (CVE-2026-85091):** the application does not use the system zlib. Node links no
    system `libz` and bundles its own (`1.3.1-e00f703`). In the image, the system `zlib1g` is used
    only by `dpkg`, `apt`, `gpgv` and `util-linux`.
- **Uncertainty that remains:**
  - the exposure analysis is a review, not a test of each CVE;
  - BASIC scanning does not cover `node_modules` or the Node binary's bundled libraries;
  - the zlib CVE text gives an affected range (1.3.1.2 to 1.3.2) that does not match Debian's
    bookworm marking;
  - the ECS hardening (read-only root filesystem, no capabilities) is a separate proposal (PR
    #152) and is **not** part of the configuration this risk was assessed against.
- **Reassessment required:**
  - when Debian publishes a bookworm fix for any of the seven;
  - when a finding's severity or exploit status changes;
  - before any further release from the same base image.

  #151 makes the next build take Debian's updates; a rebuilt image needs a new release and a new
  scan.

**Governance: to be completed by the owner**

| Field | Value |
| --- | --- |
| Risk owner | ☐ *to be completed* |
| Accepted by (name, role) | ☐ *to be completed* |
| Date of acceptance | ☐ *to be completed* |
| Review date or expiry | ☐ *to be completed* (it must be before any later release from this base) |
| Change or ticket reference | ☐ *to be completed* |

## 7. Not yet proven on this release

These belong to the production prerequisites and the go-live runbook, not to publishing:

- **ECS pull** of the three digests by the execution roles (runbook §10.1);
- **the full API on AWS:** starting in production mode, the migrations on RDS, task-role S3, TLS
  to RDS, Resend delivery (Tier B);
- **the browser checks** on these exact digests;
- **image signing:** no signing policy exists;
- **the ECS hardening of PR #152**, if adopted. Its own CI smoke run tests it on CI-built images
  from the same source, not on these digests.

**Rollback.** This is the first ECS deployment, so there is **no rollback target** (runbook §20).
This must be recorded in the change record.

## 8. Relationship to earlier releases

| Release | Status |
| --- | --- |
| `db97825` (ECR, run 39929830650) | **Not deployable.** Superseded: its images predate #143, #145, #148 and #150. Its digests stay in ECR as history |
| `041e827` ([package](./production-release-package-041e827.md)) | GHCR only, historical; cannot run as published on the ECR architecture |
| `4e8e1ca`, `8cb4c14`, `27a8daa`, `c87519e`, `f5d5bb2` | Historical |
