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

## Phase 8 — the resolver binds

`ACL_RESOLVER` is no longer the deny-all placeholder: this module now binds
`PrismaAclResolver`, resolving `08-permission-model.md` §3 over what genuinely exists — the
tenant-level role grant, closed by default. Search forced the seam: the index materialises
`acl_subjects` "computed by the same pure resolver the API uses", and a resolver that denies
everything cannot serve an index anybody may see. The subject vocabulary lives in
`domain/acl-subjects.ts` (typed `user:` / `role:` / `department:` / `grant:` tokens), and the
module is `@Global` for the same reason `AuditModule` is: the port is declared in `core/`,
whose own guard asks it, and core may not import a module to reach the implementation.

What has **not** changed: no `acl_entry` table, no walk, no deny precedence — there is still
nothing to grant *on a node*. The phase that builds grants extends this resolver and its
domain functions, re-projects the index, and changes nothing above the port. Until then a
folder's `inherit_acl` continues to be stored and never consulted, and the folder-delete
contents check keeps waiting for the phase that makes the consequence real.

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

### Phase 10 — the cascade reaches the documents

Until Phase 10 a folder's delete cascaded over *folders* and stopped there: the documents inside
stayed live in a deleted folder, reachable by search and by nothing else. ADR-0010 §3 always said
the cascade covers the subtree, and it now does — the same `deleteCascadeId` is stamped on the
folders, on the documents beneath them and on those documents' revisions, so one restore reverses
one delete across all three.

The documents are Document's rows, so Document does the work. The seam is `FolderContentsRegistry`
— a **registry** rather than an injected port, and it is the one place in the product where plain
DI could not express the inversion: Document already imports Library (a document sits in a folder),
so Library cannot import Document's module for a binding without a cycle. The registry breaks it
the way Preview's renderer registry does — Library declares the interface and holds the slot;
Document, which imports Library anyway, fills it in `onModuleInit`. The *call* still runs inside
Library's transaction, which is what a subtree delete that must be atomic requires and what an
outbox event could not have given it.

Unfilled, the registry deletes nothing and says nothing. That is honest rather than lax: a
composition with no documents in it genuinely has none to cascade to, which is exactly this
module's own integration suite.
