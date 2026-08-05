# Feature modules

```text
features/<feature>/
├── <resource>-screen.tsx   the screen, a client component composed from @munaxa/ui
├── <sub>-editor.tsx        a controlled sub-editor the screen owns — segments, stages, a matrix
├── actions.ts              'use server' — the writes, one per endpoint
└── index.ts                the feature's public surface, where it has consumers
```

The shape a feature takes follows how it gets its data. A feature whose reads happen in **server
components** — every administration feature — has no `hooks/` or `queries/`: there is no client-side
query to key or cache, because the page fetched the rows before the screen rendered. A later feature
that genuinely polls or subscribes will grow those directories, and the two shapes coexisting is
correct rather than untidy.

A feature imports the platform, the `@edms/*` packages and its own files — **never another
feature's internals**, which `eslint.config.mjs` enforces. A shared piece moves to
`features/shared/` on its *third* consumer, not its second: extracting earlier produces an
abstraction shaped by two accidents.

Planned features, one per capability the workspace exposes: `audit`, `reports` and
`notifications`. Each arrives with the phase that builds
its screens ([16-frontend-architecture.md](../../../../docs/architecture/16-frontend-architecture.md)
§3).

## Built: the administration set

| Feature | Screens |
| --- | --- |
| `admin-shared` | The machinery the others compose: the list, the form dialogue, the field set |
| `admin-organization` | Companies, entities, branches, departments |
| `admin-identity` | Users, roles, the permission catalogue |
| `admin-configuration` | Confidentiality levels, metadata fields, categories, document types, retention policies, numbering rules, tenant settings |
| `admin-libraries` | Libraries and their folder trees |
| `admin-workflows` | Workflow definitions and their versions |

## Built: the document workspace

| Feature | Screens |
| --- | --- |
| `documents` | The library — tree, list, upload, scan intake, document properties, recents |

It reuses `admin-shared` rather than forking it: the list *is* `ResourceList`, because a document
list is searched, sorted, paged, soft-deleted, restored and has a recycle bin. The metadata form is
composed from the same field set, with one addition — `TextField` grew a `date` type — so a
tenant-configured `SELECT` behaves like a hand-written one.

The one genuinely new shape is `metadata-fields.tsx`, which renders a form whose *shape is data*: a
document type declares its fields and the mapping from data type to control is exhaustive by the
compiler, so a new `MetadataDataType` is a build error rather than a field that silently renders as
text.

**The upload is the one place bytes do not go through a server action**, and that is the design
rather than an exception to it. The browser PUTs straight to storage over a presigned URL that
carries no session, names one object and expires in minutes — which is what keeps a 2 GB drawing out
of a framework whose request bodies are bounded in megabytes. The access token never leaves the
server.

## Built: search

| Feature | Screens |
| --- | --- |
| `search` | The search screen — query bar with field syntax, facet rail, keyset "load more", saved and recent searches |

The one shape worth noticing: pagination is a **keyset cursor**, so only the first page lives
in the URL; further pages are appended through a server action (`continueSearch`), because a
cursor names "after what I have" and putting it in the URL would make refresh show page four
alone. Highlights arrive as segmented spans and are rendered as text — never as markup. A hit
whose content is still being extracted says so (`contentPending`), and an OCR-read hit is
badged as an inference, the same honesty rule the preview viewer follows.

`admin-shared` is the `features/shared/` of the README's rule, and it earned the place: every export
in it has between four and eighteen consumers. Three shapes are genuinely repeated —
`ResourceList` (toolbar, grid, row menu, the delete and restore confirmations), `FormDialog` over a
real `<form>`, and the field set that wires each control to a label and a `name`.

**Forms are deliberately not shared.** A company's form is two fields and a workflow's is a stage
editor; a component that tried to describe both would either constrain the second or become a form
framework. Each screen composes its own dialogue and hands the create and edit affordances to
`ResourceList` as callbacks.

## How a screen is put together

Reads happen in **server components**, writes in **server actions**, and there is no browser-side
API client at all — the access token lives in an `httpOnly` cookie and adding one would mean handing
it to a script ([17-security-architecture.md](../../../../docs/architecture/17-security-architecture.md)
§2). A page fetches; a screen renders. That split is what makes the URL the source of truth for which
rows are shown, and what makes the first paint the right page rather than an empty grid that fills in.

A server action is an HTTP endpoint, so each one parses its input against the same
`@edms/contracts` schema the API uses. The API validates again; that is not redundant. This one is
what lets a form name the wrong field before a request is made, and the API's is what protects the
data.

Two rules hold for every one of them:

- **The UI never decides a permission.** It renders the `capabilities` object the server
  returned with the resource.
- **URL state is state.** Filters, page, tab and selection live in the URL, so a filtered list
  is shareable and survives a reload.
