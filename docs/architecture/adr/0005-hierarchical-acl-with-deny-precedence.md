# ADR-0005 — Inherited ACLs on the scope tree, with explicit deny winning

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

Enterprise document control needs both broad grants ("the quality team reads the quality library")
and narrow exceptions ("except the salary review folder"). Roles alone cannot express location;
per-object ACLs alone cannot be administered at scale.

The brief requires inheritance down
`Company → Entity → Department → Library → Folder → Document`, plus overrides.

## Decision

1. **Capability comes from roles** (`resource:action` permissions); **reach comes from ACL entries**
   on scope nodes. Both must be satisfied.
2. An ACL entry names a subject (user, role or department), a permission and an effect
   (`ALLOW`/`DENY`), on one scope node.
3. Resolution walks from the object up to the tenant. **Any matching `DENY` at any level wins**,
   regardless of how specific a lower `ALLOW` is.
4. **Closed by default**: no matching entry and no tenant-level role grant means denied.
5. A folder may set `inherit_acl = false` to stop the walk — but administrative permissions
   (`*:manage`, `audit:*`) are never blocked this way.

## Alternatives considered

1. **Most-specific-wins (nearest node decides)** — more expressive, but the answer to "why can this
   person see it?" requires simulating the whole tree. Deny-wins is auditable by inspection, which
   matters more in a compliance product than expressiveness.
2. **Roles only, no ACLs** — cannot express per-folder exceptions without a role per folder.
3. **ACLs only, no roles** — every new user needs a full ACL setup; administration collapses.
4. **Open by default within a library** — one misfiled document becomes a disclosure.

## Consequences

- A `DENY` is a blunt instrument and administrators must be told so: the UI shows, for any user and
  object, the **effective** permission and the **node that decided it**.
- Resolution is a single upward walk over materialised `ltree` paths, cached per
  `(user, scope, permission)` and invalidated by event.
- The same pure resolver computes the ACL fingerprint stored in the search index, so search results
  can never disagree with a direct read ([12](../12-search-architecture.md)).
- Breaking inheritance is audited (`INHERITANCE_BROKEN`) because it is the operation most likely to
  hide content from the people accountable for it.
