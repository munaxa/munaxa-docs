#!/usr/bin/env bash
# Installs Terraform 1.16.5 into ~/tf after verifying HashiCorp's signature on the checksum file and
# the archive's checksum. For AWS CloudShell, before a bootstrap plan
# (docs/operations/bootstrap-plan-runbooks.md). Touches nothing in AWS.
#
#   bash scripts/bootstrap/install-terraform.sh   then   export PATH="$HOME/tf:$PATH"
set -euo pipefail

TF=1.16.5
# HashiCorp Security signing key (https://www.hashicorp.com/trust/security).
FINGERPRINT=C874011F0AB405110D02105534365D9472D7468F

case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64) arch=arm64 ;;
  *) echo "STOP: unsupported CPU $(uname -m)"; exit 1 ;;
esac

dir="$HOME/tf"
mkdir -p "$dir"
cd "$dir"
base="https://releases.hashicorp.com/terraform/${TF}"
curl -fsSLO "$base/terraform_${TF}_linux_${arch}.zip"
curl -fsSLO "$base/terraform_${TF}_SHA256SUMS"
curl -fsSLO "$base/terraform_${TF}_SHA256SUMS.sig"

# A throwaway keyring with a short path (gpg-agent sockets have a path-length limit).
GNUPGHOME=$(mktemp -d)
export GNUPGHOME
trap 'gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
curl -fsSL https://www.hashicorp.com/.well-known/pgp-key.txt | gpg --batch --quiet --import
# The signature must be valid AND made by HashiCorp's key, identified by its full fingerprint.
if ! gpg --batch --status-fd 1 --verify "terraform_${TF}_SHA256SUMS.sig" "terraform_${TF}_SHA256SUMS" 2>/dev/null \
     | grep -Eq "^\[GNUPG:\] VALIDSIG [0-9A-F]+ .* ${FINGERPRINT}\$|^\[GNUPG:\] VALIDSIG ${FINGERPRINT} "; then
  echo "STOP: the checksum file is not signed by HashiCorp (${FINGERPRINT})."
  exit 1
fi
grep " terraform_${TF}_linux_${arch}.zip\$" "terraform_${TF}_SHA256SUMS" | sha256sum -c - \
  || { echo "STOP: the Terraform archive does not match its signed checksum."; exit 1; }

unzip -oq "terraform_${TF}_linux_${arch}.zip" terraform
rm -f "terraform_${TF}_linux_${arch}.zip"
version=$("$dir/terraform" version -json | jq -r .terraform_version)
[ "$version" = "$TF" ] || { echo "STOP: installed Terraform reports $version, not $TF."; exit 1; }
echo "PASS: Terraform $TF installed in $dir (signature and checksum verified)."
echo "Run:  export PATH=\"$dir:\$PATH\""
