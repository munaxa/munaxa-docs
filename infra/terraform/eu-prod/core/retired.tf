# RETIRED 2026-10-31 (G9, approved by the owner): old Docs eu-prod is being torn down to stop its
# idle cost. Every resource of this root was removed from the configuration so the reviewed
# Terraform eu-prod workflow plans their deletion (see expected-changes.json). The configuration
# as built is in Git history: commit af58195 (stage 1) and earlier. Docs is recreated in the shared
# AWS stack (munaxa-platform infra/aws/stack/docs.tf). Backend, provider and variables stay so the
# workflow can still plan this root against its state.
