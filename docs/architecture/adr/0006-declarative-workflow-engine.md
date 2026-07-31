# ADR-0006 — Workflow definitions are versioned data, not code

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

Approval routes differ per tenant, per document type and sometimes per document. The brief requires
sequential, parallel, conditional and manager-based approval, groups, quorums, delegation,
escalation, deadlines and reminders — plus a future graphical workflow designer.

Encoding any of this in code means a release per tenant requirement, and a designer that generates
code.

## Decision

1. A **workflow definition** is data: an ordered list of stage descriptors, each with participant
   resolvers, a completion rule, an optional condition, a deadline and overdue behaviour. Stored as
   validated `jsonb`, typed in `@edms/contracts`.
2. Definitions are **versioned**, and a published version is **immutable**.
3. A **workflow instance binds to a version**, so editing a workflow can never change the rules of
   an approval already running.
4. **Participants are resolved at stage activation**, not at definition time, so an organisational
   change does not break stored routes.
5. Conditions are a small **closed expression language** evaluated by a pure function with no I/O.
6. The future designer is a UI over this same JSON — no engine change.

## Alternatives considered

1. **Hardcoded workflows per document type** — a release per tenant request; rejected against the
   brief's explicit "nothing hardcoded".
2. **A general scripting hook (JS/Lua) per stage** — maximum flexibility, but arbitrary code in an
   approval path is unauditable, untestable and a security surface. Rejected.
3. **A third-party BPMN engine** — brings a second data model, a second permission model and a
   second operational surface, for a routing problem that is a few stage types wide. Rejected;
   revisit only if genuine BPMN interchange becomes a customer requirement.
4. **Instances binding to the definition, not a version** — simpler, but changing a workflow would
   silently alter running approvals, which is a compliance failure.

## Consequences

- The engine has no knowledge of document types, departments or roles; it evaluates descriptors.
- A definition in use can never be deleted, only deprecated; old versions live as long as their
  instances, which is forever.
- Every definition version is validated on publish (contiguous stages, resolvable participants,
  parseable conditions, no unreachable stage).
- An empty participant resolution **fails submission loudly** rather than skipping a control.
