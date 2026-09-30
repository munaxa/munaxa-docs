#!/bin/sh
# Checks a running scanner container that probe.mjs has already accepted, beyond what a scan shows:
#
#   1. the image declares a non-root user, and no process in the container runs as root (real or
#      effective UID) — the container never starts as root;
#   2. the signature update still works as that user (freshclam, against the live volume);
#   3. no credential is in the image's history, filesystem or environment.
#
# Usage: verify-container.sh <container> <image>. Exit 0 only if every check holds.
set -eu
container=$1
image=$2
fail=0

user=$(docker inspect --format '{{.Config.User}}' "$image")
case "${user%%:*}" in
  '' | 0 | root) echo "FAIL - the image declares no non-root USER (got '$user')"; fail=1 ;;
  *) echo "OK - image USER $user" ;;
esac

# /proc rather than ps: the image carries no procps.
processes=$(docker exec "$container" sh -c '
  for status in /proc/[0-9]*/status; do
    name=$(sed -n "s/^Name:\t//p" "$status" 2>/dev/null) || continue
    uids=$(sed -n "s/^Uid:\t//p" "$status" 2>/dev/null) || continue
    echo "${status#/proc/} $name $uids"
  done')
echo "$processes" | sed 's#/status##; s/^/  pid /'
if echo "$processes" | awk '$3 == 0 || $4 == 0 { found = 1 } END { exit !found }'; then
  echo "FAIL - a process runs as root"; fail=1
else
  echo "OK - no process runs as root"
fi
for daemon in c-icap clamd; do
  echo "$processes" | awk -v d="$daemon" '$2 == d { found = 1 } END { exit !found }' \
    || { echo "FAIL - $daemon is not running"; fail=1; }
done

if docker exec "$container" freshclam --stdout >/dev/null 2>&1; then
  echo "OK - freshclam updates the signatures as $(docker exec "$container" id -un)"
else
  echo "FAIL - freshclam cannot update the signatures"; fail=1
fi

if docker history --no-trunc --format '{{.CreatedBy}}' "$image" \
     | grep -qiE 'ghp_|ghs_|github_pat_|_authToken=[A-Za-z0-9]|(password|secret|token)=[^ ]'; then
  echo "FAIL - a credential appears in the image history"; fail=1
elif docker exec "$container" sh -c 'find / -xdev \( -name .npmrc -o -name .netrc -o -name .git-credentials \) 2>/dev/null' | grep -q .; then
  echo "FAIL - a credential file is present in the image"; fail=1
elif docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | grep -qiE '^[^=]*(token|secret|password|passwd|key)[^=]*='; then
  echo "FAIL - the image environment names a credential"; fail=1
else
  echo "OK - no credentials in the image history, filesystem or environment"
fi

exit "$fail"
