# Workflow module

**Answers:** Who must agree before this becomes official?

| | |
| --- | --- |
| **Owns** | WorkflowDefinition and versions, Instance, Stage, ApprovalTask, escalation timers |
| **Depends on** | Document, Identity, Administration |
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

## The engine

Four moves, and every routing shape a tenant can author is a composition of them: **start an
instance**, **activate a stage**, **decide a task**, **end an instance**. There is no code path for
"sequential approval" and none for "parallel" — stages run in order, tasks inside a stage run in
parallel unless the stage is `ordered`, and how many must agree is `ALL`, `ANY`, `QUORUM(n)` or
`PERCENT(p)`. [07 §2](../../../../../docs/architecture/07-workflow-architecture.md) asks for one
primitive rather than three, and the property that buys is that a fourth routing shape is a
definition rather than a release.

| Piece | What it is |
| --- | --- |
| `domain/completion.ts` | Whether a stage is finished, and what finished it. Pure |
| `domain/conditions.ts` | The closed expression language, evaluated purely over a flat fact map |
| `application/participant-resolver.ts` | Turning resolvers into people, at stage activation |
| `application/workflow-engine.service.ts` | The engine |
| `application/workflow-timers.service.ts` | Deadlines, reminders, and the pause that stops them |
| `application/approval.service.ts` | The read side: an inbox, and a document's approval history |

### The four guarantees, and where each one lives

**One transaction per decision.** `AdministeredWriter.write` opens it, and the task, the stage, the
instance, the document's status and the audit event commit inside it or none of them do. The one
thing deliberately outside is the queue: timers are planned in the transaction and enqueued after it
commits, because a reminder enqueued inside a transaction that then rolls back is what
[ADR-0011](../../../../../docs/architecture/adr/0011-transactional-outbox-for-async-work.md) exists
to prevent.

**A task is decided once.** `decideIfPending` is a conditional `UPDATE … WHERE decision IS NULL`, and
zero rows affected is a `409` rather than a retry. Every write path also takes a row lock on the
instance *first* — without it two approvers deciding at the same instant each see only their own
decision under `READ COMMITTED`, and a two-person quorum is met while the stage stays pending
forever. That was a real defect, found by the integration suite.

**A resolver that yields nobody fails loudly.** §8 forbids skipping a stage whose participants
resolve empty, and calls it a silent loss of a control. Submission refuses, naming the resolver. A
stage whose *condition* does not hold is a different thing and is `SKIPPED` with a stated reason —
the two look alike from outside, which is exactly why the engine keeps them apart.

**Numbering goes through the seam, never through engine code.** [ADR-0004](../../../../../docs/architecture/adr/0004-numbering-assigned-at-approval.md)
reserves at submission and assigns at approval, and §8 forbids assigning earlier. The engine calls
`DOCUMENT_NUMBER_ALLOCATOR` — reserve on submit, assign on complete, void on every ending that is
not an approval — always inside the same transaction as the move it accompanies. Phase 4 left the
port unbound and approvals completed `numberAssigned: false`; Phase 5 bound it to an adapter over
Document's number service, and every completed approval is numbered with no change to the
completion path. The port stays `@Optional`, so an unbound composition still produces the honest
unnumbered outcome rather than a fabricated number.

**Delegation goes through the second seam, and the engine's one check is where it is relaxed.**
Phase 4 wrote that "the single check that phase relaxes — the task belongs to you — is in one place
in the engine", and Phase 11 relaxed exactly that place: `if (task.assigneeId !== actor)` now asks
`WORKFLOW_DELEGATION_GATE` whether the actor holds a delegation *for this permission* before it
refuses. Nothing else in the engine changed, and `assigneeId` is never rewritten — §4 makes
delegation a **routing overlay**, so the task stays the delegator's and the delegate acts on it.

The gate names the permission the decision exercises (`document:approve` for an approval,
`document:reject` for the other two), so a delegation covering approvals does not authorise a
rejection — which is what 08 §6's two separate grants already meant for an assignee. It is
`@Optional` for the same reason the allocator is, with one difference worth stating: an unbound
allocator degrades to an *unnumbered* approval, and an unbound delegation gate degrades to the
**stricter** behaviour, where only the assignee decides. A seam whose absence loosens a control
would be the wrong seam.

A delegated decision writes two audit events in one transaction: the decision's own, and
`DELEGATION_USED` filed against the **delegation**. That second one is written here rather than in
Identity because the act being recorded is a decision on an approval task, and 13 §1 requires an
event in the same transaction as the act it describes.

### Timers are rows as well as jobs

§3 says timers are BullMQ delayed jobs, not polling, and §6 says a paused instance resumes with the
*remaining* duration. Both are satisfied by the same arrangement: **the queue holds the job and
`workflow_timer` holds what the job is for.** A queue alone cannot answer three questions the engine
has to answer — which timers belong to this stage, what this one had left when the instance paused,
and whether this reminder has already fired.

`fire_at` on resume is `now + remaining_ms`, never re-derived from the definition's duration. That is
the one implementation of "resume" that would look right and be wrong: a stage held for a week would
come back with its full three days rather than the two it had left. A check constraint pairs `PAUSED`
with a remainder so the mistake is unrepresentable rather than merely unlikely.

### What it needs from other modules

`WORKFLOW_DOCUMENT_GATE`, `WORKFLOW_DIRECTORY` and `WORKFLOW_CALENDAR` are declared here, in this
module's own vocabulary, and implemented by adapters in this module's infrastructure that call
Document's, Identity's and Administration's **application services**. Workflow sits below Document in
the module order, so calling it is an ordinary downward dependency rather than one of Phase 3's
inversions — the ports are narrow anyway, because the engine that could reach `DOCUMENT_SERVICE`
could also move a document to another folder.

## Definitions — Phase 2

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

`instanceCount` was zero everywhere until Phase 4 and was on the row rather than absent so the
immutability rule would read the same way once there were instances. It is now filled in from
`workflow_instance`, and nothing else about the administration side changed — which was the point of
putting it there early.

## Phase 16 — bulk approval

`BulkApprovalService` decides many tasks the same way, and passes **both** authorities a single
decision passes rather than reimplementing either. The permission is the bulk executor's per-object
`ACL_RESOLVER.resolve` against the *document* each task decides — reach is resolved at a scope node
and a task is not one, which is why `ApprovalQueryRepository` gained `documentOfTask`. The
delegation authority is the engine's own, because `apply` calls `WorkflowEngine.decide` and nothing
here reaches past it: a delegation that expired between the second and third task in a batch refuses
the third, with the engine's own reason attached.

`documentOfTask` is on the *query* repository rather than the engine's, deliberately. The engine's
`instanceIdOfTask` exists to take a row lock before deciding, and reaching for it here would lock
every task in a batch — including the ones about to be refused — turning a permission check into a
contention source.

**Bulk approval approves, and cannot reject.** A rejection or a request for changes must say why,
and one sentence covering forty documents is a reason for the batch rather than for any of them —
which in a controlled-document system is exactly the field an auditor reads. `document:reject` is
therefore unreachable in bulk by construction rather than by a check, and the single-object route is
unchanged and one click away. A tenant can turn the whole capability off on its own
(`feature.bulkApproval`), separately from the other four, because a quality manager who wants
drag-select and wants every approval to be a deliberate individual act has a coherent position.
