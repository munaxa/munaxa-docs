# Dependency advisories

CI runs `pnpm audit --audit-level high` on every pull request: a new high or critical advisory in
any dependency, development tooling included, fails the build. Fix one by upgrading the package
that brings it in. An override in the root `package.json` (`pnpm.overrides`) is acceptable only when
a parent pins the vulnerable version so that no compatible upgrade of the parent exists; every
override is listed here with the reason and the condition for removing it.

## Overrides

| Override | Parent that pins it | Remove when |
| --- | --- | --- |
| `multer` → `^2.5.0` | `@nestjs/platform-express` 11 pins `multer` 2.4.0 | Nest platform-express ships ≥ 2.5.0 |
| `deepmerge-ts` → `^8.0.2` | `@prisma/config` 6 depends on `deepmerge-ts` 7 | Prisma's config package moves to 8 |
| `postcss` → `^8.5.25` | `next` 15 pins `postcss` 8.4.31 | Next.js stops pinning a vulnerable PostCSS |
| `js-yaml@5.3.0` → `^5.4.1` | `@nestjs/swagger` 11 pins `js-yaml` 5.3.0 | Nest swagger ships ≥ 5.4.1 |
| `vite` → `^7.3.7` | Vitest's automatically installed `vite` peer stays at its locked version | Any lockfile refresh lands Vite ≥ 7.3.7 for Vitest |

## Remediation log

### 2026-10-29 — every advisory on `main`

`pnpm audit` on `main` reported 66 advisories (6 critical, 29 high, 26 moderate, 5 low). After this
change it reports none.

- **Next.js** `^15.1.6` → `^15.5.28` (`apps/web`): three unauthenticated remote-code-execution
  advisories and a Server Components denial of service. Its `sharp` now resolves to 0.35.5.
- **Zod** `^3.24.1` → `^4.6.7` (`apps/api`, `apps/web`, `packages/contracts`): memory exhaustion on
  oversized input; there is no fixed 3.x. Migration: `z.record` takes its key schema explicitly,
  and the two records keyed by an enum (`savedSearchFiltersSchema`, `capabilitiesSchema`) are
  `z.partialRecord`, keeping Zod 3's "any subset of the keys" meaning — Zod 4's `record` over an
  enum would require every key. Issue paths are stringified before joining (they may hold symbols).
- **Vitest** `^3.0.5` → `^4.1.12` (every package): critical `tinypool` prototype pollution, the
  Vitest UI file-read advisory, and `vite`/`@vitest/mocker`. Two specs adjusted for Vitest 4's
  types (a typed `vi.fn`, and a fixture built without `TextEncoder`). The web e2e project's
  `poolOptions.forks.singleFork` — removed in Vitest 4, and ignored with only a deprecation line —
  becomes `maxWorkers: 1` with `isolate: false`; without it each e2e file ran in a fresh process,
  every suite shared one Redis database and sign-in budget, and the eleventh sign-in was refused.
- **Express** `5.2.1` → `5.3.0` (`apps/api`): critical `proxy-addr` IP spoofing, `body-parser`
  and `qs` denial of service.
- **jsdom** `^30.0.1` → `^30.1.3` (`apps/web`): its `undici` now resolves to 8.12.x (TLS
  validation, cache poisoning, denial of service).
- **Transitive, refreshed within their ranges**: `brace-expansion`, `nanoid`, `source-map-js`,
  `sharp`, `body-parser`, `@nestjs/*` (11.x).
- **Overrides** as listed above.
