# ADR-0014 — The scope tree's ancestry is a materialised path stored as `text`

- **Status:** Accepted
- **Date:** 2026-08-03
- **Phase:** 1

## Context

[ADR-0005](./0005-hierarchical-acl-with-deny-precedence.md) makes every authorisation decision a
walk of the scope tree: TENANT → COMPANY → ENTITY → DEPARTMENT, with departments nesting inside
departments, and an explicit deny anywhere in that chain winning. The resolver therefore asks two
questions constantly:

1. **What is the chain from the tenant down to this node?** — once per authorisation decision, on
   the hot path of every request that touches a document.
2. **What sits at or below this node?** — whenever a person's department membership is expanded, or
   an ACL granted on a parent has to reach the departments under it.

Answering either by following `parent_id` is one query per level. At the depth a real organisation
reaches — company, entity, division, department, sub-department — that is four to six round trips
inside a permission check that must not be noticeable.

The department subtree is the only genuinely recursive part of the tree. Company and entity are
fixed levels, and a branch is a *location* rather than a level: its code appears in document
numbers and a department may sit at one, but permission does not flow through it, so it never
appears in a chain.

## Decision

1. `department.path` stores the **materialised ancestry**: the identifiers of every ancestor,
   nearest-last, with the department itself at the end, separated by `.` — `«quality».«docs».«records»`.
   A root department's path is its own identifier.
2. The column is **`text`**, not `ltree`, and the prefix queries are ordinary `LIKE 'prefix.%'`
   served by the `(tenant_id, path)` btree index.
3. The separator is **part of every comparison**. `is at or below` means *equal, or begins with the
   ancestor's path followed by a separator* — never a bare prefix.
4. `path` is **derived data maintained by the application**, written whenever a department is
   created or moved, and rewritten for the whole subtree in the same transaction as the move.
5. The invariants live in one pure module (`apps/api/src/modules/organization/domain/scope-tree.ts`)
   with a depth ceiling of **10**, and cycle checks that refuse a node as its own parent or under
   its own descendant.

## Alternatives considered

1. **`ltree`** — purpose-built for exactly this, with GiST-indexed ancestor operators, and the
   obvious choice on paper. Rejected because it is an extension: it requires `CREATE EXTENSION` at
   install time, which several managed PostgreSQL offerings and most customer-controlled on-premise
   databases will not grant, and because `ltree` labels are restricted to alphanumerics and
   underscores — UUIDs contain hyphens, so every identifier would need encoding on the way in and
   decoding on the way out. The cost is paid at every boundary; the benefit is a query plan we
   already get from a btree. If the tree ever outgrows this, `ltree` is a migration, not a rewrite:
   the data is already in the right shape.
2. **Recursive CTE over `parent_id`** — no derived data to maintain and no way to be inconsistent,
   which is a real advantage. Rejected for the hot path: it is a per-request recursive plan on the
   check that gates every document read, and it is the one query we cannot afford to have degrade
   as a customer's org chart grows.
3. **Closure table** — one row per ancestor/descendant pair. Exact, fast in both directions, and
   the standard answer for trees that are queried far more than they are written. Rejected as
   disproportionate: it is a second table to keep in step, and a move rewrites O(subtree ×  depth)
   rows instead of O(subtree). The scope tree is small and shallow; a document folder tree might
   deserve this, and this ADR does not bind that decision.
4. **`path` as a `uuid[]`** — array containment is indexable and there is no separator to get
   wrong. Rejected because the prefix semantics we need (*strictly ordered* ancestry, not set
   membership) are awkward to express, and array-slice comparison is less obvious to a reader than
   a string prefix.

## Consequences

- **A subtree is one indexed query**, and a chain is one read plus a lookup of the ancestors the
  path names. Both are what the ACL resolver needs.
- **`path` can be wrong.** It is denormalised, so an incorrect write silently changes who can see
  what. Three things contain that: it is written only by the module that owns it, never by hand; a
  move rewrites the whole subtree inside one transaction, because a half-moved subtree leaves nodes
  unreachable and nodes reachable twice; and both properties are asserted against a real database
  in `organization.integration.spec.ts`, including that a shared prefix without a separator is *not*
  a descendant.
- **Depth is capped at 10.** Not arbitrary: every resolution walks the chain and every move rewrites
  the subtree. A tree deeper than this is nearly always a modelling mistake — a department per
  person — and the cost of discovering that in production is a query that degrades for everyone.
- **Codes are unique per parent scope, case-insensitively, ignoring deleted rows** — partial unique
  indexes on `lower(code)`, so deleting a department does not burn its code forever
  ([ADR-0010](./0010-soft-delete-and-retention.md)).
- The identifiers in a path are UUIDs, which contain no `.`, so **nothing needs escaping**. That
  holds only while identifiers are UUIDs; changing the identifier scheme means revisiting this.
- Related: [05 — Database Design](../05-database-design.md) §8,
  [ADR-0005](./0005-hierarchical-acl-with-deny-precedence.md).
