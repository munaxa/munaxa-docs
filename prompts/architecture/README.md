# Munaxa — Architecture Documentation (Phase 0)

> **Munaxa** is a multi-tenant **School Operating System (School OS)** for K-12 schools in Jordan.
> It is **not** an LMS — it integrates with Google Classroom and Microsoft Teams via deep links only.

This directory is the **binding architectural blueprint** produced in **Phase 0**. All later
phases (1–15) must conform to the decisions recorded here. Nothing here is implementation code;
it is design, diagrams (Mermaid), and strategy.

## Index

| # | Document | Scope |
|---|----------|-------|
| 00 | [System Architecture](./00-system-architecture.md) | High-level system & C4 context/containers |
| 01 | [Monorepo Architecture](./01-monorepo-architecture.md) | Turborepo layout, apps & packages |
| 02 | [Domain Architecture](./02-domain-architecture.md) | DDD bounded contexts, Clean Architecture layers |
| 03 | [Multi-Tenant Architecture](./03-multi-tenant-architecture.md) | Shared DB tenant isolation model |
| 04 | [Database ERD](./04-database-erd.md) | Core entity-relationship design (Phase 2 target) |
| 05 | [RBAC Matrix](./05-rbac-matrix.md) | Roles, permissions, role × permission matrix |
| 06 | [API Architecture](./06-api-architecture.md) | REST conventions, versioning, error model |
| 07 | [Mobile Architecture](./07-mobile-architecture.md) | Flutter / Riverpod / GoRouter, offline-first |
| 08 | [Deployment Architecture](./08-deployment-architecture.md) | Cloudflare + AWS topology, environments, CI/CD |
| 09 | [Security Architecture](./09-security-architecture.md) | OWASP Top 10, authN/Z, secrets, file uploads |
| 10 | [Audit Logging Strategy](./10-audit-logging-strategy.md) | What/how/where we audit |
| 11 | [Backup Strategy](./11-backup-strategy.md) | RPO/RTO, backup tiers, retention |
| 12 | [Disaster Recovery Strategy](./12-disaster-recovery-strategy.md) | DR tiers, failover runbook outline |
| 13 | [Notification Architecture](./13-notification-architecture.md) | FCM, email (Resend), in-app, WhatsApp bridge |
| 14 | [Attendance / Presence / Transport — Audit](./14-attendance-presence-transport-audit.md) | Pre-build compatibility audit (Phase 21) |
| 14b | […Migration Report](./14b-attendance-presence-transport-migration-report.md) | Migration + RLS report (Phase 21) |
| 15 | [Identity & Cross-Tenant Membership](./15-identity-and-cross-tenant-membership.md) | ADR — one human, many schools (deferred) |

## Related references

- [**Design System**](../design-system/README.md) — tokens, themes (light/dark), bilingual/RTL
  rules, and the shared UI kit (the visual layer that sits on top of this architecture).
- [Integrations — JoFotara e-invoicing](../integrations/jofotara/01-compliance-analysis.md) —
  compliance analysis + framework architecture.

## Core principles (non-negotiable)

- **Domain Driven Design** + **Clean Architecture**.
- **Multi-tenancy**: shared PostgreSQL, every business row carries `tenantId`, hard isolation.
- **Strict RBAC** across Platform and School role sets.
- **Security first**: OWASP Top 10, JWT + refresh tokens, rate limiting, audit logging, TLS,
  DTO/input validation, secure uploads. **No secrets in code** — environment variables only.
- **Localization**: Arabic + English, RTL + LTR throughout.
- **Jordan market**: National ID (Raqam Watani), MoE student number, CliQ + e-wallet receipt
  uploads. **No online payment gateways.**
- **Strict TypeScript**, production-ready code, tests (unit + integration), Swagger docs.

## Backend stack
NestJS · TypeScript · PostgreSQL · Prisma · Firebase Auth · AWS S3 · FCM · Resend · Sentry · PostHog.

## Frontend / Mobile stack
Admin Portal: Next.js 15 (App Router) · TS · TailwindCSS · shadcn/ui.
Mobile (Parent / Student / Teacher): Flutter · Riverpod · GoRouter.

## Phase roadmap (from `MunaxaPrompts/`)
0 Architecture → 1 Foundation → 2 Core DB → 3 Auth & RBAC → 4 School Structure →
5 People → 6 Timetable → 7 Attendance → 8 Academics → 9 Finance → 10 Communication →
11 Parent Portal → 12 Student App → 13 Reporting → 14 Advanced Modules → 15 Production Hardening.
