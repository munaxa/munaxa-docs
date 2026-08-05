# 16 — Frontend Architecture

**Purpose:** how the web application is structured — pages, modules, state, caching, performance.
**Audience:** frontend engineers and AI agents generating screens.

## 1. Stack and non-negotiables

Next.js 15 (App Router), React 19, TypeScript, Tailwind v4, `@munaxa/ui` with the `docs` theme.

| Rule | Source |
| --- | --- |
| Every component comes from `@munaxa/ui` or this product's `features/` — never a second button, card, table or dialog | [Rulebook §6–7](https://github.com/tam2om/munaxa/blob/main/PLATFORM_ENGINEERING_STANDARDS.md#6-reuse-and-duplication) |
| No hardcoded colour, spacing, radius, shadow or z-index — semantic token classes only | Rulebook §7 |
| Logical properties only (`ps-`, `me-`, `text-start`) — the product ships EN + AR with full RTL | Rulebook §7 |
| WCAG 2.2 AA at merge time | `platform/architecture/accessibility.md` |
| No app-local re-export barrel over the platform | Rulebook §4 |
| Every user-visible string from `@edms/i18n` | Rulebook §7 |
| The UI never decides permission — it renders the server's `capabilities` | [08](./08-permission-model.md) |

```css
/* app/globals.css */
@import 'tailwindcss';
@import '@munaxa/theme/css/docs';
@source '../../../../platform/ui';
```

## 2. Route structure

```text
app/
├── (auth)/                       login · forgot-password · mfa            (no shell)
└── (workspace)/                  authenticated shell: top bar, sidebar, command palette
    ├── page.tsx                  dashboard: my tasks, my documents, recent activity —
    │                             plus the tenant-wide panel, when the caller holds a tile's permission
    ├── inbox/                    approval tasks, delegations
    ├── libraries/
    │   └── [libraryId]/
    │       └── folders/[[...path]]/     folder browser (breadcrumb from the path)
    ├── documents/[documentId]/
    │   ├── page.tsx              overview: metadata, current revision, preview
    │   ├── revisions/            history, compare, restore
    │   ├── approvals/            workflow progress and decisions
    │   ├── permissions/          effective and explicit ACL
    │   └── audit/                the document timeline
    ├── search/                   results, facets, saved searches
    ├── notifications/            the notification centre: inbox, per-user preferences, quiet hours
    ├── reports/
    ├── admin/                    types · fields · numbering · workflows · retention ·
    │                             confidentiality · libraries · users · roles · settings
    └── recycle-bin/
```

Route groups map to shells, not to features. The document record page is a **tabbed record
workspace**: identity and actions stay fixed while tabs change, so a user never loses their place.

**`(auth)/mfa` is enrolment, not the challenge** — Phase 14. The challenge lives on the sign-in
form, and that is a decision rather than a shortcut: a challenge on its own page would need either
the password again or a short-lived token standing in for it, and that token is a credential with a
lifetime and a revocation story minted for one purpose — exactly the kind that gets reused. One post
spends the password and the code together and issues nothing until both are right. What the route
holds instead is setting a factor up, seeing how many recovery codes are left, and taking it away;
it sits under `(auth)` because it is about getting in rather than about working, and the shell
around it has no navigation for somebody who may have just been told their account is at risk.

**`documents/[documentId]/permissions/` exists** — Phase 14, and it is a mitigation rather than a
convenience. ADR-0005 accepted deny-precedence on the grounds that it is auditable by inspection and
wrote the price down as a requirement: the UI shows, for any user and object, the effective
permission and the node that decided it. It renders two tables — what this node says, and what one
person actually holds here — deliberately not merged, because an administrator looking at a single
editable matrix deletes a row believing it was the grant when the grant is four levels above. The
chain renders whether or not anything is broken, because an over-broad `ALLOW` is loud and a `DENY`
that inherits too far is silent.

**The administrator dashboard is a panel on `page.tsx`, not a screen under `admin/`** — Phase 13.
`admin/` is where somebody *configures* the tenant, and a page of counts configures nothing; an
administrator is also a person with drafts and an inbox, and putting the tenant's health one
navigation away from their own work means they see one of the two. Each tile is gated individually on
the API against the permission that already governs the screen it summarises, and a tile the caller
may not see is **absent rather than zero** — those are different answers, and collapsing them would
make the first screen everybody opens a daily report on how much exists in the parts of the tenant
they cannot see into. No navigation row was added: `nav.home` already pointed here.

`notifications/` was added by Phase 12 and is deliberately **outside `admin/`**. 18 §5's
preferences are per *user* — which channels, which digest, which quiet hours — and Administration
is where somebody configures the tenant. Notification **templates** genuinely are tenant
configuration, and they live at `admin/notification-templates` instead: an override changes the
words everybody in the tenant is told, and the only thing that would otherwise separate the two
surfaces is a permission check somebody can forget to add.

## 3. Feature modules

```text
features/<feature>/
├── components/      presentational, composed from @munaxa/ui
├── hooks/           data hooks wrapping the typed client
├── queries/         query keys, fetchers, cache configuration
├── schemas/         zod schemas re-exported from @edms/contracts
└── index.ts         the feature's public surface
```

Features: `documents`, `revisions`, `approvals`, `libraries`, `permissions`, `search`, `audit`,
`admin-*`, `reports`, `notifications`. A feature imports the platform, `@edms/*` packages and its
own files — **never another feature's internals**. Shared cross-feature pieces move to `features/shared/`
only on the third consumer ([rule of three](https://github.com/tam2om/munaxa/blob/main/PLATFORM_ENGINEERING_STANDARDS.md#6-reuse-and-duplication)).

## 4. Data and state

| State | Held by |
| --- | --- |
| Server data | TanStack Query — the single cache for everything the API owns |
| URL state (filters, page, tab, selection) | The URL. A filtered list must be shareable and restorable |
| Ephemeral UI state | `useState` in the owning component |
| Cross-cutting session state (user, tenant, locale, theme) | One context provider, set on the server |
| Forms | React Hook Form + the zod schema from `@edms/contracts` — one validation definition, both sides |

**No global client store.** Redux-shaped state for server data is the most common source of stale
UI in systems like this; the query cache is the source of truth and invalidation is explicit.

Rendering split: **server components for reads** (folder listing, document overview, audit timeline
— fetched on the server with the caller's session), **client components for interaction** (upload,
editors, approval actions, preview viewer).

### Cache policy

| Data | Staleness | Invalidated by |
| --- | --- | --- |
| Folder tree, libraries | 5 min | Folder or library mutation |
| Document detail | 30 s | Any action on the document |
| Approval inbox | 15 s + refocus refetch | Deciding a task, notification arrival |
| Search results | Never cached across queries; keyset pages cached per query | New search |
| Admin configuration | 10 min | The corresponding admin mutation |
| Preview artefacts | Immutable URLs, cached hard | Never (content-addressed) |

Mutations invalidate by query key, not by refetching the world. Optimistic updates are used only for
reversible, low-risk actions (tag add, favourite) — never for approvals, publishing or deletion,
where the server's answer is the only truth worth showing.

## 5. Key screens

| Screen | Composition |
| --- | --- |
| Folder browser | Platform data grid + tree, virtualised, keyboard navigable, drag-select, bulk actions gated by `capabilities` |
| Document overview | Header (number, title, status, revision), preview pane, metadata panel, action panel from `capabilities` |
| Revision history | Timeline with compare selection; compare view shows metadata diff, text diff and page diff |
| Approval inbox | Task list with deadline emphasis, inline decide with mandatory comment where the stage requires it |
| Workflow progress | Platform `approval-flow` component driven by the instance's stages |
| Permissions tab | Effective permissions with the inheritance chain shown — *why* a user has access, not just that they do |
| Search | Query bar with field syntax, facet rail, keyset "load more", saved searches |
| Admin | Configuration forms with live preview — notably the numbering rule builder rendering a sample number as it is edited |

## 6. Uploads

Direct-to-storage with presigned URLs ([11](./11-storage-architecture.md)): request a target, PUT
with progress, then complete. Large files use multipart with per-part retry; the UI survives a
refresh by persisting the session id, and cancelling aborts the upload rather than just hiding the
progress bar.

## 7. Performance

| Technique | Applied to |
| --- | --- |
| Server components + streaming | Record pages: shell first, preview and audit stream in |
| Route-level code splitting | Admin and reports are never in the main bundle |
| Virtualisation | Any list that can exceed 100 rows |
| Lazy preview | First page immediately, further pages on demand |
| Prefetch on intent | Hovering a document prefetches its overview |
| Image optimisation | Thumbnails via WebP at fixed sizes; no client-side resizing of originals |
| Budget | Initial JS ≤ 200 KB gzipped for the workspace shell; LCP < 2.5 s on a mid-range laptop over 4G |

## 8. Accessibility and internationalisation

- Full keyboard operation of the folder browser, document actions and approval decisions; visible
  focus from the theme's own focus ring; a skip link on every page.
- Every action affordance has an accessible name that includes its object ("Approve QMS-…-0042").
- Status is never colour alone — icon plus text.
- EN + AR catalogues, RTL verified per screen, dates and numbers formatted per locale, and Arabic
  document titles rendered with correct bidirectional handling beside Latin document numbers.

## Phase 3 — the document workspace

The first feature outside Administration, and it keeps every rule that section established: reads in
server components, writes in server actions, no browser-side API client, URL state as the only state.

One thing is genuinely new, and it is the exception the rules always anticipated. **The upload
transfers bytes from the browser directly to storage**, over a presigned URL — not through a server
action. That is not a hole in "no browser-side API client": the URL carries no session, names one
object and expires in minutes, and it is what keeps a 2 GB drawing out of a framework whose request
bodies are bounded in megabytes. The token stays in its `httpOnly` cookie; what leaves the server is
a capability for one object.

The transfer itself uses `XMLHttpRequest` rather than `fetch`, for the one reason `XMLHttpRequest`
is still the right tool: `fetch` has no upload progress, and a 2 GB upload with no progress bar is
the outcome on a real fraction of machines.

**Reuse rather than fork.** The library's list is `ResourceList` from `admin-shared`, unchanged: a
document list is searched, sorted, paged, soft-deleted, restored and has a recycle bin, which is
exactly what that component is. The metadata form is composed from the same field set, with one
addition — `TextField` grew a `date` type — so a tenant-configured `SELECT` behaves like a
hand-written one.

**The one form whose shape is data.** `MetadataFields` renders a document type's fields from its
definition, and the mapping from data type to control is exhaustive by the compiler: a new
`MetadataDataType` is a build error rather than a field that silently renders as text.
