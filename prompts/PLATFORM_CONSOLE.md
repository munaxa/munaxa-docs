# Platform Console — access & hosting

The **Platform Console** (Munaxa employees: subscriptions, billing, upgrade reviews,
feature overrides, platform audit) is **not a separate application**. It is a set of
permission-gated routes inside the existing **Admin Portal** (`apps/admin`), under
`/platform/console/*`. School users never see it, because the nav and the API routes are
gated by `platform:*` permissions that only a **Platform role** carries.

## 1. Create the first platform login

There is no seeded employee account. Bootstrap one (idempotent):

```bash
# DATABASE_URL must point at your DB (the restricted munaxa_app role is fine — the
# script sets the platform RLS context itself).
PLATFORM_OWNER_EMAIL=you@munaxa.com \
PLATFORM_OWNER_PASSWORD='Str0ngPassw0rd!' \
pnpm --filter @munaxa/api db:seed:platform-owner
```

What it does: seeds the permission catalog, provisions the global Platform roles
(`tenantId = NULL`), ensures the reserved platform "home" tenant exists (owns employee
user rows; never a customer school and excluded from every console listing), then creates
the user and links the **Platform Owner** role.

Optional env: `PLATFORM_OWNER_ROLE` (default `PlatformOwner`; any of `PlatformOwner`,
`PlatformAdmin`, `PlatformFinance`, `PlatformSupport`, `PlatformSales`, `PlatformReadOnly`),
`PLATFORM_OWNER_FIRST_NAME`, `PLATFORM_OWNER_LAST_NAME`.

## 2. Log in

Go to the Admin Portal **`/login`** and sign in with that email + password. **Leave the
school / tenant field blank** — platform staff aren't scoped to a school. Once in, the
sidebar shows the **Platform** section (Platform Console, Schools, Subscriptions, Upgrade
Requests, Audit). The bootstrap password is a bcrypt hash that verifies immediately and is
transparently upgraded to scrypt on first login.

## 3. Two domains, one deployment (`app.munaxa.com` + `admin.munaxa.com`)

Best practice for an internal back-office console is to separate it from the customer app at
the **host** boundary — different origins isolate session cookies and let you lock the console
host down independently. You do NOT need two deployments: one admin service with two custom
domains is enough, and a host-based middleware (`apps/admin/src/middleware.ts`) enforces the split:

| Host | Serves | Blocks |
|------|--------|--------|
| `app.munaxa.com` (`NEXT_PUBLIC_APP_HOST`) | School Admin Portal | `/platform/*` → redirects to `/` |
| `admin.munaxa.com` (`NEXT_PUBLIC_CONSOLE_HOST`) | Platform Console (`/platform/*`) | everything else → redirects to `/platform/console` |

Auth pages (`/login`, `/change-password`, `/forgot-password`) and the `/api` proxy are shared.
The sidebar mirrors the split, showing only the relevant sections per host. If neither host var
is set, the app runs in single-domain mode (everything on one domain), which is the local-dev and
default behavior. **The middleware is UX/hardening — the API still enforces every permission
server-side (permissions + RLS + audit) regardless of host.**

### Render setup
1. **DNS** — `CNAME app → <admin host>`, `CNAME admin → <admin host>` (same target), and
   (recommended) `api → <api host>`.
2. **Admin service** — add both `app.munaxa.com` and `admin.munaxa.com` under Custom Domains
   (Render issues a cert for each). Set these **build-time** env vars (inlined → redeploy to change):
   - `NEXT_PUBLIC_API_URL=https://api.munaxa.com/api/v1`
   - `NEXT_PUBLIC_APP_HOST=app.munaxa.com`
   - `NEXT_PUBLIC_CONSOLE_HOST=admin.munaxa.com`
3. **API service** — set `CORS_ORIGINS=https://app.munaxa.com,https://admin.munaxa.com` (both
   origins, comma-separated) and redeploy.

The admin reverse-proxies `/api/v1/*` to the API (`apps/admin/next.config.mjs`), so the httpOnly
session + CSRF cookies stay first-party on each host — and because the two hosts are different
origins, their cookie jars are isolated automatically.

> Prefer a single shared domain for now? Leave `NEXT_PUBLIC_APP_HOST` / `NEXT_PUBLIC_CONSOLE_HOST`
> unset and put everything on one domain — the console stays reachable but permission-gated.
> Later you can promote the console to its own deployment behind an IP allowlist / employee SSO;
> because the API is the enforcement boundary, that's a lift-and-shift, not a rewrite.
