# SELECTED RELEASE f8a8bea (Option A, remediated runtime), pending its approval gates
# (docs/reports/production-release-package-f8a8bea.md). These are the digests "Publish images" run
# 40225272398 pushed from tag image/f8a8bea62256abb80ad4e33e367ba03bd426d1d8 on 2026-10-25. The run
# checked that each is labelled with the release commit, and each was read back from ECR in account
# 229251310592 (eu-central-1). ECR scan on push: no CRITICAL or HIGH finding; the API and web images
# carry one MEDIUM and two LOW glibc findings. The residual risk is NOT ACCEPTED until the owner
# signs it (package §6).
# Superseded, never to be used as inputs: the plan-only db97825 digests (run 39929830650) and the
# c6a6d8c digests (run 40133309866, proposed in #153). Both are listed in the package §2.
release_commit  = "f8a8bea62256abb80ad4e33e367ba03bd426d1d8"
api_image       = "229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/api@sha256:e61494a2fc44b7f488e8a04226b309fb8a20b39cc2b2db1f9b9cfddfcc5abcc8"
web_image       = "229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/web@sha256:0f32ac71d392a374c2a8367684c861d8937b57ff490e1d5d49388fcedc6e08a8"
antivirus_image = "229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/antivirus@sha256:fe60b49b0266196188ee0bc8b31d8e8546ac76ecf409ce4082660d0c12b4dfdb"
