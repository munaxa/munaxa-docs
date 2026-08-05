# ADR-0016 — An inheritance break truncates the chain, for both effects

- **Status:** Accepted
- **Date:** 2026-08-06
- **Phase:** 14

## Context

[ADR-0005](./0005-hierarchical-acl-with-deny-precedence.md) states five rules. Four of them are
unambiguous and Phase 14 implemented them as written. The fifth is one sentence:

> A folder may set `inherit_acl = false` to stop the walk — but administrative permissions
> (`*:manage`, `audit:*`) are never blocked this way.

"Stop the walk" has two readings, and until this phase nothing had to choose between them because
`acl_entry` held no rows and `folder.inherit_acl` had no reader.

1. **Stop granting.** Entries above the break stop *allowing*, and a `DENY` above it still applies.
2. **Stop resolving.** The chain the decision is made over begins at the breaking folder, and
   nothing above it — allow, deny, or the tenant-level role grant of §3 step 6 — contributes.

The difference is not academic. Under reading 1 a folder that "does not inherit" still inherits half
of what is above it, and an administrator looking at the folder has no way to discover which half.

A second question the ADR does not settle: `08 §7` requires list endpoints to filter "by a
permission predicate pushed into SQL — never fetch-then-filter". The search index already had a
shape for that — two arrays of opaque subject tokens, compared by the engine
([12 §3](../12-search-architecture.md)) — but a relational list has no such column. It has
`document`, `folder.path` and `folder.library_id`, and something has to turn a walk into a `WHERE`
over those.

## Decision

1. **A break truncates the chain, for both effects.** The effective chain for a permission the break
   applies to begins at the *deepest* breaking folder on the object's ancestry. Entries above it are
   not collected, and neither is the tenant-level role grant. Below a break, only entries at or
   below the breaking folder grant anything.

2. **The break's exemption is `survivesBrokenInheritance()`** in `@edms/domain` — `*:manage` and
   `audit:*` — which was written in Phase 1 and had no caller until now. For those permissions the
   chain is never truncated.

3. **`VisibilityFilter` carries regions as well as subject tokens.** A region is a container the
   caller reaches — the whole tenant, a set of libraries, a folder path, a set of documents —
   together with the folder subtrees excluded from it because a break sits between its node and
   them. The predicate a consumer builds is `(any allowed region) AND NOT (any denied region)`.
   Both shapes are produced by **one** resolution, in one call, so the index and a relational list
   can no more disagree than the index and a direct read can.

4. **Organisation nodes are resolved to libraries inside the resolver.** An `ALLOW` on a department
   reaches the libraries beneath it; that expansion happens once, where the scope tree already is,
   rather than in every list that filters.

## Alternatives considered

1. **Reading 1 — the break stops allows only.** More conservative in the sense that it can only ever
   subtract, and rejected for that exact reason: it makes the flag a one-way valve whose behaviour
   an administrator cannot read off the screen. "This folder does not inherit permissions" would be
   false, and the true statement — "this folder does not inherit *grants* but does inherit
   *refusals*" — is not something a checkbox can say. Deny-precedence stays what §3 says it is: a
   rule about the entries on the chain. The break decides what the chain *is*.

2. **Materialising an ACL fingerprint on `document`, as the search index does.** It would make the
   list predicate a single column comparison and it was rejected on invalidation: the index is
   rebuilt asynchronously and is allowed to lag, because a stale search result is corrected the
   moment somebody opens it. A stale column on `document` would be the *authoritative* answer, and
   an ACL change would have to rewrite every affected row inside the administrator's transaction
   before the change could be considered applied.

3. **Raw SQL for the list predicate.** A hand-written `EXISTS` over `acl_entry` per row is the
   textbook shape and is one query per row in disguise; a lateral join is not, but it would make
   `prisma-document.repository.ts` the only place in the product where the scope tree is expressed
   in SQL rather than through Prisma, with the walk stated a second time.

## Consequences

- **A break with no entries beneath it hides its subtree from everybody except administrators.**
  That is the intended behaviour and it is the sharpest edge this model has, so it is audited
  (`INHERITANCE_BROKEN`, ADR-0005's own requirement) and the permissions screen renders the chain
  with the break marked whether or not anybody has asked about a person.
- The regions are computed per `(caller, permission)` and cached with the decisions, under one
  tenant prefix, so a single ACL edit invalidates both.
- A caller whose entries exceed `ACL_MAX_SUBJECT_ENTRIES` degrades **closed**: the tenant-wide allow
  is dropped and every deny that was read is kept.
- The permissions screen must render the chain, not only the answer — otherwise a truncated walk is
  indistinguishable from a missing grant, and the two are fixed in different places.
