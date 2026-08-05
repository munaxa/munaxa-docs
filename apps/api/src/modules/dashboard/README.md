# Dashboard module

**Answers:** What needs my attention right now?

| | |
| --- | --- |
| **Owns** | Dashboard composition over other modules’ read models |
| **Depends on** | Document, Workflow, Storage, Identity, Organization, Retention, Notification |
| **Binds in core** | Nothing in core. Consumes `ACL_RESOLVER`, `ACTIVITY_READER` and `CLOCK_PORT`. |

## The rule, and how it is enforced

**The dashboard owns no data.** It composes what other modules already expose — the approval inbox,
recent documents, overdue tasks — so a widget cannot become a second, divergent definition of
"overdue".

That is a constraint a dashboard can violate on every widget, so Phase 13 made it unbreakable rather
than merely written down: **this module has no `infrastructure/` folder, and no Prisma import is
reachable from anything inside it.** There is nothing here to count rows with.

What it needs is declared in `application/ports.ts` in *this module's* vocabulary and implemented by
whichever module owns the table — the inverted dependency Document already uses for
`REVISION_WRITER`. Every adapter is built from the predicate its own module's list is built from:

| Port | Implemented in | Built from |
| --- | --- | --- |
| `DASHBOARD_DOCUMENT_METRICS` | Document | `PrismaDocumentRepository.whereFor` |
| `DASHBOARD_APPROVAL_METRICS` | Workflow | `approvalTaskWhere` — the inbox's own predicate |
| `DASHBOARD_STORAGE_METRICS` | Storage | `file_object`, aggregated. **No quota** |
| `DASHBOARD_PEOPLE_METRICS` | Identity | `user`, grouped by state |
| `DASHBOARD_ORGANIZATION_METRICS` | Organization | `department`, counted |
| `DASHBOARD_RETENTION_METRICS` | Retention | `dueScheduleWhere` — `listDue`'s own predicate |
| `DASHBOARD_DELEGATION_METRICS` | Identity | `DELEGATION_SERVICE` (optional) |
| `DASHBOARD_NOTIFICATION_METRICS` | Notification | `NOTIFICATION_SERVICE` (optional) |

## Adding a widget

A count is a disclosure (`08-permission-model.md` §7). Every widget answers to one of two sentences,
and there is no third:

1. **A user widget is a query whose predicate names the caller** — their documents, their tasks,
   their locks, their trail. It needs no permission beyond the route's, because there is no
   parameter by which to ask about anybody else.
2. **An administrator widget crosses the tenant**, so it is gated on the permission that already
   governs the screen it summarises, and it is `FORBIDDEN` — *absent* — rather than `READY: 0` when
   the caller does not hold it. Those are different answers, and the difference is the disclosure.

If a widget fits neither — if it crosses the tenant and no existing permission governs it — it is not
a dashboard tile. It is a report, and reports are Phase 15's.

Nothing here writes, so this module has no audit action and no `AdministeredWriter`.

## Layers

```text
dashboard/
├── dashboard.module.ts        composition for this module
├── application/               the composing service and the ports this module declares
└── presentation/              the controller and its view mappers
```

`domain/` and `infrastructure/` are deliberately absent — see the rule above.

The dependency rule points inward, and it is enforced by `eslint.config.mjs` at the app root,
not merely described here. Other modules call this one through its **application service** or
react to its **events** — never through its repositories or its Prisma models.

## Events published

| Type | Meaning |
| --- | --- |
| — | This module publishes no events; it composes other modules’ read models. |

## Status

Built by **Phase 13** — see [`docs/reports/phase-13-dashboard.md`](../../../../../docs/reports/phase-13-dashboard.md).
One route, `GET /api/v1/dashboard`, taking no user identifier: that absence is the authorisation for
the user half.
