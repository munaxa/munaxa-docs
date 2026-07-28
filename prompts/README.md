# AXA Documentation Index

The official entry point to every document in this repository. If you are looking for something
and it is not linked from here, it either does not exist or it is misfiled — say so.

**New here? Read these three, in order:**

1. [`PLATFORM_ENGINEERING_STANDARDS.md`](../PLATFORM_ENGINEERING_STANDARDS.md) — how work is done.
   Mandatory for every contributor, human and AI.
2. [`../README.md`](../README.md) — what the repository contains and how to run it.
3. The section below that matches what you are about to touch.

---

## How this documentation is organised

```
/
├── PLATFORM_ENGINEERING_STANDARDS.md   THE RULEBOOK — how to contribute
├── docs/README.md                      THIS INDEX
├── platform/                           the shared foundation (frozen)
│   ├── README.md                       how to consume it
│   ├── CONTRIBUTING.md                 how to change it
│   └── architecture/                   why it is shaped this way
├── munaxa/docs/                        the Munaxa product
│   ├── architecture/                   binding system architecture (+ adr/)
│   ├── domains/                        per-domain design: hr, finance, attendance, …
│   ├── ux/                             UX architecture and pattern library
│   ├── phases/                         delivery history, phase by phase
│   ├── ops/  security/  integrations/  running it, securing it, connecting it
│   └── archive/                        dated point-in-time reports (historical)
└── workaxa/README.md                   reserved product root
```

Three rules govern this tree:

- **One authoritative source per topic.** Everything else links to it.
- **Living documents are edited; historical documents are not.** Anything in `archive/` is
  evidence of a moment, never current guidance.
- **Every document states its purpose and audience** in its first lines.

---

## 1. Rules and standards

| Document | Purpose | Audience | When to read | Related |
| --- | --- | --- | --- | --- |
| [PLATFORM_ENGINEERING_STANDARDS.md](../PLATFORM_ENGINEERING_STANDARDS.md) | **The rulebook.** Dependency law, reuse, quality, security, tests, docs, definition of done | Everyone, human and AI | Before any change, every time | Everything below |
| [platform/CONTRIBUTING.md](../platform/CONTRIBUTING.md) | The operational checklist for changing the platform itself | Anyone editing `platform/` | Before touching the shared layer | Rulebook §3 |
| [munaxa/docs/ui-governance.md](../munaxa/docs/ui-governance.md) | How Munaxa consumes and enforces the platform; Munaxa's UI "never" list | Munaxa UI engineers | Before writing Munaxa UI | Rulebook §7 |
| [munaxa/docs/ux/design-governance.md](../munaxa/docs/ux/design-governance.md) | Design-system ownership, contribution, review, versioning, deprecation | Design system contributors | Proposing a design-system change | platform/CONTRIBUTING.md |
| [munaxa/docs/ux/ai-generation-rules.md](../munaxa/docs/ux/ai-generation-rules.md) | UI-specific rules for AI-generated interfaces | AI agents building screens | Generating any Munaxa screen | Rulebook §5, ai-product-architecture.md |
| [munaxa/docs/ux/ai-product-architecture.md](../munaxa/docs/ux/ai-product-architecture.md) | The order an AI must build in: workspaces → records → relationships | AI agents building screens | Before generating a screen | record-workspaces.md, workspaces.md |
| [munaxa/docs/ux/ai-domain-guidelines.md](../munaxa/docs/ux/ai-domain-guidelines.md) | Rules for AI use of Munaxa domain components | AI agents building screens | Composing domain components | domain-components-catalog.md |

## 2. The platform

The shared, product-agnostic foundation. **Frozen** — see rulebook §3.

| Document | Purpose | Audience | When to read | Related |
| --- | --- | --- | --- | --- |
| [platform/README.md](../platform/README.md) | What the platform is, its layers, and how a product consumes it | Every product engineer | Setting up a product surface; looking for a component | Rulebook §4 |
| [platform/architecture/README.md](../platform/architecture/README.md) | Folder responsibilities, component lifecycle, platform vs product | Anyone deciding where code belongs | When unsure whether something is shared | Rulebook §2 |
| [platform/architecture/component-principles.md](../platform/architecture/component-principles.md) | What a platform component is; API design; promotion rules | Component authors | Adding or changing a component | CONTRIBUTING.md |
| [platform/architecture/theming.md](../platform/architecture/theming.md) | Tokens, the theme contract, product palettes, adding a theme | Anyone touching colour | Adding a theme; debugging a token | ui-governance.md |
| [platform/architecture/accessibility.md](../platform/architecture/accessibility.md) | The non-negotiable WCAG 2.2 AA floor and how to verify it | Every UI engineer | Building any interactive component | audit-compliance-ux.md |
| [platform/architecture/responsive.md](../platform/architecture/responsive.md) | Breakpoints, layout ownership, density, RTL, overflow | Every UI engineer | Laying out a screen | navigation.md |
| [platform/architecture/motion.md](../platform/architecture/motion.md) | Duration and easing scales, what to animate, reduced motion | Anyone adding animation | Before animating anything | accessibility.md |
| [platform/architecture/naming-conventions.md](../platform/architecture/naming-conventions.md) | Files, exports, props, CSS variables, naming smells | Everyone | Naming anything | Rulebook §8 |
| [platform/architecture/import-rules.md](../platform/architecture/import-rules.md) | What may import what, in both directions; entry points | Everyone | Adding any import | Rulebook §4 |
| [platform/assets/README.md](../platform/assets/README.md) | Per-product brand artwork layout and naming | Designers, brand engineers | Adding artwork | munaxa/docs/design-system/ |
| [platform/ui/templates/README.md](../platform/ui/templates/README.md) | Why the template layer is empty and when to fill it | Component authors | Considering a page template | component-principles.md |

## 3. Munaxa — system architecture

The binding blueprint. Conform to it or supersede it with an ADR.

| Document | Purpose | Audience | When to read |
| --- | --- | --- | --- |
| [architecture/README.md](../munaxa/docs/architecture/README.md) | Index of the numbered architecture set | Engineers, architects | Entry point to Munaxa architecture |
| [00-system-architecture.md](../munaxa/docs/architecture/00-system-architecture.md) | C4 context and containers; the system at a glance | New joiners | First day |
| [01-monorepo-architecture.md](../munaxa/docs/architecture/01-monorepo-architecture.md) | Workspace layout, apps and packages | Every engineer | Finding where code lives |
| [02-domain-architecture.md](../munaxa/docs/architecture/02-domain-architecture.md) | Bounded contexts and clean-architecture layers | Backend engineers | Adding a module |
| [03-multi-tenant-architecture.md](../munaxa/docs/architecture/03-multi-tenant-architecture.md) | Shared-database tenant isolation, defence in depth | Every backend engineer | Any query, any migration |
| [03b-tenant-database-routing.md](../munaxa/docs/architecture/03b-tenant-database-routing.md) | Per-tenant database routing and connection management | Backend, platform ops | Working on tenancy internals |
| [04-database-erd.md](../munaxa/docs/architecture/04-database-erd.md) | Core entity relationships | Backend engineers | Schema work |
| [05-rbac-matrix.md](../munaxa/docs/architecture/05-rbac-matrix.md) | Roles, permissions and the role × permission matrix | Everyone | Adding a permission or gating UI |
| [06-api-architecture.md](../munaxa/docs/architecture/06-api-architecture.md) | REST conventions, versioning, error model | API authors and consumers | Adding an endpoint |
| [07-mobile-architecture.md](../munaxa/docs/architecture/07-mobile-architecture.md) | Flutter, Riverpod, GoRouter, offline-first | Mobile engineers | Mobile work |
| [08-deployment-architecture.md](../munaxa/docs/architecture/08-deployment-architecture.md) | Environments, topology, CI/CD | Ops, release engineers | Deploying |
| [09-security-architecture.md](../munaxa/docs/architecture/09-security-architecture.md) | OWASP posture, authN/authZ, secrets, uploads | Everyone | Anything security-adjacent |
| [10-audit-logging-strategy.md](../munaxa/docs/architecture/10-audit-logging-strategy.md) | What is audited, how and where | Backend engineers | Adding a sensitive action |
| [11-backup-strategy.md](../munaxa/docs/architecture/11-backup-strategy.md) | RPO/RTO, backup tiers, retention | Ops | Operational planning |
| [12-disaster-recovery-strategy.md](../munaxa/docs/architecture/12-disaster-recovery-strategy.md) | DR tiers and failover | Ops | Incident preparation |
| [13-notification-architecture.md](../munaxa/docs/architecture/13-notification-architecture.md) | Channels: push, email, in-app, WhatsApp bridge | Backend engineers | Sending anything to a human |
| [13b-notification-platform-implementation.md](../munaxa/docs/architecture/13b-notification-platform-implementation.md) | The implemented notification engine, preferences, delivery | Backend engineers | Working on notifications |
| [14-attendance-presence-transport-audit.md](../munaxa/docs/architecture/14-attendance-presence-transport-audit.md) | Pre-build compatibility audit for the presence programme | Backend engineers | Attendance/presence work |
| [14b-…-migration-report.md](../munaxa/docs/architecture/14b-attendance-presence-transport-migration-report.md) | Migration and RLS report for the same programme | Backend engineers | Attendance/presence work |
| [15-identity-and-cross-tenant-membership.md](../munaxa/docs/architecture/15-identity-and-cross-tenant-membership.md) | One human, many schools — deferred design | Architects | Identity work |
| [16-document-engine.md](../munaxa/docs/architecture/16-document-engine.md) | Declarative document/PDF generation | Backend engineers | Generating documents |
| [capability-ownership-matrix.md](../munaxa/docs/architecture/capability-ownership-matrix.md) | Which module owns which capability, and the seams between them | Architects, module owners | Before adding a cross-module feature |

### Architecture Decision Records

Immutable. Supersede, never edit. See [architecture/adr/](../munaxa/docs/architecture/adr/).

| ADR | Decision |
| --- | --- |
| [0001](../munaxa/docs/architecture/adr/0001-student-identity-vs-enrollment-placement.md) | Student identity is separate from enrolment placement |
| [0002](../munaxa/docs/architecture/adr/0002-attendance-calendar-ownership.md) | Which module owns the attendance calendar |

## 4. Munaxa — domains

Per-domain design. These are living documents: the current intended design of each business area.

| Domain | Documents |
| --- | --- |
| **HR** | [index](../munaxa/docs/domains/hr/README.md) · [architecture audit](../munaxa/docs/domains/hr/architecture-audit.md) · [module connections](../munaxa/docs/domains/hr/module-connections.md) · [attendance enterprise architecture](../munaxa/docs/domains/hr/attendance-enterprise-architecture.md) · [structure & UI](../munaxa/docs/domains/hr/structure-ui.md) · [implementation report](../munaxa/docs/domains/hr/IMPLEMENTATION_REPORT.md) · phases 1–10 |
| **Finance** | [domain specification v1](../munaxa/docs/domains/finance/finance-domain-specification-v1.md) (canonical) · [ERD](../munaxa/docs/domains/finance/finance-erd.md) · [redesign rationale](../munaxa/docs/domains/finance/finance-domain-redesign.md) · [unified financial account](../munaxa/docs/domains/finance/unified-financial-account-architecture.md) · [family billing plan](../munaxa/docs/domains/finance/family-billing-refactor-plan.md) · [collections workflow](../munaxa/docs/domains/finance/collections-operational-workflow.md) · [status](../munaxa/docs/domains/finance/IMPLEMENTATION_STATUS.md) |
| **Attendance** | [structure & UI](../munaxa/docs/domains/attendance/structure-ui.md) · see also HR attendance and architecture 14/14b |
| **Student lifecycle** | [architecture review](../munaxa/docs/domains/student-lifecycle/architecture-review.md) |
| **Enrolment** | [billing impact](../munaxa/docs/domains/enrollment/billing-impact.md) · [registration gap analysis](../munaxa/docs/domains/enrollment/registration-gap-analysis.md) |
| **Transport** | [redesign](../munaxa/docs/domains/transport/redesign.md) · [module context](../munaxa/docs/domains/transport/module-context.md) |
| **Scheduling** | [engine refactor](../munaxa/docs/domains/scheduling/engine-refactor.md) · [timetable structure & UI](../munaxa/docs/domains/scheduling/timetable-structure-ui.md) |
| **Academic year** | [structure](../munaxa/docs/ACADEMIC_YEAR_STRUCTURE.md) |

## 5. Munaxa — UX architecture and patterns

The enterprise UX contract: how records, navigation, search, history and approvals behave.
Index: [munaxa/docs/ux/README.md](../munaxa/docs/ux/README.md).

| Group | Documents |
| --- | --- |
| **Structure** | [workspaces](../munaxa/docs/ux/workspaces.md) · [record workspaces](../munaxa/docs/ux/record-workspaces.md) · [navigation](../munaxa/docs/ux/navigation.md) · [action panel](../munaxa/docs/ux/action-panel.md) |
| **Relationships & history** | [related records](../munaxa/docs/ux/related-records.md) · [timeline](../munaxa/docs/ux/timeline.md) · [activity feed](../munaxa/docs/ux/activity-feed.md) · [audit trail](../munaxa/docs/ux/audit-trail.md) |
| **Finding things** | [search architecture](../munaxa/docs/ux/search-architecture.md) · [search pattern](../munaxa/docs/ux/search-pattern.md) |
| **Control** | [permissions UX](../munaxa/docs/ux/permissions-ux.md) · [workflow UX](../munaxa/docs/ux/workflow-ux.md) · [multi-tenant UX](../munaxa/docs/ux/multi-tenant-ux.md) · [audit & compliance UX](../munaxa/docs/ux/audit-compliance-ux.md) |
| **Content & data** | [content design](../munaxa/docs/ux/content-design.md) · [data visualization](../munaxa/docs/ux/data-visualization.md) |
| **Domain components** | [architecture](../munaxa/docs/ux/domain-components-architecture.md) · [catalog](../munaxa/docs/ux/domain-components-catalog.md) · [relationships](../munaxa/docs/ux/domain-relationships.md) |
| **Meta** | [documentation architecture](../munaxa/docs/ux/documentation-architecture.md) · [notifications UX](../munaxa/docs/ux/notifications-ux.md) · [website design reference](../munaxa/docs/ux/website-design-reference.md) |

## 6. Munaxa — delivery, operations, security

| Area | Documents |
| --- | --- |
| **Delivery phases** | [phases/](../munaxa/docs/phases/) — phase 1 foundation through phase 15 production hardening |
| **Handoff** | [HANDOFF.md](../munaxa/docs/HANDOFF.md) — read first when resuming work |
| **Platform console** | [PLATFORM_CONSOLE.md](../munaxa/docs/PLATFORM_CONSOLE.md) — the multi-tenant operator console |
| **Operations** | [ops/](../munaxa/docs/ops/README.md) — deployment, infrastructure, monitoring, runbooks, load testing, production readiness, security checklist, [Cloudflare deploy](../munaxa/docs/ops/cloudflare-deploy.md) |
| **Staging** | [deployment-staging.md](../munaxa/docs/deployment-staging.md) |
| **Security** | [security audit 2026-06](../munaxa/docs/security/SECURITY_AUDIT_2026-06.md) · [forgot-password / temporary reset](../munaxa/docs/security/forgot-password-temporary-reset.md) |
| **Integrations** | [JoFotara compliance](../munaxa/docs/integrations/jofotara/01-compliance-analysis.md) · [e-invoicing architecture](../munaxa/docs/integrations/jofotara/02-einvoicing-architecture.md) |
| **Brand assets** | [design-system/](../munaxa/docs/design-system/README.md) |
| **Marketing** | [social creative concepts](../munaxa/docs/marketing/munaxa-social-creative-concepts.md) |

### Sub-application documentation

| App | Documents |
| --- | --- |
| Demo | [munaxademo/README.md](../munaxa/munaxademo/README.md) · [architecture](../munaxa/munaxademo/docs/architecture.md) · [deployment](../munaxa/munaxademo/docs/deployment.md) · [security](../munaxa/munaxademo/docs/security.md) |
| Mobile | [apps/mobile/README.md](../munaxa/apps/mobile/README.md) |
| Design-system site | [munaxadesignsystem/](../munaxa/munaxadesignsystem) — publishes the UX documents in §5 |
| Orbix Studio | [orbix-studio/README.md](../munaxa/orbix-studio/README.md) |
| Prisma | [prisma/README.md](../munaxa/prisma/README.md) |
| PDF Arabic rendering | [apps/api/src/documents/pdf/ARABIC_RENDERING.md](../munaxa/apps/api/src/documents/pdf/ARABIC_RENDERING.md) |

## 7. Archive

[munaxa/docs/archive/](../munaxa/docs/archive/README.md) holds dated, point-in-time reports from
completed programmes — design-system migration phases, token and typography migrations,
compliance sweeps, progress snapshots.

**These are historical evidence, not current guidance.** They record what was true on a date and
why a decision was made. Several describe structures that no longer exist. Do not follow them; do
not edit them.

## 8. Workaxa

[workaxa/README.md](../workaxa/README.md) — the reserved product root. Nothing is implemented.
It documents what the platform already provides and the steps to start.

---

## Maintaining this index

- **Adding a document?** Add a row here in the same commit, with its purpose, audience and when to
  read it. A document not linked from this index is invisible.
- **Moving a document?** Update this index and every inbound link in the same commit.
- **Superseding a document?** Move it to `archive/`, and have the replacement say what it replaces.
- **Found duplication?** Pick the authoritative source, reduce the other to a pointer, and record
  it here. Never leave two documents claiming the same authority.
