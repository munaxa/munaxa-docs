# PLAN INPUT ONLY - NOT THE RELEASE. These are the digests published to ECR by "Publish images"
# run 39929830650 from db97825d26195666e7415735f0769d1c10bbbf4d (verified in ECR, 2026-10-23).
# They let the service root be planned. They are not a selected release: the Option A release is
# built from the main commit that carries the antivirus and runtime-image security fixes, and its
# release package replaces all four values here before any apply.
release_commit  = "db97825d26195666e7415735f0769d1c10bbbf4d"
api_image       = "229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/api@sha256:e8f641e608b38e9366c88e714f07a0851bd7066f64f0964f5b188bd211d78b47"
web_image       = "229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/web@sha256:0703fafa9f887d5c815d18b0752c5de6431f40f7c279988d31b0c30757e755b3"
antivirus_image = "229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/antivirus@sha256:1278da65948893cf62c799c19cf003296154f84489192af99f627b3dec827e22"
