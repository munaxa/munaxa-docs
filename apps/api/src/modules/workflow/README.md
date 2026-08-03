# Workflow module

**Answers:** Who must agree before this becomes official?

| | |
| --- | --- |
| **Owns** | WorkflowDefinition and versions, Instance, Stage, ApprovalTask, escalation timers |
| **Depends on** | Document, Identity |
| **Binds in core** | Nothing in core. |

## Layers

```text
workflow/
├── workflow.module.ts   composition for this module
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
| `workflow.started` | An instance is bound to a definition version and a revision. |
| `workflow.stage-activated` | Tasks exist for this stage\u2019s approvers. |
| `workflow.task-decided` | One approver decided; records who acted and on whose behalf. |
| `workflow.task-escalated` | A deadline passed and the task was reassigned per the stage rule. |
| `workflow.completed` | Every stage passed; the document may be numbered and approved. |
| `workflow.cancelled` | Ended without a decision, with a stated reason. |

## Phase 2 status

**Definitions and versions exist; the engine does not.** Nothing here starts an instance, resolves a
participant or decides a task, and none of the events above are published yet. What Phase 2 builds is
the data the engine will read — and the rules that keep that data trustworthy once it does.

`WORKFLOW_ADMIN_SERVICE`, behind `workflow:manage`, owns definition CRUD, draft version editing,
publishing, retiring, soft delete and restore.

### A published version is immutable

This is the module's most important property, and it is why the write side is shaped the way it is.
An approval binds to a *version*, so editing a published one would change the rules of a run already
in flight — and would make "which rules was this approved under" unanswerable years later, which is
the question the whole product exists to answer.

So there is no edit path for a published version. Editing a live workflow means adding a draft and
publishing it, and the rule is enforced **twice**: the service refuses it, and `state = DRAFT` sits in
the `WHERE` of the update statement, so the statement that would violate it matches no rows. The second
check is not redundant — a property this important may not rest on a check that ran a moment earlier.
`workflow-admin.integration.spec.ts` asserts both, including the repository call made with the service
bypassed entirely.

Publishing deprecates whichever version was live, in the same transaction, so there is never an instant
at which a document type points at a definition with no current version. Retiring is separate and
gentler: new approvals stop using the version and approvals already running are untouched.

### Version numbers

Allocated as `max + 1` inside the caller's transaction, not from a PostgreSQL sequence — for the same
reason the audit chain is not. A sequence gaps on rollback, and a gap in a version history reads as a
version somebody removed.

### The definition body

Stored as validated `jsonb` against `@edms/contracts`' `workflowDefinitionBodySchema`, deliberately not
normalised into rows. [07 §7](../../../../../docs/architecture/07-workflow-architecture.md) says the
future graphical designer is a UI over the same JSON; a normalised stage table would make that a
migration rather than a screen.

`domain/version-validator.ts` is the pure check that runs at publish: unreachable stages, cycles, empty
participant sets, thresholds a stage can never meet, and conditions naming facts the evaluator cannot
resolve. The last is an allow-list — `EVALUABLE_CONDITION_FIELDS` — so an unresolvable field is caught
when a version is published rather than when an approval stalls in front of somebody who cannot fix it.
It deliberately stops short of asking whether a resolver yields anybody: that is a question about a
particular document at a particular moment, and the engine will answer it.

`instanceCount` is zero everywhere for now and is on the row rather than absent, so the immutability
rule reads the same way once Phase 4 fills it in from `workflow_instance`.
