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
| [Production deployment & go-live](./go-live-runbook.md) | The first production deployment of the validated RC `a560bb0`, step by step: prerequisites, the scanner, migration under drain, staging gate, smoke tests, rollback, and the Go/No-Go checklist |
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
