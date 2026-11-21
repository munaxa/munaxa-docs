# Munaxa Docs — the production images. Phase 18.
#
# One file, four targets: `api`, `web`, `worker` and `migrate`. 20 §2 says "the same images run on Render, a
# Kubernetes cluster or a customer's on-premise host; the differences are configuration" — so there
# is no build variant per environment and no `NODE_ENV` baked in beyond the one Next.js needs at
# compile time.
#
#   docker build --target api    --secret id=npmrc,src=$HOME/.npmrc -t munaxa-docs-api .
#   docker build --target web    --secret id=npmrc,src=$HOME/.npmrc -t munaxa-docs-web .
#   docker build --target worker --secret id=npmrc,src=$HOME/.npmrc -t munaxa-docs-worker .
#   docker build --target migrate --secret id=npmrc,src=$HOME/.npmrc -t munaxa-docs-migrate .
#
# ## The credential, and why it is a build secret
#
# `@munaxa/*` is published to GitHub Packages, so the install needs a `read:packages` token. It is
# mounted with `--secret` rather than passed as `--build-arg`: a build argument is recorded in the
# image's history and is readable by anybody who can `docker history` it, which is the ordinary way
# a registry token leaks. The mount exists only for the layer that uses it.
#
# ## What is deliberately not in here
#
# **No `sharp`, no `@pdf-lib/fontkit`, no `ldapjs`, no `cbor`.** Phases 7, 16 and 17 each named a
# capability blocked on one of those, and every one is a *lockfile* change rather than a Dockerfile
# change — `pnpm install --frozen-lockfile` would refuse a package the lockfile does not name, and
# it must refuse, because an image whose dependency set differs from the one CI tested is an image
# nothing has tested. The Phase 18 report shows the command that establishes the constraint and
# names what lifts it. A base image with the libraries pre-installed would look like progress and
# change nothing: the blocker has never been the operating system.
#
# **No LibreOffice and no Tesseract.** Both are real system packages this product can use —
# `OFFICE_DRIVER=LIBREOFFICE` and `OCR_DRIVER=TESSERACT` shell out to them by a configured path —
# and both are large: LibreOffice is roughly 600 MB, Tesseract with Arabic data around 120 MB. No
# image here carries them. The code that calls them is in the API (`libreoffice.converter.ts`,
# `tesseract-ocr.adapter.ts`), and every consumer runs in the API process (`apps/worker/src/main.ts`),
# so the worker build arguments that used to install them put binaries where nothing called them.
# The API image has neither, and refuses honestly if configured for them. An image that carries an
# engine is a separate, scanned target to design when a deployment needs one (docs/operations/
# deployment.md).

# --- Base images ---------------------------------------------------------------------------------
#
# The release images (api, web, migrate) are Alpine (musl) since 20 Nov 2026. The Debian 12
# userland they carried before (glibc 2.36, gcc-12 runtime libraries, OpenSSL 3.0.22) scans, in the
# CI image scan of that day (Grype), with 1 CRITICAL (glibc CVE-2026-5450) and 11 HIGH findings,
# most marked "won't fix" by Debian for bookworm and one (glibc CVE-2026-84243, gettext) affecting
# every glibc release, so no Debian base, 12 or 13, clears them. musl has none of that code.
#
# The base is the one Munaxa Identity, Control, Work and School ship: node:22-alpine (Node 22.23.5,
# Alpine 3.24.4) as published on 11 Nov 2026, pinned by digest, with zlib 1.4-r0 (CVE-2026-4738) and
# libssl3/libcrypto3 3.5.9-r1 (4 HIGH in 3.5.9-r0, fixed in Alpine's 3.5.9-r1), exact versions so a
# rebuild either takes the same packages or fails.
#
# Prisma ships musl engines (`linux-musl-openssl-3.0.x`), the lockfile already carries the musl
# builds of every native package the workspace installs (Next.js's SWC, sharp, unrs-resolver,
# esbuild's static binary), and the build runs on the same libc it ships, so `pnpm install` selects
# them. CI's images, migration-image and release-smoke jobs run all three images against real
# PostgreSQL, Redis, object storage and the antivirus scanner.
#
# Since 20 Nov 2026 (later the same day) the worker is on the same runtime: it carried the Debian userland only for the
# optional LibreOffice and Tesseract packages, which nothing in the worker calls (see above).
ARG NODE_IMAGE=node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

FROM ${NODE_IMAGE} AS alpine
# The split is the point: `apk list -I <name>` prints `<name>-<version> <arch> ...` and $1 is the first word.
# hadolint ignore=SC2046
RUN apk add --no-cache 'zlib=1.4-r0' 'libssl3=3.5.9-r1' 'libcrypto3=3.5.9-r1' && \
    for want in zlib=1.4-r0 libssl3=3.5.9-r1 libcrypto3=3.5.9-r1; do \
      name="${want%%=*}" && set -- $(apk list -I "$name" 2>/dev/null) && installed="${1#"$name"-}" && \
      if [ "$installed" != "${want#*=}" ]; then \
        echo "$name is '$installed', expected ${want#*=}" >&2; exit 1; \
      fi; \
    done

# --- Build ------------------------------------------------------------------------------------
FROM alpine AS build
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# The manifests first, so a change to source does not re-resolve the dependency graph. Every
# workspace member's manifest has to be present or pnpm resolves a different graph from the one the
# lockfile describes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json      apps/api/
COPY apps/web/package.json      apps/web/
COPY apps/worker/package.json   apps/worker/
COPY packages/domain/package.json    packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/i18n/package.json      packages/i18n/
COPY packages/utils/package.json     packages/utils/
COPY prisma/schema.prisma prisma/

RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    pnpm install --frozen-lockfile

COPY . .

# `turbo` by its own path rather than through `pnpm build`, and the reason is a race rather than a
# preference. pnpm exports its resolved configuration to child processes as `pnpm_config_*`
# environment variables, and it serialises them as strings — so `verify-deps-before-run`, whose
# default is the boolean `false`, reaches every nested pnpm as the string `"false"`, which is
# truthy. Each of those children therefore re-runs `checkDepsStatus`, which reads
# `node_modules/.pnpm-workspace-state-v1.json` with `readFileSync` + `JSON.parse` and rewrites it
# with a non-atomic `writeFile`. Turbo builds nine packages concurrently, so a reader can observe a
# half-written file and the build dies with `Unexpected end of JSON input` — intermittently, which
# is the worst way for a required check to fail. Invoking turbo directly means no pnpm parent, so
# no child inherits the setting and nothing touches the file. `apps/web`'s `prebuild` hook was the
# other source of a nested pnpm and now calls its binary directly for the same reason.
RUN pnpm prisma:generate && ./node_modules/.bin/turbo run build

# ## The image carries its development dependencies, and that is a stated cost
#
# The obvious next step is `pnpm install --prod` to drop the compiler, the test runner and the
# linters — roughly two thirds of the tree. It does not work here, and the reason is worth
# recording rather than rediscovering: `prisma` is a development dependency, the generated client
# is produced by it, and a `--prod` tree has neither the generator nor a way to run it. Generating
# first and pruning after is not available either — pnpm's store is content-addressed and its
# node_modules is a symlink farm, so there is nothing to prune in place.
#
# What that costs is image size and a larger dependency surface in the runtime image. What the
# alternatives cost is worse: copying a generated client between two independently resolved trees
# is a version skew waiting to happen, and `pnpm deploy` for a workspace needs flags whose
# behaviour differs between pnpm minors. The honest fix is a build that generates the client into
# a location the prod tree can carry, and it is named in the Phase 18 report rather than half-done
# here.

# --- The runtime filesystem ---------------------------------------------------------------------
#
# The API, web and migrate images run Node and nothing else, so they carry an Alpine userland of
# exactly what Node and its native modules load: musl, libgcc and libstdc++, OpenSSL 3 (Prisma's
# `linux-musl-openssl-3.0.x` engines link libssl.so.3 and libcrypto.so.3), zlib, the CA bundle,
# `dumb-init`, and alpine-release for /etc/os-release. No shell (no busybox), no package manager
# (no apk-tools), no util-linux and no setuid program.
#
# `apk add --root` installs the packages, signature-checked against the keys in the pinned image,
# into an empty root with their package database (lib/apk/db/installed), so scanners see every
# package and version that is present. `node` is the binary of the same pinned image the build
# stage uses, so the image runs the Node release the build was tested with.
#
# `dumb-init` because Node is a poor PID 1: it does not reap zombies and it does not forward
# signals to children, and 20 §4 requires workers to drain in-flight jobs before exiting — which
# they can only do if SIGTERM reaches them.
FROM alpine AS runtime-fs
RUN mkdir -p /rootfs/etc/apk /rootfs/tmp /rootfs/home/node /rootfs/usr/local/bin \
 && cp -r /etc/apk/keys /rootfs/etc/apk/keys \
 && apk add --no-cache --root /rootfs --initdb --no-scripts --repositories-file /etc/apk/repositories \
      alpine-release musl 'zlib=1.4-r0' libgcc libstdc++ 'libssl3=3.5.9-r1' 'libcrypto3=3.5.9-r1' \
      ca-certificates-bundle dumb-init \
 && rm -rf /rootfs/etc/apk/keys /rootfs/var/cache/apk \
 && printf 'root:x:0:0:root:/root:/sbin/nologin\nnode:x:1000:1000::/home/node:/sbin/nologin\nnobody:x:65534:65534:nobody:/:/sbin/nologin\n' > /rootfs/etc/passwd \
 && printf 'root:x:0:\nnode:x:1000:\nnobody:x:65534:\n' > /rootfs/etc/group \
 && cp /etc/services /etc/protocols /rootfs/etc/ \
 && cp /usr/local/bin/node /rootfs/usr/local/bin/node \
 && chmod 1777 /rootfs/tmp \
 && chown 1000:1000 /rootfs/home/node \
 && test -z "$(find /rootfs -xdev -type f -perm /6000)" \
 && test ! -e /rootfs/bin/sh && test ! -e /rootfs/bin/busybox && test ! -e /rootfs/sbin/apk \
 && test -e /rootfs/lib/ld-musl-x86_64.so.1 && test -s /rootfs/etc/ssl/certs/ca-certificates.crt \
 && test -x /rootfs/usr/bin/dumb-init && test -s /rootfs/lib/apk/db/installed \
 && chroot /rootfs /usr/local/bin/node -e 'require("crypto").createHash("sha256"); require("zlib").gzipSync("x")'

# --- The shared runtime base --------------------------------------------------------------------
FROM scratch AS runtime
COPY --from=runtime-fs /rootfs/ /
WORKDIR /app

ENV PATH=/usr/local/bin:/usr/bin:/bin
ENV NODE_ENV=production
# Node's own default heap is a fraction of the container's memory limit and it does not read the
# cgroup, so a container with a 1 GB limit runs a garbage collector sized for the host. Stated here
# and overridable, because the right value is the deployment's memory limit minus its headroom.
ENV NODE_OPTIONS=--max-old-space-size=768

# `node` (uid 1000) is the image's own unprivileged user. Nothing in this product writes to its own
# filesystem except `STORAGE_DRIVER=LOCAL`, whose root is a mounted volume — so the image needs no
# writable layer and a read-only root filesystem is a supported way to run it.
USER node
ENTRYPOINT ["dumb-init", "--"]

# --- API ---------------------------------------------------------------------------------------
FROM runtime AS api

COPY --from=build --chown=node:node /app/node_modules            ./node_modules
COPY --from=build --chown=node:node /app/packages                ./packages
COPY --from=build --chown=node:node /app/prisma                  ./prisma
COPY --from=build --chown=node:node /app/scripts                 ./scripts
COPY --from=build --chown=node:node /app/infra/sql               ./infra/sql
COPY --from=build --chown=node:node /app/apps/api/dist           ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/node_modules   ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json   ./apps/api/

EXPOSE 3001
# Liveness touches no dependency, by design: a readiness probe wired here would restart every pod
# during a database incident and turn a degradation into an outage (`health.controller.ts`).
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]

# --- Migrate (DC-01) ----------------------------------------------------------------------------
#
# The one-off migration image: `scripts/migrate-tenants.mjs` — the per-database SQL, `prisma migrate
# deploy`, the post-migration SQL and a final `prisma migrate status` — for the database (or the
# catalogue of databases) its environment names. The hosted Docs runs it as the `docs-migrate` task
# before `docs-provision` and before any API rollout; it is never a service.
#
# ## Why a separate image, not the API image
#
# The API image runs `node` and nothing else, and its migration runner used to need pnpm — so a
# release had to migrate "from a checkout" and the hosted Docs had no way to migrate at all. This
# target is the same `runtime` base (no shell, no package manager, uid 1000) with the same
# `node_modules` the API was built with, so the Prisma CLI, its engines and the generated client are
# the lockfile's, byte for byte; plus only what migrating reads: `prisma/` (schema and migration
# history), `infra/sql/` (the per-database and post-migration SQL) and the three migration scripts.
# The API image is unchanged by its existence.
#
# ## The schema engine its runtime asks for
#
# The query engine is pinned by `binaryTargets` (`prisma/schema.prisma`); the schema engine is not
# something a schema can pin, so this stage makes sure the CLI holds the `linux-musl-openssl-3.0.x`
# one for the Prisma version the lockfile already resolved (`PRISMA_CLI_BINARY_TARGETS`). On the
# Alpine build stage that is already the native engine, so this normally downloads nothing; if it
# does, the CLI fetches it from Prisma's engine CDN for the engine commit that version names and
# checks it against a SHA-256 served from the same place, so a rebuild trusts that CDN; what runs
# is fixed by the published image digest, not by a rebuild. CI and the release smoke ask the image
# the same question the deployment does: run it.
#
# ## What it needs at run time
#
# `DATABASE_MIGRATION_URL` (the owner role; the ECS task injects it from the `docs-migrate` secret
# bundle) — or `TENANT_CATALOGUE`/`TENANT_CATALOGUE_PATH` with migration URLs for several tenants.
# Nothing is baked in: no URL, no credential, no catalogue. It writes nothing to its own filesystem,
# so it runs with a read-only root filesystem and no capabilities.
FROM build AS migrate-engines
ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x
RUN node node_modules/prisma/build/index.js version >/dev/null \
 && find node_modules/.pnpm -name 'schema-engine-linux-musl-openssl-3.0.x' -type f | grep -q .

FROM runtime AS migrate

COPY --from=migrate-engines --chown=node:node /app/node_modules              ./node_modules
COPY --from=build           --chown=node:node /app/package.json              ./package.json
COPY --from=build           --chown=node:node /app/prisma                    ./prisma
COPY --from=build           --chown=node:node /app/infra/sql                 ./infra/sql
COPY --from=build           --chown=node:node /app/scripts/migrate-tenants.mjs    ./scripts/
COPY --from=build           --chown=node:node /app/scripts/apply-post-migrate.mjs ./scripts/
COPY --from=build           --chown=node:node /app/scripts/migration-support.mjs  ./scripts/

# No update check, no telemetry, nothing cached: the task has no business calling out.
ENV CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

# The migration task is not a server: no port, no health check. Its exit status is the result.
CMD ["node", "scripts/migrate-tenants.mjs"]

# --- Web ---------------------------------------------------------------------------------------
FROM runtime AS web

COPY --from=build --chown=node:node /app/node_modules            ./node_modules
COPY --from=build --chown=node:node /app/packages                ./packages
# `public/` holds only the brand artwork `munaxa-sync-brand` copies out of `@munaxa/platform` in the
# web's `prebuild` (git-ignored, never authored here). The pages reference it by URL: the favicon
# and the logo lockups under `/branding/docs/`. Without it every one of them was a 404 (STG-12).
COPY --from=build --chown=node:node /app/apps/web/public         ./apps/web/public
COPY --from=build --chown=node:node /app/apps/web/.next          ./apps/web/.next
COPY --from=build --chown=node:node /app/apps/web/node_modules   ./apps/web/node_modules
COPY --from=build --chown=node:node /app/apps/web/package.json   ./apps/web/
COPY --from=build --chown=node:node /app/apps/web/next.config.ts ./apps/web/
COPY --from=build --chown=node:node /app/apps/web/server.mjs     ./apps/web/

WORKDIR /app/apps/web
EXPOSE 3000
# `next start` with the browser's address resolved in front of it — see the header of `server.mjs`.
CMD ["node", "server.mjs"]

# --- Worker ------------------------------------------------------------------------------------
#
# The same `runtime` as the API (scratch, musl, no shell, no package manager, uid 1000) with the
# worker's build output. It loads nothing native (NestJS, BullMQ, ioredis), and today it composes no
# consumer: they all run in the API process (`apps/worker/src/main.ts`). It used to be the one Debian
# image, and the one with build arguments, so that LibreOffice and Tesseract could be installed into
# it; nothing in the worker calls either, and the Debian userland scanned with a CRITICAL glibc
# finding that no Debian release fixes. CI builds it, starts it and scans it like the release images;
# no workflow publishes it.
FROM runtime AS worker

COPY --from=build --chown=node:node /app/node_modules              ./node_modules
COPY --from=build --chown=node:node /app/packages                  ./packages
COPY --from=build --chown=node:node /app/apps/worker/dist          ./apps/worker/dist
COPY --from=build --chown=node:node /app/apps/worker/node_modules  ./apps/worker/node_modules
COPY --from=build --chown=node:node /app/apps/worker/package.json  ./apps/worker/

CMD ["node", "apps/worker/dist/main.js"]
