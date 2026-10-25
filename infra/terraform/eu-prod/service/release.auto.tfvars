# SELECTED RELEASE c6a6d8c (Option A), pending its approval gates
# (docs/reports/production-release-package-c6a6d8c.md). These are the digests "Publish images" run
# 40133309866 pushed from tag image/c6a6d8cefe14f26670de9e8a413bcdd87851306d on 2026-10-24. Each is
# labelled with the release commit and was read back from ECR in account 229251310592 (eu-central-1).
# The API and web images carry seven HIGH Debian 12 findings with no Debian fix yet; the residual
# risk is proposed for acceptance in the release package (§6) and is not accepted until the owner
# signs it.
# The previous plan-only inputs (db97825, run 39929830650) are superseded and stay as history in
# docs/operations/production-prerequisites-checklist.md §2.
release_commit  = "c6a6d8cefe14f26670de9e8a413bcdd87851306d"
api_image       = "229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/api@sha256:f8af3e0a0e78601c245c03123f032d6c859aa8e3a41f35ab2100423d664e41ae"
web_image       = "229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/web@sha256:9e4345a11db5970fca23cd43a6045e393b96becb46a223d665ba776c20beac0e"
antivirus_image = "229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/antivirus@sha256:e7ad4aa889abd477624e35d421150b8e95825a2e67d5eb5114b7b8d03f39f4a6"
