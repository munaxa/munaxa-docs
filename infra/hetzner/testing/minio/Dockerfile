# MinIO for the Hetzner template's local/CI test stack ONLY. Never part of a TEST or production
# deployment: production object storage is an external S3-compatible service (ADR-0026 §6).
#
# Built from source for the reason `.github/workflows/ci.yml` gives at "Build the object store from
# its pinned source": every prebuilt MinIO (Docker Hub, quay.io, dl.min.io) has been withdrawn or put
# behind authentication. The release tags and their peeled commits are the same pins CI uses, so this
# stack and the integration suite assert against one MinIO, and the build stops if a tag is moved.
FROM golang:1.24-bookworm AS build
ARG MINIO_TAG=RELEASE.2025-09-07T16-13-09Z
ARG MINIO_COMMIT=07c3a429bfed433e49018cb0f78a52145d4bedeb
ARG MC_TAG=RELEASE.2025-08-13T08-35-41Z
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096
RUN set -eu; \
    build() { \
      git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$2" "https://github.com/minio/$1" "/src/$1"; \
      actual="$(git -C "/src/$1" rev-parse HEAD)"; \
      if [ "$actual" != "$3" ]; then echo "minio/$1 tag $2 now points at $actual, not the pinned $3" >&2; exit 1; fi; \
      (cd "/src/$1" && CGO_ENABLED=0 go build -trimpath -o "/out/$1" .); \
    }; \
    build minio "$MINIO_TAG" "$MINIO_COMMIT"; \
    build mc "$MC_TAG" "$MC_COMMIT"

FROM debian:bookworm-slim
COPY --from=build /out/minio /out/mc /usr/local/bin/
RUN useradd --system --uid 1001 --home-dir /data minio && mkdir /data && chown minio /data
USER minio
EXPOSE 9000
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--address", ":9000"]
