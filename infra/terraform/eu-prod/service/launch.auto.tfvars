# Launch configuration for the Production service root. No secret, credential or tenant data.

# Redis 7.4 (multi-architecture index), resolved from public.ecr.aws on 2026-10-04.
redis_image = "public.ecr.aws/docker/library/redis@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f"

# The SES sender (owner decision, 2026-10-05; ADR-0025 §2). A dedicated subdomain keeps SES out of
# the root domain's SPF; DMARC is inherited from munaxa.com (production-service-inputs.md §4).
mail_from_address = "docs@notify.munaxa.com"

# Operator task images, resolved from public.ecr.aws on 2026-10-05 (multi-architecture indexes).
postgres_image = "public.ecr.aws/docker/library/postgres@sha256:23af655ba1ddf74eaa002e3deaf5fce022ab8791672336a7c1fb0ef2d57efb7f" # 16.12
tunnel_image   = "public.ecr.aws/amazonlinux/amazonlinux@sha256:12052e9b5d3fd85769abbdd863dd038e1890c9ace31d5fdbe1afa78eda97d061" # 2023

# The internal launch tenant (owner decision, 2026-10-05). Not a customer.
bootstrap_tenant = {
  slug     = "munaxa-internal"
  name     = "Munaxa Internal"
  database = "edms_munaxa_internal"
}

# The application bundle every API and provisioning task is pinned to (ADR-0022 consequence 8;
# production-service-inputs.md §3). A version id only, never a value.
app_secret_version_id = "1dfefc89-2bf0-47d7-a244-c5f00b9e0b21"
