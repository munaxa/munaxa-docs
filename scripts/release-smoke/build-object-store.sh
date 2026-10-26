#!/usr/bin/env bash
# Builds the object store (MinIO) and its client from their pinned release tags, as the CI
# integration job does (see its "Build the object store from its pinned source" step for why from
# source). Fails if a tag no longer points at the pinned commit.
#
#   build-object-store.sh <directory>   -> <directory>/bin/{minio,mc}
set -euo pipefail
root="$1"
build() {
  local repo="$1" tag="$2" commit="$3" out="$4"
  local src="$root/src/$repo"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "https://github.com/minio/$repo" "$src"
  local actual
  actual="$(git -C "$src" rev-parse HEAD)"
  if [ "$actual" != "$commit" ]; then
    echo "::error::minio/$repo tag $tag now points at $actual, not the pinned $commit"
    exit 1
  fi
  (cd "$src" && CGO_ENABLED=0 go build -trimpath -o "$out" .)
}
mkdir -p "$root/bin"
build minio RELEASE.2025-09-07T16-13-09Z 07c3a429bfed433e49018cb0f78a52145d4bedeb "$root/bin/minio"
build mc RELEASE.2025-08-13T08-35-41Z 7394ce0dd2a80935aded936b09fa12cbb3cb8096 "$root/bin/mc"
