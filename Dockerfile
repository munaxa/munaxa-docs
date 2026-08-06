# Munaxa Docs — the production images. Phase 18.
#
# One file, three targets: `api`, `web` and `worker`. 20 §2 says "the same images run on Render, a
# Kubernetes cluster or a customer's on-premise host; the differences are configuration" — so there
# is no build variant per environment and no `NODE_ENV` baked in beyond the one Next.js needs at
# compile time.
#
#   docker build --target api    --secret id=npmrc,src=$HOME/.npmrc -t munaxa-docs-api .
#   docker build --target web    --secret id=npmrc,src=$HOME/.npmrc -t munaxa-docs-web .
#   docker build --target worker --secret id=npmrc,src=$HOME/.npmrc -t munaxa-docs-worker .
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
# and both are large: LibreOffice is roughly 600 MB, Tesseract with Arabic data around 120 MB. They
# belong in the **worker** image of a deployment that wants them, which is why the worker target
# below takes them as a build argument rather than either always paying for them or never offering
# them. The API image has neither, and refuses honestly if configured for them.

# --- Build ------------------------------------------------------------------------------------
#
# `bookworm-slim` rather than Alpine. Prisma's query engine ships glibc and musl builds and the
# glibc one is the tested path; the OpenSSL version a Prisma binary is compiled against is the
# classic source of a container that builds and cannot connect.
FROM node:22-bookworm-slim AS build
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
RUN pnpm prisma:generate && pnpm build

# The production dependency tree, resolved separately from the build one. `--prod` drops the
# TypeScript compiler, the test runner and the linters — roughly two thirds of `node_modules` —
# and it is a second install rather than a prune because pnpm's store is content-addressed and
# pruning a symlinked tree in place is not a thing it supports.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    pnpm install --frozen-lockfile --prod --ignore-scripts \
 && pnpm prisma:generate

# --- The shared runtime base --------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# `dumb-init` because Node is a poor PID 1: it does not reap zombies and it does not forward
# signals to children, and 20 §4 requires workers to drain in-flight jobs before exiting — which
# they can only do if SIGTERM reaches them.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends dumb-init ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Node's own default heap is a fraction of the container's memory limit and it does not read the
# cgroup, so a container with a 1 GB limit runs a garbage collector sized for the host. Stated here
# and overridable, because the right value is the deployment's memory limit minus its headroom.
ENV NODE_OPTIONS=--max-old-space-size=768

# `node` is the image's own unprivileged user. Nothing in this product writes to its own filesystem
# except `STORAGE_DRIVER=LOCAL`, whose root is a mounted volume — so the image needs no writable
# layer and a read-only root filesystem is a supported way to run it.
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

# --- Web ---------------------------------------------------------------------------------------
FROM runtime AS web

COPY --from=build --chown=node:node /app/node_modules            ./node_modules
COPY --from=build --chown=node:node /app/packages                ./packages
COPY --from=build --chown=node:node /app/apps/web/.next          ./apps/web/.next
COPY --from=build --chown=node:node /app/apps/web/public         ./apps/web/public
COPY --from=build --chown=node:node /app/apps/web/node_modules   ./apps/web/node_modules
COPY --from=build --chown=node:node /app/apps/web/package.json   ./apps/web/
COPY --from=build --chown=node:node /app/apps/web/next.config.ts ./apps/web/

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start"]

# --- Worker ------------------------------------------------------------------------------------
#
# The one target that takes build arguments, and they are the two system packages this product can
# use and most deployments do not want. `OFFICE_DRIVER` and `OCR_DRIVER` still decide whether the
# binaries are *called*; these decide whether they are *present*, which is a property of the image
# rather than of the environment — an image without LibreOffice cannot be configured into having it.
FROM runtime AS worker
ARG WITH_LIBREOFFICE=false
ARG WITH_TESSERACT=false

USER root
RUN set -eux; \
    packages=""; \
    if [ "$WITH_LIBREOFFICE" = "true" ]; then packages="$packages libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu"; fi; \
    if [ "$WITH_TESSERACT" = "true" ]; then packages="$packages tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng"; fi; \
    if [ -n "$packages" ]; then \
      apt-get update && apt-get install --yes --no-install-recommends $packages && rm -rf /var/lib/apt/lists/*; \
    fi
USER node

COPY --from=build --chown=node:node /app/node_modules              ./node_modules
COPY --from=build --chown=node:node /app/packages                  ./packages
COPY --from=build --chown=node:node /app/prisma                    ./prisma
COPY --from=build --chown=node:node /app/apps/worker/dist          ./apps/worker/dist
COPY --from=build --chown=node:node /app/apps/worker/node_modules  ./apps/worker/node_modules
COPY --from=build --chown=node:node /app/apps/worker/package.json  ./apps/worker/

CMD ["node", "apps/worker/dist/main.js"]
