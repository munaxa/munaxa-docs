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
├── school/docs/                        the Munaxa product
│   ├── architecture/                   binding system architecture (+ adr/)
│   ├── domains/                        per-domain design: hr, finance, attendance, …
│   ├── ux/                             UX architecture and pattern library
│   ├── phases/                         delivery history, phase by phase
│   ├── ops/  security/  integrations/  running it, securing it, connecting it
│   └── archive/                        dated point-in-time reports (historical)
├── edms/docs/                          Munaxa Docs (EDMS) — architecture only
│   ├── architecture/                   the binding Phase 0 blueprint (+ adr/)
│   └── reports/                        dated Phase 0 findings (historical)
└── work/README.md                   reserved product root
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
| [school/docs/ui-governance.md](../school/docs/ui-governance.md) | How Munaxa consumes and enforces the platform; Munaxa's UI "never" list | Munaxa UI engineers | Before writing Munaxa UI | Rulebook §7 |
| [school/docs/ux/design-governance.md](../school/docs/ux/design-governance.md) | Design-system ownership, contribution, review, versioning, deprecation | Design system contributors | Proposing a design-system change | platform/CONTRIBUTING.md |
| [school/docs/ux/ai-generation-rules.md](../school/docs/ux/ai-generation-rules.md) | UI-specific rules for AI-generated interfaces | AI agents building screens | Generating any Munaxa screen | Rulebook §5, ai-product-architecture.md |
| [school/docs/ux/ai-product-architecture.md](../school/docs/ux/ai-product-architecture.md) | The order an AI must build in: workspaces → records → relationships | AI agents building screens | Before generating a screen | record-workspaces.md, workspaces.md |
| [school/docs/ux/ai-domain-guidelines.md](../school/docs/ux/ai-domain-guidelines.md) | Rules for AI use of Munaxa domain components | AI agents building screens | Composing domain components | domain-components-catalog.md |

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
| [platform/assets/README.md](../platform/assets/README.md) | Per-product brand artwork layout and naming | Designers, brand engineers | Adding artwork | school/docs/design-system/ |
| [platform/ui/templates/README.md](../platform/ui/templates/README.md) | Why the template layer is empty and when to fill it | Component authors | Considering a page template | component-principles.md |

## 3. Munaxa — system architecture

The binding blueprint. Conform to it or supersede it with an ADR.

| Document | Purpose | Audience | When to read |
| --- | --- | --- | --- |
| [architecture/README.md](../school/docs/architecture/README.md) | Index of the numbered architecture set | Engineers, architects | Entry point to Munaxa architecture |
| [00-system-architecture.md](../school/docs/architecture/00-system-architecture.md) | C4 context and containers; the system at a glance | New joiners | First day |
| [01-monorepo-architecture.md](../school/docs/architecture/01-monorepo-architecture.md) | Workspace layout, apps and packages | Every engineer | Finding where code lives |
| [02-domain-architecture.md](../school/docs/architecture/02-domain-architecture.md) | Bounded contexts and clean-architecture layers | Backend engineers | Adding a module |
| [03-multi-tenant-architecture.md](../school/docs/architecture/03-multi-tenant-architecture.md) | Shared-database tenant isolation, defence in depth | Every backend engineer | Any query, any migration |
| [03b-tenant-database-routing.md](../school/docs/architecture/03b-tenant-database-routing.md) | Per-tenant database routing and connection management | Backend, platform ops | Working on tenancy internals |
| [04-database-erd.md](../school/docs/architecture/04-database-erd.md) | Core entity relationships | Backend engineers | Schema work |
| [05-rbac-matrix.md](../school/docs/architecture/05-rbac-matrix.md) | Roles, permissions and the role × permission matrix | Everyone | Adding a permission or gating UI |
| [06-api-architecture.md](../school/docs/architecture/06-api-architecture.md) | REST conventions, versioning, error model | API authors and consumers | Adding an endpoint |
| [07-mobile-architecture.md](../school/docs/architecture/07-mobile-architecture.md) | Flutter, Riverpod, GoRouter, offline-first | Mobile engineers | Mobile work |
| [08-deployment-architecture.md](../school/docs/architecture/08-deployment-architecture.md) | Environments, topology, CI/CD | Ops, release engineers | Deploying |
| [09-security-architecture.md](../school/docs/architecture/09-security-architecture.md) | OWASP posture, authN/authZ, secrets, uploads | Everyone | Anything security-adjacent |
| [10-audit-logging-strategy.md](../school/docs/architecture/10-audit-logging-strategy.md) | What is audited, how and where | Backend engineers | Adding a sensitive action |
| [11-backup-strategy.md](../school/docs/architecture/11-backup-strategy.md) | RPO/RTO, backup tiers, retention | Ops | Operational planning |
| [12-disaster-recovery-strategy.md](../school/docs/architecture/12-disaster-recovery-strategy.md) | DR tiers and failover | Ops | Incident preparation |
| [13-notification-architecture.md](../school/docs/architecture/13-notification-architecture.md) | Channels: push, email, in-app, WhatsApp bridge | Backend engineers | Sending anything to a human |
| [13b-notification-platform-implementation.md](../school/docs/architecture/13b-notification-platform-implementation.md) | The implemented notification engine, preferences, delivery | Backend engineers | Working on notifications |
| [14-attendance-presence-transport-audit.md](../school/docs/architecture/14-attendance-presence-transport-audit.md) | Pre-build compatibility audit for the presence programme | Backend engineers | Attendance/presence work |
| [14b-…-migration-report.md](../school/docs/architecture/14b-attendance-presence-transport-migration-report.md) | Migration and RLS report for the same programme | Backend engineers | Attendance/presence work |
| [15-identity-and-cross-tenant-membership.md](../school/docs/architecture/15-identity-and-cross-tenant-membership.md) | One human, many schools — deferred design | Architects | Identity work |
| [16-document-engine.md](../school/docs/architecture/16-document-engine.md) | Declarative document/PDF generation | Backend engineers | Generating documents |
| [capability-ownership-matrix.md](../school/docs/architecture/capability-ownership-matrix.md) | Which module owns which capability, and the seams between them | Architects, module owners | Before adding a cross-module feature |

### Architecture Decision Records

Immutable. Supersede, never edit. See [architecture/adr/](../school/docs/architecture/adr/).

| ADR | Decision |
| --- | --- |
| [0001](../school/docs/architecture/adr/0001-student-identity-vs-enrollment-placement.md) | Student identity is separate from enrolment placement |
| [0002](../school/docs/architecture/adr/0002-attendance-calendar-ownership.md) | Which module owns the attendance calendar |

## 4. Munaxa — domains

Per-domain design. These are living documents: the current intended design of each business area.

| Domain | Documents |
| --- | --- |
| **HR** | [index](../school/docs/domains/hr/README.md) · [architecture audit](../school/docs/domains/hr/architecture-audit.md) · [module connections](../school/docs/domains/hr/module-connections.md) · [attendance enterprise architecture](../school/docs/domains/hr/attendance-enterprise-architecture.md) · [structure & UI](../school/docs/domains/hr/structure-ui.md) · [implementation report](../school/docs/domains/hr/IMPLEMENTATION_REPORT.md) · phases 1–10 |
| **Finance** | [domain specification v1](../school/docs/domains/finance/finance-domain-specification-v1.md) (canonical) · [ERD](../school/docs/domains/finance/finance-erd.md) · [redesign rationale](../school/docs/domains/finance/finance-domain-redesign.md) · [unified financial account](../school/docs/domains/finance/unified-financial-account-architecture.md) · [family billing plan](../school/docs/domains/finance/family-billing-refactor-plan.md) · [collections workflow](../school/docs/domains/finance/collections-operational-workflow.md) · [status](../school/docs/domains/finance/IMPLEMENTATION_STATUS.md) |
| **Attendance** | [structure & UI](../school/docs/domains/attendance/structure-ui.md) · see also HR attendance and architecture 14/14b |
| **Student lifecycle** | [architecture review](../school/docs/domains/student-lifecycle/architecture-review.md) |
| **Enrolment** | [billing impact](../school/docs/domains/enrollment/billing-impact.md) · [registration gap analysis](../school/docs/domains/enrollment/registration-gap-analysis.md) |
| **Transport** | [redesign](../school/docs/domains/transport/redesign.md) · [module context](../school/docs/domains/transport/module-context.md) |
| **Scheduling** | [engine refactor](../school/docs/domains/scheduling/engine-refactor.md) · [timetable structure & UI](../school/docs/domains/scheduling/timetable-structure-ui.md) |
| **Academic year** | [structure](../school/docs/ACADEMIC_YEAR_STRUCTURE.md) |

## 5. Munaxa — UX architecture and patterns

The enterprise UX contract: how records, navigation, search, history and approvals behave.
Index: [school/docs/ux/README.md](../school/docs/ux/README.md).

| Group | Documents |
| --- | --- |
| **Structure** | [workspaces](../school/docs/ux/workspaces.md) · [record workspaces](../school/docs/ux/record-workspaces.md) · [navigation](../school/docs/ux/navigation.md) · [action panel](../school/docs/ux/action-panel.md) |
| **Relationships & history** | [related records](../school/docs/ux/related-records.md) · [timeline](../school/docs/ux/timeline.md) · [activity feed](../school/docs/ux/activity-feed.md) · [audit trail](../school/docs/ux/audit-trail.md) |
| **Finding things** | [search architecture](../school/docs/ux/search-architecture.md) · [search pattern](../school/docs/ux/search-pattern.md) |
| **Control** | [permissions UX](../school/docs/ux/permissions-ux.md) · [workflow UX](../school/docs/ux/workflow-ux.md) · [multi-tenant UX](../school/docs/ux/multi-tenant-ux.md) · [audit & compliance UX](../school/docs/ux/audit-compliance-ux.md) |
| **Content & data** | [content design](../school/docs/ux/content-design.md) · [data visualization](../school/docs/ux/data-visualization.md) |
| **Domain components** | [architecture](../school/docs/ux/domain-components-architecture.md) · [catalog](../school/docs/ux/domain-components-catalog.md) · [relationships](../school/docs/ux/domain-relationships.md) |
| **Meta** | [documentation architecture](../school/docs/ux/documentation-architecture.md) · [notifications UX](../school/docs/ux/notifications-ux.md) · [website design reference](../school/docs/ux/website-design-reference.md) |

## 6. Munaxa — delivery, operations, security

| Area | Documents |
| --- | --- |
| **Delivery phases** | [phases/](../school/docs/phases/) — phase 1 foundation through phase 15 production hardening |
| **Handoff** | [HANDOFF.md](../school/docs/HANDOFF.md) — read first when resuming work |
| **Platform console** | [PLATFORM_CONSOLE.md](../school/docs/PLATFORM_CONSOLE.md) — the multi-tenant operator console |
| **Operations** | [ops/](../school/docs/ops/README.md) — deployment, infrastructure, monitoring, runbooks, load testing, production readiness, security checklist, [Cloudflare deploy](../school/docs/ops/cloudflare-deploy.md) |
| **Staging** | [deployment-staging.md](../school/docs/deployment-staging.md) |
| **Security** | [security audit 2026-06](../school/docs/security/SECURITY_AUDIT_2026-06.md) · [forgot-password / temporary reset](../school/docs/security/forgot-password-temporary-reset.md) |
| **Integrations** | [JoFotara compliance](../school/docs/integrations/jofotara/01-compliance-analysis.md) · [e-invoicing architecture](../school/docs/integrations/jofotara/02-einvoicing-architecture.md) |
| **Brand assets** | [design-system/](../school/docs/design-system/README.md) |
| **Marketing** | [social creative concepts](../school/docs/marketing/munaxa-social-creative-concepts.md) |

### Sub-application documentation

| App | Documents |
| --- | --- |
| Demo | [munaxademo/README.md](../school/munaxademo/README.md) · [architecture](../school/munaxademo/docs/architecture.md) · [deployment](../school/munaxademo/docs/deployment.md) · [security](../school/munaxademo/docs/security.md) |
| Mobile | [apps/mobile/README.md](../school/apps/mobile/README.md) |
| Platform docs site | The Platform Storybook, deployed to Cloudflare — every public component with live dark-mode, RTL and a11y controls |
| Prisma | [prisma/README.md](../school/prisma/README.md) |
| PDF Arabic rendering | [apps/api/src/documents/pdf/ARABIC_RENDERING.md](../school/apps/api/src/documents/pdf/ARABIC_RENDERING.md) |

## 7. Archive

[school/docs/archive/](../school/docs/archive/README.md) holds dated, point-in-time reports from
completed programmes — design-system migration phases, token and typography migrations,
compliance sweeps, progress snapshots.

**These are historical evidence, not current guidance.** They record what was true on a date and
why a decision was made. Several describe structures that no longer exist. Do not follow them; do
not edit them.

## 8. Munaxa Docs — the EDMS

The Enterprise Document Management System. **Phase 0 only: the architecture is designed, no code
exists.** Product root: [`edms/`](../edms/README.md) — named `edms/` because `docs/` is this index
([ADR-0001](../edms/docs/architecture/adr/0001-product-root-placement.md)).

Full index: [edms/docs/README.md](../edms/docs/README.md).

| Area | Documents |
| --- | --- |
| **Architecture (binding)** | [index](../edms/docs/architecture/README.md) — system, monorepo, backend, domain model, ERD, database, lifecycle, workflow, permissions, numbering, revisions, storage, search, audit, preview, API, frontend, security, notifications, performance, deployment, SaaS commercial (00–21) |
| **Decisions** | [adr/](../edms/docs/architecture/adr/) — 13 ADRs, immutable |
| **Phase 0 reports** | [repository analysis](../edms/docs/reports/repository-analysis.md) · [technical debt](../edms/docs/reports/technical-debt.md) · [risk assessment](../edms/docs/reports/risk-assessment.md) · [development recommendations](../edms/docs/reports/development-recommendations.md) |

> **Naming caution.** `school/apps/api/src/documents` is School's PDF *generation* module and has
> nothing to do with this product. Munaxa Docs never imports it, or anything else from School.

## 9. Work

[work/README.md](../work/README.md) — the reserved product root. Nothing is implemented.
It documents what the platform already provides and the steps to start.

---

## Maintaining this index

- **Adding a document?** Add a row here in the same commit, with its purpose, audience and when to
  read it. A document not linked from this index is invisible.
- **Moving a document?** Update this index and every inbound link in the same commit.
- **Superseding a document?** Move it to `archive/`, and have the replacement say what it replaces.
- **Found duplication?** Pick the authoritative source, reduce the other to a pointer, and record
  it here. Never leave two documents claiming the same authority.
