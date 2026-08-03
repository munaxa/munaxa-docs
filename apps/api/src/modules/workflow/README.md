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

## Phase 0.5 status

Contracts only. `domain/`, `infrastructure/` and `presentation/` are filled in by the phase
that builds this capability; adding a file to them requires no change to anything above.
