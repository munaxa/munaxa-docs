# Phase 0.5 — technical debt

**Purpose:** everything the skeleton leaves owing, with an owner and a trigger.
**Audience:** whoever starts Phase 1.
**Status:** point-in-time record, 2026-08-03. Historical once Phase 1 begins — do not edit it
to reflect later work; supersede it.

Nothing here is a defect in what was built. Each entry is a deliberate boundary of Phase 0.5,
recorded so it is chosen rather than discovered.

| # | Debt | Why it exists | Cost of leaving it | Cleared by |
| --- | --- | --- | --- | --- |
| 1 | **`pnpm-lock.yaml` is not updated for the new workspace members** | The lockfile can only be regenerated with a registry credential for `@munaxa/*` on GitHub Packages, which the authoring environment did not have. Every other check was verified against the real platform packages, built from source | CI's `pnpm install --frozen-lockfile` fails until someone runs `pnpm install` with a `read:packages` token and commits the result | **Before merge.** One command; see the note under the table |
| 2 | **No initial migration** | `prisma migrate dev` needs a live database; the schema is authored and validated, the SQL is not generated | The foundation tables do not exist until someone runs it | Phase 1, first task |
| 3 | **`/login` does not exist, and typed routes are off** | The shell and the edge middleware both redirect to it; writing a placeholder screen to satisfy the type checker would look finished and be nothing | An unauthenticated visit lands on the not-found page instead of a sign-in form. `experimental.typedRoutes` stays `false` until routes exist | Phase 1 (authentication screens); re-enable typed routes in the same commit |
| 4 | **Ports are bound to adapters that refuse** | Storage, OCR, mail, antivirus and preview have no vendor implementation. Each fails naming the environment variable that would configure it, and production refuses to boot on `NONE` | Nothing that needs a provider works, loudly | Phase 3 (storage), 7 (preview), 8 (search/OCR), 12 (notification) |
| 5 | **Authorization denies everything** | `DenyAllAclResolver` stands in until Library binds the real resolver; `NoIssuerTokenVerifier` rejects every token until Identity binds the real one | Nothing behind the guards is reachable — the correct posture, and the reason both defaults point at refusal | Phase 1 (Identity), Phase 3 (Library) |
| 6 | **The outbox has no dispatcher implementation** | The contract, the table and the queue definitions exist; the loop that claims rows and enqueues them does not | No asynchronous work runs | Phase 1, with the first event |
| 7 | **No integration or end-to-end tests** | There is nothing to integrate yet: no repository implementation, no endpoint. The structure, the port doubles and the factories are in place | Coverage is unit-level only | Phase 1, with the first repository and the first endpoint |
| 8 | **`@edms/i18n` holds only shell strings** | Feature strings arrive with features; inventing them now would produce a catalogue nobody translated against a screen | — | Continuously, per phase |
| 9 | **Metrics and tracing are ports without an exporter** | Which backend a deployment scrapes is an operational decision, and binding one now would make it an architectural one | No telemetry leaves the process | Phase 18 (production readiness), or earlier if staging needs it |
| 10 | **Audit table is not yet partitioned** | Monthly range partitioning is designed (`05-database-design.md` §7) but partitioning an empty table adds a migration Phase 1 would have to work around | None until volume arrives; retrofitting later is a rewrite of the table | Phase 9 (audit & compliance) |

## Clearing #1

```bash
pnpm config set "//npm.pkg.github.com/:_authToken" "$GITHUB_TOKEN"   # needs read:packages
pnpm install                                                        # updates pnpm-lock.yaml
git add pnpm-lock.yaml && git commit -m "build: resolve the lockfile for the Phase 0.5 workspace"
```

The credential is deliberately never written to the committed `.npmrc` — pnpm refuses to
expand environment variables in auth settings from a committed file, precisely so a pull
request cannot repoint them at an attacker-controlled registry.

## What is *not* debt

Worth stating, because each of these looks like an omission and is a decision:

- **Empty `domain/`, `infrastructure/` and `presentation/` folders in every module.** Each
  module's `README.md` states what it owns and which phase fills it. A stub entity or a
  placeholder controller would have to be deleted before the real one could be written.
- **No seed data.** Roles, document types, numbering rules and confidentiality levels are
  tenant configuration, and seeding them is Phase 2's job — with the admin screens that let a
  tenant change them.
- **No `Security` module.** Security is cross-cutting and lives in `core/`; the data behind
  each decision belongs to the module that owns it. See
  [`apps/api/src/modules/README.md`](../../apps/api/src/modules/README.md).
