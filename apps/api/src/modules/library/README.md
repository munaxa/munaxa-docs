# Library module

**Answers:** Where do documents live, and who may reach into that place?

| | |
| --- | --- |
| **Owns** | Library, Folder, ACL entries on both |
| **Depends on** | Organization, Administration |
| **Binds in core** | `ACL_RESOLVER` — the ACL entries live here, so the resolution algorithm lives with them. |

## Layers

```text
library/
├── library.module.ts   composition for this module
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
| `library.created` | A new governed container exists under an organisation node. |
| `library.folder-moved` | Ancestry changed; inherited permissions and search ACL fingerprints change with it. |
| `library.acl-changed` | Invalidates the permission cache and re-fingerprints affected index entries. |

## Phase 3 — documents live in it now

Phase 2 built the place. Phase 3 fills it, and two things about this module changed as a result.

`LIBRARY_ADMIN_SERVICE` is **exported**, because Document resolves a folder through it before every
create and every move. That is a call to this module's application service, which is the only legal
direction — never into `folder`, which is the tree the ACL resolver walks and therefore the one
table a second reader would be a second opinion about who can see what.

`library.folder-moved` now carries a real `documentCount`. It was zero through Phase 2 because
nothing could be in a folder.

What has **not** changed: a folder delete still refuses nothing on account of its contents, because
ACLs do not exist yet and a folder with documents in it is not yet a folder with permissions on it.
That check belongs with the phase that makes the consequence real.

## Phase 2 status

**The place exists; nothing lives in it yet.** No document upload in Phase 2 — what this phase builds
is the container a document will belong to and the tree its permissions will be granted on.
`library.created` and `library.folder-moved` are published; `library.acl-changed` waits for ACLs.

`LIBRARY_ADMIN_SERVICE`, behind `library:manage` and `folder:manage`, owns both resources.

### A library and its root folder are one fact

They are written in one transaction. A library with no root is a library whose permissions have
nothing to attach to and whose contents have nowhere to go, so `Library.rootFolderId` is nullable in
the schema and never null in practice — both rows are inserted before the transaction commits.

The root folder cannot be moved, renamed away or removed. It is where the library's own permissions
attach, and a library with two roots or none is not a library.

### Neither owner-scope field may be edited

A library belongs to exactly one organisation node, and `LIBRARY_OWNER_SCOPES` deliberately excludes a
branch: permission does not flow through a location. `TENANT` carries no identifier at all — the tenant
is implicit, taken from the token, and naming it in a body is the one thing the isolation guard rejects
outright.

Re-homing a library would move every folder and document in it into a different permission chain:
every ACL along the old chain silently stops applying and every one along the new chain silently
starts. No confirmation dialogue can honestly summarise that, so there is no endpoint for it. A library
created in the wrong place is deleted while it is empty.

### Deleting a folder takes its subtree, and a restore takes exactly that subtree back

The cascade stamps every row it touches with a `deleteCascadeId`. Restoring reverses *that* cascade
rather than un-deleting everything currently deleted underneath the folder — which would resurrect
folders somebody removed on purpose weeks earlier, and would do it silently.

Folders use the same materialised-path arithmetic as departments and categories, from `@edms/domain`'s
`tree.ts`, with a depth ceiling of 32. Names are unique among live siblings, case-insensitively: two
folders differing only by case are indistinguishable to everyone except the database.
