# Launch configuration for the Production service root. No secret, credential or tenant data.

# Redis 7.4 (multi-architecture index), resolved from public.ecr.aws on 2026-10-04.
redis_image = "public.ecr.aws/docker/library/redis@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f"

# PROPOSED, pending the owner's choice of the SES sending domain (ADR-0025 §2 leaves <MAIL_DOMAIN>
# open). A dedicated subdomain keeps the company's main mail domain out of SES's DKIM and DMARC.
mail_from_address = "docs@notify.munaxa.com"
