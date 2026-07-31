# Munaxa Docs — architecture rules

## Dependency direction

```text
munaxa-platform  ──►  munaxa-docs
```

That is the only edge. This repository must never depend on Munaxa School, Munaxa Work,
Munaxa Docs or Munaxa Corporate, and the platform must never depend on this repository.
CI enforces the first half of that in the `boundaries` job.

## What this repository owns

Business logic, the API, the database and its Prisma schema and migrations, routing,
domain models, permissions, workflows, and every Munaxa Docs-specific feature.

## What it does not own

The design system. Components, tokens, themes, icons and typography are installed:

| Need                        | Package                |
| --------------------------- | ---------------------- |
| Components, patterns, hooks | `@munaxa/ui`           |
| Design tokens               | `@munaxa/tokens`       |
| Themes                      | `@munaxa/theme`        |
| Icons                       | `@munaxa/icons`        |
| Typography                  | `@munaxa/typography`   |
| Shared helpers              | `@munaxa/utils`        |

If something shared is missing, add it to
[munaxa-platform](https://github.com/tam2om/munaxa-platform) — never rebuild it here. A
component copied into a product is the failure mode this whole architecture exists to
prevent.

## Branding

Branding is configuration, not code. The only visual difference between this product and
the others is the theme it imports:

```css
/* apps/<app>/src/app/globals.css */
@import 'tailwindcss';
@import '@munaxa/theme/css/docs';
@source '../../node_modules/@munaxa/platform/dist';
```

Never hardcode a colour, a font, a radius or a shadow. The Munaxa Docs palette is authored in
the platform, and retuning it there updates this product with no change here.

## Expected layout

```text
munaxa-docs/
├── apps/
│   ├── api/        # the product API
│   ├── admin/      # the product's web client
│   └── mobile/     # the product's mobile client
├── packages/       # domain, contracts, utils, i18n — this product's own
├── prisma/         # this product's schema and migrations, shared with no one
└── infra/          # database roles, load tests
```

## Status

The architecture is designed and the phase specifications are written (see `docs/` and
`prompts/`); no application code has been written yet. This repository was separated out of
the AXA monorepo carrying all of that and its history; the workspace, task graph, lint and
TypeScript configuration, registry auth and CI above are real and run today, so the first app
added here is checked from its first commit.
