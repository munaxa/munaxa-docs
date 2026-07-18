# Staging Deployment & Smoke Test — Munaxa Platform

This guide stands up the **core platform** (API + Admin + PostgreSQL) on a staging host so the
recently-added admin screens can be exercised end-to-end against a live database. It is grounded
in the repo's actual config: `docker-compose.yml`, `apps/api/.env.example`, `apps/admin/.env.example`,
`infra/postgres/app-role.sql`, and the Prisma scripts in `apps/api/package.json`.

> Landing (`munaxalanding`) and the demo (`munaxademo`) already deploy to Cloudflare and are out
> of scope here.

---

## 1. Architecture (what you're deploying)

| Service | What | Port | Image / build |
| --- | --- | --- | --- |
| **postgres** | PostgreSQL 16, the system of record (multi-tenant, RLS-enforced) | 5432 | managed (Neon/Supabase/RDS) or `postgres:16-alpine` |
| **api** | NestJS modular monolith (REST `/<prefix>/<version>`, default `/api/v1`) | 4000 | `apps/api/Dockerfile` |
| **admin** | Next.js 15 admin portal (calls the API over HTTPS) | 3000 | `apps/admin/Dockerfile` |
| redis | cache / rate-limit / queues | 6379 | managed or `redis:7-alpine` |
| (optional) S3 | receipts/documents (only if you exercise finance/e-invoicing uploads) | — | AWS S3 / R2 |

Redis and S3 are optional for a first smoke test; Postgres + API + Admin are the minimum.

---

## 2. The one thing that trips people up: two database roles

The API enforces Postgres **Row-Level Security**, so it connects at runtime as a **restricted,
NON-superuser, `NOBYPASSRLS`** role. Migrations run separately as the **privileged owner**. You
must configure **both** connection strings:

- `DIRECT_DATABASE_URL` → owner role (runs `prisma migrate deploy`). e.g. `munaxa` superuser.
- `DATABASE_URL` → restricted `munaxa_app` role (the running API). RLS applies to it.

`infra/postgres/app-role.sql` creates the `munaxa_app` role and grants it table/sequence
privileges. On `docker-compose` it auto-runs at first init; on a **managed** Postgres you run it
yourself (step 4).

---

## 3. Provision Postgres (managed — recommended for staging)

Using **Neon** or **Supabase** (free tiers fine for staging):

1. Create a project → you get an owner connection string (call it `OWNER_URL`).
2. Pick a strong app-role password and keep it for `DATABASE_URL`.

> Alternatively run `docker compose up -d postgres redis` on a VM — then `app-role.sql` and a
> ready `munaxa`/`munaxa_app` pair already exist from `docker-compose.yml`, and you can skip
> step 4's role creation.

---

## 4. Initialize the database (run once, from a machine with repo + Node 22 + pnpm)

```bash
pnpm install --frozen-lockfile
pnpm --filter @munaxa/api prisma:generate

# (a) Apply schema as the OWNER
DIRECT_DATABASE_URL="$OWNER_URL" \
DATABASE_URL="$OWNER_URL" \
pnpm --filter @munaxa/api prisma:deploy

# (b) Create the restricted app role + grants (managed DB only — compose does this automatically).
#     Edit the password in infra/postgres/app-role.sql first (it ships with a dev password),
#     or run an adapted version. Then:
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f infra/postgres/app-role.sql

# (c) Seed the GLOBAL permission catalog (required)
DATABASE_URL="$OWNER_URL" pnpm --filter @munaxa/api db:seed

# (d) Seed a demo tenant + admin login (for UAT/smoke test)
DATABASE_URL="$OWNER_URL" pnpm --filter @munaxa/api db:seed:demo
```

Step (d) prints and creates a ready login:

- **Tenant slug:** `demo`
- **Email:** `admin@demo.example`
- **Password:** `ChangeMe123!`  ← change after first login

> Seeds use the owner URL because they write across tenants. The running API uses the restricted
> URL (next step).

---

## 5. Deploy the API

Build context is the repo root (the Dockerfile is `apps/api/Dockerfile`). On Railway/Render/Fly,
point the service at that Dockerfile, then set env (from `apps/api/.env.example`):

```bash
NODE_ENV=production
PORT=4000
API_GLOBAL_PREFIX=api
API_VERSION=v1

# Runtime = restricted role; migrations already done in step 4.
DATABASE_URL=postgresql://munaxa_app:<app-password>@<host>:5432/<db>?schema=public
DIRECT_DATABASE_URL=<OWNER_URL>            # used only if you run migrate on deploy

REDIS_URL=redis://<host>:6379             # or omit if not running redis yet
CORS_ORIGINS=https://<your-admin-domain>  # MUST include the admin origin

JWT_ACCESS_SECRET=$(openssl rand -base64 48)
JWT_REFRESH_SECRET=$(openssl rand -base64 48)
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=2592000

# Optional for first smoke test (leave blank to no-op): S3, Resend, SMS, Sentry, e-invoicing.
EMAIL_FROM=no-reply@munaxa.app
```

Start command: `node dist/main.js` (the image's default / `start:prod`).
Health checks: `GET /api/v1/health/live` (liveness) and `GET /api/v1/health/ready` (readiness).
On boot the API logs its base URL, e.g. `Munaxa API listening on http://localhost:4000/api/v1`.

**Migrate-on-deploy (optional):** if you'd rather not run step 4(a) manually each release, add a
release/pre-deploy command `pnpm --filter @munaxa/api prisma:deploy` with `DIRECT_DATABASE_URL`
set to the owner URL.

---

## 6. Deploy the Admin

Dockerfile `apps/admin/Dockerfile`. Env (from `apps/admin/.env.example`) — note `NEXT_PUBLIC_*`
are **build-time** on Next.js, so set them before/at build:

```bash
NEXT_PUBLIC_API_URL=https://<your-api-domain>/api/v1
NEXT_PUBLIC_ENV=staging
# Firebase/PostHog/Sentry optional — login uses the API's own JWT, not Firebase.
```

Start: `next start -p 3000` (image default). Then attach a domain.

> ⚠️ Two cross-cutting gotchas:
> 1. `NEXT_PUBLIC_API_URL` is baked at **build** time — rebuild the admin image if it changes.
> 2. The API's `CORS_ORIGINS` must list the admin's exact origin or the browser calls will fail.

---

## 7. Smoke test (the point of all this)

1. Open `https://<admin-domain>` → sign in with tenant `demo`, `admin@demo.example` /
   `ChangeMe123!`. (You'll be prompted to change the password.)
2. Walk the screens shipped in PRs #52–#57 and confirm list + create round-trip to the DB:
   - **People:** Students, **Teachers**, **Parents**, **Employees (HR)** — add one of each.
   - **Academic structure:** pick school→campus → add a **grade**, a **section**, a **classroom**,
     an **academic year**, a **term**.
   - **Academics → Behavior:** pick a student → log a behavior record.
   - **Advanced:** **Library** (catalogue a book, check out/return), **Inventory** (item + IN/OUT
     movement), **Clinic** (record a visit, edit a medical record). These are **feature-flagged** —
     enable them first under **Modules**.
   - **Presence:** record a gate-in event for a student.
   - **Finance → Fee plans:** create a plan, toggle active.
3. Watch the API logs for 4xx/5xx. The most likely issues are **permission (403)** — the demo
   admin role may not hold every new permission (e.g. `presence:create`, `clinic:manage`) — and
   **CORS**. Note anything failing and I'll fix the contract/permission mapping.

A quick API-only check without the browser:

```bash
curl -sS -X POST https://<api>/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"identifier":"admin@demo.example","password":"ChangeMe123!","tenantSlug":"demo"}'
# → { accessToken, refreshToken, ... }   then call protected endpoints with the bearer token.
```

---

## 8. Hardening before real customers (not needed for the smoke test)

- Rotate all secrets; set `PASSWORD_BREACH_CHECK=1`; configure Sentry + log drains.
- Real email (Resend domain verified) and SMS provider for reminders.
- S3/R2 bucket + creds for receipts/documents.
- Backups + PITR on Postgres; restrict DB network access to the API.
- Per-tenant provisioning for real schools (the demo tenant is for UAT only).
- Load/perf test and a security review.

---

## CI/CD note — you may already have most of this automated

`.github/workflows/deploy.yml` runs **on every merge to `main`**: it builds & pushes the API and
admin images to GHCR, **applies database migrations**, and **deploys to staging** (production is a
manual, environment-gated `workflow_dispatch`). So once the workflow's environment secrets/targets
are configured, steps 4–6 here largely happen automatically on merge.

Practically: open that workflow and confirm its required secrets/variables (registry, DB URLs,
deploy target/host) are set for your `staging` environment. If they are, your job is mostly
**step 4(c)/(d)** (seed permissions + a demo tenant) and the **step 7 smoke test**. If they're not,
follow steps 4–6 to deploy manually the first time.

