# Organization module

**Answers:** Where in the organisation does this belong?

| | |
| --- | --- |
| **Owns** | Company, Entity, Branch, Department — the scope tree |
| **Depends on** | Identity |
| **Binds in core** | Nothing in core. It publishes scope-tree changes, which invalidate permission caches. |

## Layers

```text
organization/
├── organization.module.ts   composition for this module
├── domain/                    entities, value objects, pure rules, events — no Nest, no Prisma
├── application/               use cases and the ports this module declares
├── infrastructure/            Prisma repositories and adapters implementing those ports
└── presentation/              controllers, DTOs, OpenAPI decorators, view mappers
```

The dependency rule points inward, and it is enforced by `eslint.config.mjs` at the app root,
not merely described here. Other modules call this one through its **application service** or
react to its **events** — never through its repositories or its Prisma models.

## Events published

| Type | Meaning |
| --- | --- |
| `organization.department-moved` | Ancestry changed, so inherited permissions changed with it. |
| `organization.node-archived` | A node is retired; its libraries stay readable. |

## The tree

```text
TENANT ──▶ COMPANY ──▶ ENTITY ──▶ DEPARTMENT ──▶ DEPARTMENT ──▶ …
                          └──▶ BRANCH
```

**A branch is a location, not a level.** Its code appears in document numbers and a department
may sit at one, but permission does not flow through it — so it never appears in a scope chain.
Putting it in would give every ACL a level nobody ever grants on.

Departments nest. `department.path` materialises the ancestry — ancestor identifiers,
nearest-last, separated by `.` — so the two questions the ACL resolver asks are each one indexed
query rather than a climb:

| Question | How it is answered |
| --- | --- |
| What is the chain from the tenant down to this node? | One read for the node, one for the ancestors its path names |
| What sits at or below this node? | A prefix query on `(tenant_id, path)` |

`path` is derived data, written only by this module, rewritten for the whole subtree in the same
transaction as a move. Stored as `text` rather than `ltree`, for reasons and at a cost that
[ADR-0014](../../../../../docs/architecture/adr/0014-materialised-path-as-text.md) sets out.

The invariants live in `domain/scope-tree.ts` and are pure: path construction, containment,
subtree rewriting, a depth ceiling of 10, and the cycle checks that refuse a node as its own
parent or under one of its own descendants. Being pure is what lets them be tested exhaustively
without a database — and they decide who can see what, so that matters.

### The separator is load-bearing

`is at or below` means *equal, or begins with the ancestor's path followed by a separator*. A
bare prefix comparison would make `a.bc` a descendant of `a.b`, and an ACL granted on one
department would silently reach another. Both the pure check and the SQL prefix query are
asserted against that case.

## Phase 2 status

Both sides of the tree now exist.

The **read** side is `ORGANIZATION_SERVICE`: `scopeChainFor`, `exists` and `departmentsReachedBy`,
over the five tables this module owns. Provisioning creates a root company and entity, so the tree
is usable from the first sign-in.

The **write** side is `SCOPE_ADMIN_SERVICE` behind `org:manage` — create, edit, move, soft delete,
restore, search, sort, page and filter, for all four node kinds. Both events above are published now
that there is something to move and something to retire.

Three decisions in that write side are worth reading before changing it.

**A delete is refused, never cascaded.** A company with entities under it, a department with members
or children, cannot be removed; the API answers with the counts. Cascading would make "delete this
company" a one-click way to remove every department in it, and refusing with a number is what lets
somebody understand a reorganisation before performing it.

**Moving a department is its own endpoint.** It rewrites the materialised path of the whole subtree
in one statement and publishes `organization.department-moved`, because every ACL granted along the
old chain stops applying the moment it lands. That is not a field on an edit form.

**An entity's company cannot be changed.** Re-parenting an entity would move every branch,
department, library and document under it into another permission chain, silently — a change no
confirmation dialogue can honestly summarise. An entity created under the wrong company is deleted
and recreated while it is still empty.

The write side is also where `OrganizationNodeKind` comes from, and it is deliberately not
`ScopeType`: `ScopeType` has no `BRANCH`, because a branch is a location rather than a permission
level, and this module still has to create one.

## Tests

`scope-tree.spec.ts` covers the pure rules, which now re-export the shared path arithmetic in
`@edms/domain`'s `tree.ts` — three trees need identical answers to the same questions, and one of
them decides who can read what. `pnpm test:integration` covers what only a database
can answer: chain resolution through all four levels, that a prefix without a separator is not a
descendant, that another tenant's department resolves to an empty chain rather than a leak, the
partial unique indexes on `lower(code)` including reuse after soft delete, one primary department
per person, and that all five tables have `FORCE ROW LEVEL SECURITY` — which matters as much as
`ENABLE`, since without it the owning role bypasses its own policies and every other check passes
for the wrong reason. `scope-admin.integration.spec.ts` covers the write side: placement refusals,
subtree rewriting on a move, the dependent counts that block a delete, code reuse after a soft
delete, and optimistic-locking conflicts.
