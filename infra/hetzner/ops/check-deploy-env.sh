#!/usr/bin/env bash
# Checks a deploy.env before anything is pulled or started (hetzner-host-operations.md §5).
#
#   infra/hetzner/ops/check-deploy-env.sh deploy.env            the file alone
#   infra/hetzner/ops/check-deploy-env.sh deploy.env --on-host  also the server it will run on:
#                                                               config files, modes, backup volume
#
# The file is parsed, never executed, and no value is printed: a problem names the setting only.
# Exit 0 when nothing is wrong; otherwise the number of problems.
#
# What it insists on:
#   - no placeholder (`<…>`) left anywhere;
#   - every image by immutable digest (`@sha256:` and 64 hex), the four of this release included;
#   - at least two distinct age PUBLIC keys for the backups, and no private key or secret in the file
#     (secrets live in DOCS_CONFIG_DIR, never here);
#   - the plain-HTTP listener on 127.0.0.1 only;
#   - with DOCS_PUBLIC_HOSTNAME set (direct TLS, compose.tls.yaml): a real, fully qualified host
#     name — not an address, not localhost, not a reserved example name — an ACME contact, and an
#     https:// ACME directory.
set -uo pipefail

file="${1:?usage: check-deploy-env.sh DEPLOY_ENV [--on-host]}"
on_host=0
[ "${2:-}" = "--on-host" ] && on_host=1
problems=0

problem() {
  echo "PROBLEM  $*"
  problems=$((problems + 1))
}
fine() { echo "ok       $*"; }

[ -r "$file" ] || {
  echo "PROBLEM  $file cannot be read"
  exit 1
}
get() { sed -n "s/^$1=//p" "$file" | tail -n 1; }

# 1. Placeholders and secrets.
placeholders="$(grep -E '^[A-Z_]+=.*[<>]' "$file" | cut -d= -f1 | sort -u | tr '\n' ' ')"
[ -z "$placeholders" ] && fine "no placeholders" || problem "placeholders remain in: $placeholders"
if grep -q 'AGE-SECRET-KEY-' "$file"; then
  problem "an age PRIVATE key is in the file; only public keys (age1…) belong here"
fi
secrets="$(grep -E '^[A-Z_]*(PASSWORD|SECRET|TOKEN|_KEY_ID|ACCESS_KEY)[A-Z_]*=' "$file" | cut -d= -f1 | tr '\n' ' ')"
[ -z "$secrets" ] && fine "no secret settings (they belong in DOCS_CONFIG_DIR)" ||
  problem "secret-looking settings belong in DOCS_CONFIG_DIR, not here: $secrets"

# 2. Identity and places.
project="$(get DOCS_PROJECT_NAME)"
printf '%s' "$project" | grep -Eq '^[a-z0-9][a-z0-9_-]*$' && fine "DOCS_PROJECT_NAME set" ||
  problem "DOCS_PROJECT_NAME must be set (lower case, e.g. munaxa-docs-test)"
for name in DOCS_CONFIG_DIR DOCS_BACKUP_DIR DOCS_OFFSITE_STATE_DIR; do
  value="$(get "$name")"
  case "$value" in
    /*) fine "$name is an absolute path" ;;
    *) problem "$name must be an absolute path" ;;
  esac
done

# 3. Images: immutable references only.
for name in DOCS_API_IMAGE DOCS_WEB_IMAGE DOCS_ANTIVIRUS_IMAGE DOCS_POSTGRES_IMAGE DOCS_PROXY_IMAGE DOCS_REDIS_IMAGE; do
  value="$(get "$name")"
  if printf '%s' "$value" | grep -Eq '^[a-z0-9.-]+(:[0-9]+)?/?[a-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$'; then
    fine "$name is pinned by digest"
  else
    problem "$name must name an image by @sha256:<64 hex> digest"
  fi
done
offsite_image="$(get DOCS_OFFSITE_IMAGE)"
if [ -n "$offsite_image" ] && ! printf '%s' "$offsite_image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
  problem "DOCS_OFFSITE_IMAGE must be pinned by digest (or left unset for compose.yaml's pinned default)"
fi

# 4. Backup recipients: two or more distinct public keys.
recipients="$(get DOCS_BACKUP_AGE_RECIPIENTS | tr ',' ' ')"
count=0 bad=0
for recipient in $recipients; do
  if printf '%s' "$recipient" | grep -Eq '^age1[02-9ac-hj-np-z]{58}$'; then
    count=$((count + 1))
  else
    bad=1
  fi
done
distinct="$(printf '%s\n' $recipients | sort -u | grep -c . || true)"
if [ "$bad" -eq 1 ]; then
  problem "DOCS_BACKUP_AGE_RECIPIENTS holds something that is not an age public key"
elif [ "$count" -lt 2 ] || [ "$distinct" -lt "$count" ]; then
  problem "DOCS_BACKUP_AGE_RECIPIENTS needs at least two distinct public keys (two holders)"
else
  fine "$count distinct backup recipients"
fi

# 5. The listener and TLS.
bind="$(get DOCS_HTTP_BIND)"
[ -z "$bind" ] || [ "$bind" = "127.0.0.1" ] && fine "plain-HTTP listener on 127.0.0.1" ||
  problem "DOCS_HTTP_BIND must be 127.0.0.1; public traffic goes through TLS (compose.tls.yaml)"
host="$(get DOCS_PUBLIC_HOSTNAME)"
if [ -n "$host" ]; then
  if ! printf '%s' "$host" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'; then
    problem "DOCS_PUBLIC_HOSTNAME must be a fully qualified host name in lower case (not an address)"
  else
    case "$host" in
      localhost | *.localhost | *.local | *.test | *.example | *.invalid | example.com | *.example.com | example.org | *.example.org | example.net | *.example.net)
        problem "DOCS_PUBLIC_HOSTNAME is a reserved or example name; a certificate cannot be issued for it"
        ;;
      *) fine "DOCS_PUBLIC_HOSTNAME is a fully qualified name" ;;
    esac
  fi
  email="$(get DOCS_ACME_EMAIL)"
  if ! printf '%s' "$email" | grep -Eq '^[^@ ]+@([a-z0-9-]+\.)+[a-z]{2,63}$'; then
    problem "DOCS_ACME_EMAIL must be an e-mail address (the ACME account contact)"
  else
    case "${email#*@}" in
      example.com | example.org | example.net | *.example | *.invalid) problem "DOCS_ACME_EMAIL uses an example domain" ;;
      *) fine "DOCS_ACME_EMAIL set" ;;
    esac
  fi
  ca="$(get DOCS_ACME_CA)"
  case "$ca" in
    '') fine "ACME directory: the default, Let's Encrypt production" ;;
    https://*) fine "ACME directory set" ;;
    *) problem "DOCS_ACME_CA must be an https:// ACME directory" ;;
  esac
else
  fine "no DOCS_PUBLIC_HOSTNAME: direct TLS not configured (compose.tls.yaml refuses to start without it)"
fi

# 6. On the server itself.
if [ "$on_host" -eq 1 ]; then
  config_dir="$(get DOCS_CONFIG_DIR)"
  for f in api.env postgres.env redis.env operator.env backup.env offsite.env monitoring.env tenants.json operator-tenants.json; do
    path="$config_dir/$f"
    if [ ! -f "$path" ]; then
      problem "$f is missing from DOCS_CONFIG_DIR"
      continue
    fi
    mode="$(stat -c %a "$path")"
    case "$mode" in
      600 | 400) fine "$f present, mode $mode" ;;
      *) problem "$f is mode $mode; secrets must be 0600 (catalogues 0400)" ;;
    esac
    if grep -qE '<[^>]*>' "$path"; then
      problem "$f still holds a placeholder"
    fi
  done
  backup_dir="$(get DOCS_BACKUP_DIR)"
  if [ -d "$backup_dir" ]; then
    [ "$(stat -c '%u %a' "$backup_dir")" = "70 700" ] && fine "backup volume owned by uid 70, mode 0700" ||
      problem "DOCS_BACKUP_DIR must be owned by uid 70 with mode 0700"
    [ "$(stat -c %d "$backup_dir")" != "$(stat -c %d /var/lib/docker 2>/dev/null || stat -c %d /)" ] &&
      fine "backup volume is a separate filesystem" ||
      problem "DOCS_BACKUP_DIR is on the same filesystem as Docker's data; mount a separate volume"
  else
    problem "DOCS_BACKUP_DIR does not exist"
  fi
  state_dir="$(get DOCS_OFFSITE_STATE_DIR)"
  [ -d "$state_dir" ] && [ "$(stat -c '%u %a' "$state_dir")" = "70 700" ] &&
    fine "off-server copy state directory ready" ||
    problem "DOCS_OFFSITE_STATE_DIR must exist, owned by uid 70, mode 0700"
fi

echo
if [ "$problems" -eq 0 ]; then
  echo "deploy.env check: nothing wrong"
else
  echo "deploy.env check: $problems problem(s)"
fi
exit $((problems > 100 ? 100 : problems))
