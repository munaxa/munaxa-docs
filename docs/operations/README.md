# Operations

**Purpose:** the runbooks an operator uses, as distinct from the architecture that explains them.
**Audience:** whoever deploys, restores or is woken up by this product.
**Status:** written in Phase 18. Living documents — unlike `docs/reports/`, these are edited.

[`20-deployment-architecture.md`](../architecture/20-deployment-architecture.md) says what the
topology *is*. These say what somebody *does*, and the split matters: an architecture document that
accumulated commands becomes a runbook nobody trusts, and a runbook that argues about topology is
one nobody finishes reading at three in the morning.

| Runbook | For |
| --- | --- |
| [Deployment](./deployment.md) | Building the images, migrating every tenant, releasing, rolling back |
| [Production deployment & go-live](./go-live-runbook.md) | The production deployment of release **`f5d5bb2`** (final application release; functional staging baseline `416ca94`; historical RC baseline `a560bb0`, never deployed), step by step: prerequisites, the scanner, migrations, drain, backup, smoke tests, monitoring, rollback (with the D-3 floor) and the Go/No-Go checklist |
| [Production prerequisites checklist](./production-prerequisites-checklist.md) | The nine production infrastructure prerequisites for `f5d5bb2` with their status and evidence required, the missing operator inputs, image publication (registry not configured), the production configuration checklist, the monitoring signals, what a production load baseline must measure, and the final Go/No-Go table |
| [Production infrastructure implementation](./production-infrastructure-implementation.md) | The operator's work plan before the first production deployment of `f5d5bb2`: the dependency order; for each of the nine prerequisites the purpose, actions, inputs, where configured, validation commands, expected results, evidence, owner and blocking status; the registry publishing and digest verification; the recovery rehearsal; the load measurements; a checkbox checklist; the full configuration inventory; and the readiness gate before runbook §21 |
| [Backup and restore](./backup-and-restore.md) | What is backed up, how a restore is performed, and the quarterly test that is the only thing making a backup real |
| [Disaster recovery](./disaster-recovery.md) | The scenarios in 20 §7, each as a procedure with an owner and a stated RTO |
| [Penetration testing](./penetration-testing.md) | The threat surface, the scope boundary, the test-account story, and what a tester may do to a tenant's data |

Two rules run through all five.

**A procedure that has not been performed is a hypothesis.** 20 §6 says an untested backup is not
a backup, and the same is true of every step below. Where a procedure has never been executed
against a real deployment, it says so in the procedure rather than in a footnote — because the
reader at three in the morning is the person who would otherwise discover it.

**Nothing here is a CI-only shortcut.** The pipeline runs the same `scripts/migrate-tenants.mjs`
against the same catalogue format the API reads, which is what stops the documented procedure and
the tested one from drifting apart (20 §4).
