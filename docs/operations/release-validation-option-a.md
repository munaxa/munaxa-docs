# Release validation — Option A (Docs v2 on the ECS architecture)

**Status (2026-10-25): release `f8a8bea` is selected and published, not deployed; its approval gates
are open.** Its evidence is in
[production-release-package-f8a8bea.md](../reports/production-release-package-f8a8bea.md).
Results from CI, from local builds, or from the `db97825` and `c6a6d8c` images do not count as
release evidence. `c6a6d8c` was published on 2026-10-24 and is superseded: its API and web images
carry seven HIGH findings that `f8a8bea` removes (package §3, §4). Its package (#153) is not merged.

Owner decision (2026-10-23): release the current architecture with Docs v2 (Option A), after the
security fixes and this validation.

## 1. Source of the release

| Item | Value |
| --- | --- |
| Application code | `f8a8bea`, the same as `c6a6d8c`: release `041e827` (ECS task-role S3 credentials, pool-size fix) plus the Docs v2 web design (#137), the i18n catalogues, `@munaxa/platform` 1.7.0, the SMK-1 sign-in fix (#148) and the D-10 fix (#150) ([package](../reports/production-release-package-f8a8bea.md) §1). *As planned on 2026-10-23, at `db97825`:* no API, Prisma or SQL change since `041e827`; #148 and #150 changed the API after that |
| Security fixes to include | #143 (antivirus: Ubuntu zlib and xz-utils updates) and #145 (runtime image: no setuid/setgid programs), both in `c6a6d8c`. Then:<br>• #151: Debian 12 updates at build time;<br>• #154: an API and web runtime without util-linux, zlib, a shell or a package manager, which removes the seven HIGH findings;<br>• #152: ECS hardening (read-only roots, all capabilities dropped). |
| Release commit | **`f8a8bea62256abb80ad4e33e367ba03bd426d1d8`**: `main` after #151, #154 and #152. CI run 40222555678 green |
| Not the release | `c6a6d8c` (published 2026-10-24; its API and web images carry the seven HIGH findings), `db97825` (its images lack #143 and #145), `041e827` and `4e8e1ca` (GHCR only) |

## 2. Release steps and their gates

Each step needs the owner's approval where marked. Nothing is skipped or reordered.

| # | Step | Gate | Approval |
| --- | --- | --- | --- |
| 1 | Merge #143 and #145 | CI green on each PR head; review | **Owner merges** |
| 2 | Identify the release commit `R` = `main` head after step 1 | CI (`ci.yml`, push to `main`) green on `R`, all 9 jobs | — |
| 3 | Create the tag `image/<full R>` pointing at `R` | Ruleset `refs/tags/image/*`: tag creation is restricted to admins | **Owner creates the tag** |
| 4 | "Publish images" run on the tag | Every job green; `image-release` environment approved | **Owner approves the environment** |
| 5 | Read the ECR results | `describe-images` digests equal the run's; scans `COMPLETE` | — |
| 6 | Release package `docs/reports/production-release-package-<short R>.md` (§3) | Every row filled from evidence | Review in a docs PR |
| 7 | Staging smoke on the release digests (§4) | Every NO-GO item passes | **Owner authorises the run** (tier B costs money) |
| 8 | Update #144 (runbook and checklist) with the release digests | Digests copied from step 5 | Review |

**Status of each step (2026-10-25):**

| # | Status |
| --- | --- |
| 1 | Done: #143 and #145 merged (and #148, #149, #150, #144, #146, #147), then #151, #154 and #152 |
| 2 | Done: `R` = `f8a8bea`, CI run 40222555678 green. (`c6a6d8c`, an earlier `R`, was published and is superseded) |
| 3 | Done: the owner pushed `image/f8a8bea62256abb80ad4e33e367ba03bd426d1d8` |
| 4 | Done: run 40225272398 green, all six jobs. The release smoke on the published digests passed 18/18, with api, web and provisioning read-only and with no capabilities |
| 5 | Done 2026-10-25, read twice (package §2, §3). Scans `COMPLETE` on push; no scan was started afterwards |
| 6 | In review: the release package PR. **The residual-risk decision (package §6) is the owner's** |
| 7 | Tier A, automated part: done by step 4's release smoke. Tier A browser rows: not run. Tier B: not run (**owner authorises; costs money**) |
| 8 | Done in the release package PR (runbook §1 and the prerequisites checklist name `f8a8bea`) |

**Gates after this plan (not in the table above):**

| Gate | Approval |
| --- | --- |
| The Terraform plan of `eu-prod/service` with these inputs | Runs from `main` only, so the release package PR (with `release.auto.tfvars`) is merged first. The plan includes #152's hardening, which is part of `R`. Then the **owner starts** "Terraform eu-prod" (`terraform-eu-prod.yml`) with `root=service`, `action=plan`, and **approves the `production` environment**. A plan changes nothing; review its summary before any `apply` |
| The ECS runtime pull test (runbook §10.1) | **Owner authorises** (creates resources; costs money) |
| Fargate behaviour of #152's hardening: read-only roots, dropped capabilities, the scanner's signature writes into its own container layer | Not proven; shown only on Docker. Tier B (step 7) is what proves it (package §5) |
| Any `apply` and the deployment | **Owner authorises each**; not covered by any approval so far |

**What step 4 verifies by itself:**

- the tag names a commit on `main`;
- the revision label;
- non-root images;
- no credentials in the images;
- the API's query engine;
- the web image's brand artwork;
- the scanner's versions, `verify-container.sh` and `probe.mjs` on the candidate, after an unclean
  restart and on the pulled digest;
- each digest present in ECR.

It does **not** run the application against a database, object store or browser. That is §4.

## 3. Release package (template)

| Section | Content | Source |
| --- | --- | --- |
| Identity | Release commit, tag, publishing run URL, CI run on the commit | GitHub |
| Images | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/{api,web,antivirus}@sha256:…`, tags `<short>` and `sha-<full>` | Run log, `ecr describe-images` |
| Publishing checks | Each check of §2 step 4, with the log line | Run log |
| Scanner versions | `clamd --version`, `c-icap -V`, the package list | Run log (`antivirus-versions`) |
| ECR scans | Per image: scan completion time, counts by severity, every HIGH and CRITICAL with its package and status | `ecr describe-image-scan-findings` |
| Expected scan changes | Antivirus: CVE-2026-85091 and USN-8945-1 gone. API and web: from `f8a8bea` on, the 6 util-linux and 1 zlib HIGH are gone (#154). *Before `f8a8bea`, as planned on 2026-10-23:* they remained until Debian 12 ships fixes | §5 |
| Smoke results | Every §4 row with PASS/FAIL, timestamps and the digests it ran on | §4 records |
| Accepted limitations | WF-1, KEY-1, D-1, D-4, and the open Debian 12 CVEs | Runbook §1a |
| Not yet proven | Whatever §4 or the ECS pull test (runbook §10.1) has not covered | — |
| Rollback | "No rollback target: first deployment" | Runbook §20 |

## 4. Staging smoke on the release digests

Two tiers. Tier A needs no AWS resources. Tier B is the only proof of the AWS-specific paths: ECR
pull, task-role S3, RDS, Resend and the ALB.

### 4.1 Tier A — staging-shaped, local (no AWS cost)

The procedure of release packages `c87519e` and `27a8daa` §4, run on the **release images pulled by
digest**:

- `NODE_ENV=production`, `DEPLOYMENT_PROFILE=CLOUD`;
- two tenants, `acme` and a decoy slugged `docs`;
- PostgreSQL 16;
- S3 driver on MinIO;
- `AV_DRIVER=ICAP` on the release scanner image;
- Redis.

**Two blockers to settle before Tier A can be reproduced:**

1. **Pulling the release digests.** Only the ECS execution roles and the publisher may pull, and no
   person may hold long-lived AWS keys. The reproducible option is a smoke job **inside**
   `publish-images.yml`, after the push, which pulls the three digests with the publisher session and
   runs this tier. That is a workflow change for review (its own PR), and it requires the next point.
2. **The smoke harness is not in the repository.** The `c87519e` and `27a8daa` runs used a harness
   written for each run. Commit one (scripted runbook §16 plus the browser checks below) so every
   release runs the same checks.

### 4.2 Tier B — the Production stack before cutover (paid, needs approval)

Run after the ECS pull test (runbook §10.1). The service root runs in its stages (#146):
`enable_https` then `enable_services`.

- The tests reach the ALB with `--resolve docs.munaxa.com:443:<ALB address>`.
- **No DNS cutover** happens until every NO-GO item passes.
- Cost: about $3–4 a day while the stack is up (ALB, three tasks, public IPv4); RDS already runs.

### 4.3 Tests

`A` = Tier A, `B` = Tier B. **NO-GO** means a failure stops the release.

| Area | Test | Tier | Pass criterion | NO-GO |
| --- | --- | --- | --- | --- |
| Images | Each running container reports the release digest | A, B | `docker inspect` / ECS `imageDigest` equals the package | yes |
| Images | ECR pull by the execution roles through the S3 endpoint | B | Runbook §10.1 criteria | yes |
| API | `GET /api/health/live` | A, B | 200 | yes |
| API | `GET /api/health/ready` | A, B | Database, cache and antivirus `UP` | yes |
| API | OpenAPI off in production | A, B | `/api/docs` not served | yes |
| API | Start refuses static S3 keys beside `STORAGE_CREDENTIALS_SOURCE=ECS_TASK_ROLE` | B | Task exits before any S3 call | yes |
| Database | Migrations on a fresh tenant database, run twice | A, B | Second run reports nothing pending | yes |
| Database | TLS to RDS (`rds.force_ssl`), `max_connections` recorded | B | Connection only with TLS | yes |
| Database | Pool size from `DATABASE_POOL_SIZE` reaches each tenant client | A | `connection_limit` in effect (log or `pg_stat_activity`) | no |
| Tenancy | Tenant never resolved from the host; decoy `docs` unreachable via `docs.munaxa.com` | A, B | RC-1…RC-6 | yes |
| Authentication | Runbook §16 steps 1–3: login, `/auth/me`, sign-out revokes the refresh token (WEB-1) | A, B | As written | yes |
| Authentication | TOTP enrolment (RC checks) | A | Enrolment succeeds, no 500 | yes |
| Authentication | Cookies `httpOnly`, `Secure`, `SameSite=Lax`, host-only | A, B | Browser check | yes |
| S3 | §16 steps 5–9: presigned upload, `CLEAN` scan, filing, download SHA-256 equal, preview, revision 2 | A, B | As written | yes |
| S3 | Task-role credentials only: put, head, get, presigned download, delete; no long-lived key | B | CloudTrail shows the `api-task` role session | yes |
| Antivirus | §16 steps 10–13 and 21 (EICAR blocked, quarantined, not fileable, bulk) | A, B | As written | yes |
| Antivirus | Scanner restart and Spot replacement keep scanning | B | `probe.mjs` after `UpdateService --force-new-deployment` | no |
| Workflow | §16 steps 14–16, numbering collision answers 409 (NUM-1) | A, B | As written | yes |
| Search | §16 step 17 | A, B | Found | no |
| Audit | §16 step 18 | A, B | Each event on its own subject | yes |
| Permissions | §16 steps 19–20 | A, B | Absent and refused like a nonexistent id | yes |
| Email | One notification to an internal address through Resend | B | Delivered; no customer data | no |
| Docs v2 UI | Sign-in card with theme and language controls; blank organisation refused | A, B | Browser | yes |
| Docs v2 UI | Shell: rail collapse, pending-approvals count, retention reminder only with `retention:manage` | A | Browser | no |
| Docs v2 UI | Top bar: Cmd/Ctrl+K opens search (below `lg`: the search screen); EN/AR switch sets the locale cookie and RTL layout | A | Browser | no |
| Docs v2 UI | Library: folder rail, library picker, filter chips change the URL and the list, `owner: me` | A | Browser | no |
| Docs v2 UI | Docked detail panel reads workflow and timeline only: **no `GET /documents/:id`**, so no view is recorded | A | Network log and audit timeline | yes |
| Docs v2 UI | Record page tabs (Overview, Approvals, Revisions, History); approvals Awaiting/Decided | A | Browser | no |
| Docs v2 UI | No horizontal scroll at 320, 768 and 1280 px, in EN and AR | A | Browser | no |
| Docs v2 UI | Brand assets served (5/5) | A, B | 200 `image/png` | yes |
| Security | Security headers, TLS 1.2+ on the ALB (`ELBSecurityPolicy-TLS13-1-2-2021-06`), HTTP redirects to HTTPS | B | Runbook §17 | yes |
| Security | No setuid/setgid file in the api and web images (#145) | A | None in the exported image filesystem (`docker export`, as `scripts/release-smoke/run.sh` checks). Since #154 the images have no shell, so `find` cannot run inside them | yes |

CI already runs the Docs v2 end-to-end and visual-regression suites on every commit (`ci.yml`). They
run on CI builds, not on the release digests, so they support the rows above but do not replace them.

### 4.4 Records

For each run, record:

- the date;
- the three digests;
- the operator;
- each row's result with its evidence (log excerpt, HTTP status, screenshot or HAR file name);
- every failure with the harness-or-product analysis.

A harness fix may be re-run. A product failure stops the release.

## 5. Security status

**Release `f8a8bea`, ECR scan on push, read 2026-10-25** ([package](../reports/production-release-package-f8a8bea.md) §3):

| Image | CRITICAL / HIGH / MEDIUM / LOW | Findings |
| --- | --- | --- |
| api | 0 / 0 / 1 / 2 | glibc `2.36-9+deb12u14`: CVE-2026-86805 (MEDIUM), CVE-2026-97399 (LOW), CVE-2026-95818 (LOW) |
| web | 0 / 0 / 1 / 2 | the same three |
| antivirus | 0 / 0 / 0 / 0 | none |

- **The seven HIGH findings are gone from ECR's results.** They were six util-linux and one zlib
  finding on the `c6a6d8c` API and web images, and none appears on `f8a8bea`'s.
- **The local scanners disagree with ECR.** Trivy and Grype also list libc6, gcc-12 and libssl3
  findings that ECR BASIC does not report (package §4.3). That difference comes from the scanners'
  databases and is not evidence that those findings are fixed.
- **Risk acceptance is NOT ACCEPTED** (package §6).

*Historical, as written on 2026-10-23:*

| Image | Expected after the release | Still open |
| --- | --- | --- |
| antivirus | CVE-2026-85091 and USN-8945-1 fixed (local build and Trivy; ECR scan **not yet**) | Ubuntu MEDIUM/LOW findings without fixes |
| api, web | No setuid/setgid programs (#145) | 6 util-linux and 1 zlib HIGH (Debian 12, no fix; zlib probably not applicable), 2 MEDIUM, 2 LOW. Rebuild when Debian ships fixes |
