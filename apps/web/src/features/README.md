# Feature modules

```text
features/<feature>/
├── components/   presentational, composed from @munaxa/ui
├── hooks/        data hooks wrapping the typed client
├── queries/      query keys, fetchers, cache configuration
├── schemas/      zod schemas re-exported from @edms/contracts
└── index.ts      the feature's public surface
```

A feature imports the platform, the `@edms/*` packages and its own files — **never another
feature's internals**, which `eslint.config.mjs` enforces. A shared piece moves to
`features/shared/` on its *third* consumer, not its second: extracting earlier produces an
abstraction shaped by two accidents.

Planned features, one per capability the workspace exposes: `documents`, `revisions`,
`approvals`, `libraries`, `permissions`, `search`, `audit`, `reports`, `notifications` and
the `admin-*` set. Each arrives with the phase that builds its screens
([16-frontend-architecture.md](../../../../docs/architecture/16-frontend-architecture.md) §3).

Two rules hold for every one of them:

- **The UI never decides a permission.** It renders the `capabilities` object the server
  returned with the resource.
- **URL state is state.** Filters, page, tab and selection live in the URL, so a filtered list
  is shareable and survives a reload.
