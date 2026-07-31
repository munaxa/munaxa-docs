# ADR-0001 — The Munaxa Docs product root is `edms/`

- **Status:** Accepted (pending owner confirmation — see Consequences)
- **Date:** 2026-07-31
- **Phase:** 0

## Context

The repository names products for what they do: `school/`, `work/`, and — per the root README's
product table — **Docs**, whose theme (`platform/themes/docs/`) is already authored but which has
no product root.

`docs/` at the repository root is already taken: it holds the repository-wide documentation index
(`docs/README.md`), which every document in the repository links to, and the Phase prompts
(`docs/docs prompts/`). Creating the product at `docs/` would either overwrite that index or force
the product's own documentation into `docs/docs/`.

Phase 0 must place its ~30 documents somewhere, and Phase 0.5 will place code under the same root.

## Decision

The product root is **`edms/`**, a peer of `school/` and `work/`. Its documentation lives in
`edms/docs/`, matching `school/docs/`. The theme keeps its existing name, `docs`.

## Alternatives considered

1. **Take over `docs/`** — move the repository index to a root `DOCUMENTATION.md` and free `docs/`
   for the product. Rejected for Phase 0: it renames a path referenced by the root README, the
   engineering standards and dozens of documents, and that is a repository-wide change the owner
   should approve on its own merits rather than as a side effect of designing a product.
2. **`munaxadocs/`** — unambiguous but breaks the short-name convention `school/` and `work/` set.
3. **`docs-product/`** — no collision, but reads as scaffolding rather than a product.

## Consequences

- No existing path moves; no inbound link breaks. Phase 0 is additive.
- Folder name and theme name differ (`edms/` vs `docs`). This is the cost, and it is documented in
  the product README and the root README's product table.
- **This is the one Phase 0 decision worth confirming before Phase 0.5.** Renaming a documentation
  tree is cheap; renaming it after `@edms/api`, `@edms/web` and a Prisma schema exist is not. If
  the owner prefers alternative 1, the change is a directory move plus a link sweep, and this ADR
  is superseded rather than edited.
