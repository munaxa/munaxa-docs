# Launch configuration for the Production service root. No secret, credential or tenant data.

# Redis 7.4 (multi-architecture index), resolved from public.ecr.aws on 2026-10-04.
redis_image = "public.ecr.aws/docker/library/redis@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f"

# The sender. Email goes through Resend (owner decision); notify.munaxa.com must be verified in
# Resend before enable_services. An address, not a credential.
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

# Stage 2 (main.tf): the HTTPS listener, the preview rule and the HTTP→HTTPS redirect. The
# docs.munaxa.com certificate is ISSUED (validated 2026-10-26). enable_services stays false.
enable_https = true

# The application bundle version every API and provisioning task is pinned to (ADR-0022
# consequence 8). Set it once the bundle has a value in account 229251310592; the id from the
# previous account does not exist here. Empty means the current version.
app_secret_version_id = ""

# Licensing (ADR-0026, option A): Munaxa Control's product-facing host (shared AWS hosting ADR
# draft, Control docs/operations/deployment.md). Its host is put on OUTBOUND_HTTP_ALLOWLIST by
# ecs.tf. The credential is CONTROL_PLANE_TOKEN in the application bundle, never here.
control_plane_url = "https://control-api.munaxa.com"
