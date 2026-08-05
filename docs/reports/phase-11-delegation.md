# Phase 11 — Delegation: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Delegation phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 12 and after, and whoever audits what Phase 11 claimed.

Delegation was the most carefully pre-cut seam in the product, and almost none of it was bound.

`DELEGATION_REPOSITORY`, `DELEGATION_SERVICE` and `DelegationRecord` had been declared in
`modules/identity/application/ports.ts` since Phase 0.5 and bound to nothing. `delegation.approved`
and `delegation.revoked` were in Identity's events with no publisher. `DelegationId` was in
`@edms/domain`'s ids. `Permission.DELEGATION_MANAGE` was in the catalogue and in the Phase 1 role
seed, granted to `AUTHOR` and `APPROVER` with a comment saying it is `own`-scoped and "the use case
enforces the subject" — a use case that did not exist. `AuthorizationSubject.delegationIds` was on
the interface and passed `[]` by all three of its call sites. There was no table.

Phase 4 had cut the workflow seam deliberately and said so: `approval_task` carried `decided_by_id`
and `on_behalf_of_id`, the audit payload read both, and "the single check that phase relaxes — the
task belongs to you — is in one place in the engine". Phase 9 widened the chain's digest to version
2 specifically so `on_behalf_of_id` would be covered, and narrowed rather than discharged its own
limit: "Phase 11 fills a field that is already attested rather than one that is not."

So the phase's job was not to invent delegation. It was to answer the questions six years of
specification had left open, and to bind a seam without widening it.

## 1. The decision everything else follows from: an overlay, not a grant

07 §4's framing is one sentence and it decides the whole phase:

> Delegation is a **routing overlay**, never a permission grant: the task stays the delegator's, and
> the delegate acts on it.

Read literally, that sentence forbids the obvious implementation. The obvious implementation
reassigns the task — moves `assignee_id` to the delegate, moves it back on revocation — and it is
what "delegation" means in most products. It is also what makes §4's other rows impossible to
satisfy honestly.

**Nothing in this phase writes `assignee_id`.** A delegated decision sets `decided_by_id` to the
delegate and `on_behalf_of_id` to the assignee, and the assignee is unchanged before, during and
after. Three of §4's six rows fall out of that rather than being implemented:

- *"Revocation is immediate; in-flight tasks revert to the delegator."* Nothing reverts, because
  nothing moved. The moment the delegation stops being `ACTIVE`, the authority predicate stops
  returning it, and every in-flight task is the delegator's — which it always was. A revocation that
  had to walk tasks and reassign them could not be atomic across an approval somebody was deciding
  at that instant; this one has nothing to walk.
- *"Both identities are recorded on the task and in audit."* Two columns and two audit events,
  because there are genuinely two people.
- *"A delegate can never exercise more than the delegator holds."* An overlay has nothing to
  escalate *with*: there is no path by which a delegation confers reach, because no ACL entry may
  name one (§3 below).

The inbox is where the overlay is most visible on the wire. A delegate's inbox contains the
*delegator's* tasks, still assigned to the delegator, with an `onBehalfOf` object beside each saying
which delegation put it there. The query matches `assignee_id IN (caller, …delegators)` rather than
rewriting anything — "exactly what they may act on and nothing more" is a property of that `IN` list
rather than a filter applied afterwards.

## 2. The named risk: two identities, neither inferred, and a link that survives revocation

The brief named this precisely: a delegated decision must produce a trail in which both identities
are unambiguous and neither is inferred, and the delegation that authorised it must be identifiable
afterwards **even if it has since been revoked or expired** — because a revoked delegation is
exactly the one an investigation asks about.

It also named the two candidate answers and said they have different costs. They do, and the phase
took **both**, because they answer different questions.

**`approval_task.delegation_id` is the queryable link.** A nullable foreign key with `ON DELETE
RESTRICT`, which is the load-bearing half: revocation and expiry are status changes on `delegation`
rather than deletions, and the restricting key makes that a property rather than a convention — the
row cannot go while any decision points at it. A check constraint pairs it with `on_behalf_of_id`,
so a task carries all three identities or none; a row naming a delegation but no delegator would be
a trail that cannot answer "who decided, and for whom", which is the single question §4 says
delegation exists to keep answerable.

**`DELEGATION_USED` is the attested one.** The brief's own warning is why: *Phase 9's digest covers
`on_behalf_of_id` but nothing else you might add.* It covers the columns it was widened over, and it
cannot be widened again over a column this phase introduced — `audit_event` refuses the `UPDATE`
that would rehash the trail, which is the property the whole design exists for. So the foreign key
is **unattested by construction and permanently so**. The audit row is not: it is chained like every
other, and it is written through `AdministeredWriter.record` in the same transaction as the
decision's own `APPROVED` or `REJECTED` event — the second-event mechanism Phase 10 added for the
purge, used a second time for the shape it was built for.

Its subject is the **delegation**, not the task. That is what makes "everything decided under this
arrangement" a trail query on one subject rather than a join through `approval_task` that an
investigator has to know to write.

`DELEGATION_USED` is written by the **workflow engine**, not by Identity, and that is not a boundary
slip. 13 §1's third principle admits no other placement: the act being recorded is a decision on an
approval task, and an event in a different transaction from the act it describes is the one thing
that section forbids. Identity owns the delegation and writes the group's other three.

## 3. `AuthorizationSubject.delegationIds` stays empty, and 08 §3 lost a clause

08 §3's permission walk began "collect the caller's subjects: user id, role ids, department ids,
**active delegations**". That clause had been unbound since Phase 0.5. The brief asked whether this
phase makes it true, and what it would mean for a resolver that still resolves tenant-level role
grants only.

**It does not, and 08 §3 was edited to remove the clause rather than the code changed to satisfy
it.** The reason is §1's sentence again: making a delegation an ACL subject would make delegation a
grant. An ACL entry could then name a delegation on a scope node, and the delegate would gain
*reach* — visibility or authority over things the delegator never had — which is the privilege
escalation 07 §8's table names outright.

It would also put the answer in the wrong place. The resolver answers "may this subject reach this
node", walking a scope chain. "Does the delegator still hold `document:approve` right now" is a
different question about a different thing: it is tenant-wide, it is about a person rather than a
node, and Identity is what owns users, roles and the permission sets they resolve to. So
`DelegationService.authorityFor` answers it, reading the delegator's grants through
`CredentialRepository` — the same computed set an access token carries, read fresh rather than from
the token.

**`PrismaAclResolver` was not extended, and no fourth call site was added to it.** ACL entries and
the permission walk remain the ACL phase's, exactly as the brief required. `delegationIds` stays on
`AuthorizationSubject` and stays empty; removing the field would be a wider change than the decision
warrants, and leaving it documents a subject the resolver deliberately does not have.

## 4. Authority at decision time, and the `own` scope that constrained the answer

§4 puts the authority check at decision time and not at creation, so that a delegation created while
the delegator held `document:approve` fails if they no longer do. The phase implements that by
**storing nothing about the delegator's grants on the delegation**. `permissions` is what the
delegator chose to pass, never a snapshot of what they held — a snapshot is precisely the "checked
at creation" the section forbids, and it would go stale in the direction that matters.

There is deliberately no cheaper call. `authorityFor` takes the permission as a parameter and there
is no `isDelegate(a, b)` anywhere in the port, because that is the call every future caller reaches
for and the one that lets a delegate exceed the delegator. The permission is named rather than
assumed at the call site too: the engine passes `document:approve` for an approval and
`document:reject` for a rejection or a request for changes, so a delegation covering approvals does
not authorise a refusal — which is what 08 §6's two separate grants already meant for an assignee.

Creation checks the same thing, and that is a courtesy rather than the control: it stops somebody
arranging cover that was never going to work, instead of letting them find out when a decision is
refused.

**The `own` scope was the sharpest constraint in the phase**, and it lands on the approval rule
rather than on the request. The seed grants `delegation:manage` to `AUTHOR` and `APPROVER` as `own`,
and a request context carries a permission key with no scope beside it. So `delegation:manage`
cannot be read as "may administer delegations generally" — every author holds it, and treating it
that way would let any author approve any other author's request, which is the control not existing.

Two consequences:

- **Requesting enforces `own` by absence.** There is no `delegatorId` field in any request schema.
  The subject is the caller, read from the request context, and a field that is not in the schema
  cannot be supplied by a client that guesses. That is what "the use case enforces the subject" was
  always going to have to mean.
- **Approving is gated on `user:manage`**, not `delegation:manage`. 08 §6 marks it `✓` for
  `TENANT_ADMIN` alone, it is unambiguously tenant-wide, and it is already the grant that means
  "administers people".

## 5. The four things the repository had no home for

### Manager approval — the relationship, not the engine

A delegation waits for a **manager of the delegator**, resolved through `UserDirectory` from
`user_department.is_manager` — the same relationship Phase 4 added for the `MANAGER_OF` participant
resolver, and the same method that already resolves it for four subjects. Failing that, a holder of
`user:manage` who is party to neither side.

A delegation approved by a **workflow instance** was the tempting reuse, and it is refused with its
cost stated. The engine's every path begins at `WorkflowDocumentGate.contextFor(documentId)` and
ends at `transition(...)`; `workflow_instance.document_id` is `NOT NULL`, and a partial unique index
enforces one live approval *per document*. A workflow whose subject is not a document means either a
fabricated document — a row in the library nobody may open, with a number rule and a retention
policy — or a nullable subject on the engine's central table, widening every query, index and
completion path so one non-document case can borrow the machinery. The approval a delegation needs
is one person agreeing once. The engine exists for the case where that is not true.

The cost of the decision taken instead is real and worth stating: **a tenant that has not filled in
its org chart has no managers**, so every delegation there needs a tenant administrator. The
alternative — activating a delegation when no manager can be found — would make "unmanaged" the way
to bypass the control, so approval is skipped only when the tenant has explicitly turned it off
through `delegation.requireApproval`, never for want of somebody to give it.

`subordinatesOf` was added to `UserDirectory` for the approval *queue*, which is the rule read in
the other direction. Both have to read the same relationship or the queue shows a request the
approval then refuses.

### Emergency delegation — what it bypasses, and where the difference lives

It bypasses the approval and nothing else. It is bounded by `delegation.emergencyMaximumHours`
(default 72, against 90 days for an ordinary one), it carries a mandatory stated ground enforced by
a check constraint, and it is `ACTIVE` on creation with `approved_by_id` null — because naming an
approver who did not approve would be a false statement in the trail.

The brief required the difference to be **visible in the trail rather than only in a payload field**.
It is, and the mechanism is Phase 9's and Phase 10's rather than a new one: the ground is written to
`audit_event.reason`, the trail's own column, which Phase 9's widened digest attests and a verifier
can address. An ordinary delegation leaves it null. A payload field would be attested only as part
of a blob nothing can point at — which for a record of a control being bypassed is the wrong half of
the row to put it in.

**No fifth audit action was invented.** 13 §2's catalogue names four Delegation actions and the code
writes four. A `DELEGATION_DECLARED` would have put the product's vocabulary ahead of the document
that defines it, and an attested column is a stronger record than a fifth string.

### Automatic expiration — a predicate *and* a lane, for two different reasons

The two questions had to be separated, and conflating them is the mistake worth naming.

**What makes an expired delegation stop authorising?** A predicate, in the authority query's `WHERE`
and in `delegationCoversInstant`. Not a job. A delegation past its `ends_at` authorises nothing from
the millisecond it passes, whether the sweep ran last night, last week or never — so a stalled
queue, a Redis outage or a deployment that forgot to enable consumers can never leave an authority
in place. The integration suite asserts exactly this: a decision is refused after the end date
*while the row is still `ACTIVE` and nothing has swept*.

**What writes `DELEGATION_EXPIRED`?** A schedule, because 13 §2 lists the action and §2's ownership
table attributes it here. Writing it lazily when somebody next looked at the delegation would date
the event to whenever that was — and for a delegation nobody looks at again, to never, which makes
"which delegations ended last quarter" a question the trail answers *wrongly*. That is worse than
one it cannot answer.

So `identity.expire-delegations` is a declared `SCHEDULE` entry, nightly, fanned out per tenant from
`TENANT_REGISTRY.all()`, on the shape `AuditLaneConsumer` set and `RetentionLaneConsumer` followed.

It is on a **new lane**, `identity.delegation`, and that is the one piece of this the queue
catalogue's own rule argues against: lanes are separated by cost rather than by module, and a
nightly tenant-partitioned idempotent pass is cost-identical to `retention.sweep`. The obstacle is
in the adapter rather than the design. `BullMqAdapter.subscribe` constructs one `Worker` per call,
and two workers on one queue name both pull from it — so a second subscriber on `retention.run`
would race `RetentionLaneConsumer` for that lane's jobs, and each would drop the other's payloads as
unrecognised. One consumer per lane is the invariant; a lane is the cheap thing to add.

### Notification — published, not delivered

`delegation.requested` and `delegation.expired` join the two events Phase 1 declared, and all four
are published to the outbox. Nothing consumes them.

That is the position Phase 4 took for `workflow.*`, Phase 9 for `audit.chain-broken` and Phase 10
for `retention.due`, stated once more: **the outbox row is the record until a consumer exists.**
`notifications.deliver` still has none, the notification module still has templates, preferences and
a delivery service that nothing drives, and both are Phase 12's. Publishing the events is this
phase's; delivering them is not.

## 6. What was built

| Area | What exists |
| --- | --- |
| Domain | `DelegationStatus`, `DelegationKind`, `DelegationRefusal`; the period, chain, cycle and refusal rules as pure functions in `delegation.ts`, unit-tested as arithmetic |
| Settings | Four: `requireApproval`, `allowChaining`, `maximumDays`, `emergencyMaximumHours` — each a business decision rather than a constant |
| Database | `delegation`, with six check constraints and three partial indexes; `approval_task.delegation_id` with a restricting key and a pairing constraint; `audit_subject_type` gains `DELEGATION` |
| Identity | `DELEGATION_REPOSITORY` and `DELEGATION_SERVICE` bound at last; request, emergency declaration, approve, decline, revoke, the expiry sweep, and the delegation history |
| Workflow | `WORKFLOW_DELEGATION_GATE` bound; the one check Phase 4 named, relaxed in the one place it lives; the inbox widened to what a delegate may act on |
| Audit | All four Delegation actions written; `DELEGATION_USED` filed against the delegation, in the decision's own transaction |
| Queue | `identity.delegation` lane and the `identity.expire-delegations` schedule, with the third consumer to follow `AuditLaneConsumer`'s shape |
| API | Six routes under `/delegations`, with no delegator anywhere on the wire |
| Web | `/delegations` — three lists, the request and emergency forms, approve, decline and revoke; and `approvals.onBehalfOf` finally rendered, the key Phase 4 wrote for this phase |

## 7. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **Two audit rows per delegated decision** | The decision's own, and `DELEGATION_USED` | They answer different questions for different readers, and only the second makes the link attested. A delegated decision is a small minority of decisions |
| **The foreign key is unattested, permanently** | Phase 9's digest cannot be widened over a column added after it, because the table refuses the `UPDATE` | Stated rather than worked around. The `DELEGATION_USED` row carries the same fact and is chained |
| **A whole-tenant read on the creation path** | `liveEdges` loads every delegation in force to walk for a cycle | A cycle is a property of the graph, not of any pair in it, and the graph is a handful of rows — a delegation is a fortnight's arrangement, not a row per document. Three columns, from a partial index, on creation only |
| **A new queue lane for one nightly sweep** | `identity.delegation`, concurrency 1 | The adapter gives one worker per lane; sharing `retention.run` would have the two consumers race for each other's jobs. A lane is cheap; a dropped job is not |
| **The delegator's permissions are read on every delegated decision** | One `CredentialRepository.findById` inside the deciding transaction | It is the whole of §4's rule. Read once per decision for the whole candidate set, not once per delegation |
| **The inbox costs an extra Identity round trip** | `coverFor` before the query, plus a name lookup | Only for the caller's own inbox, and only one query each. Resolving it inside the read model would put a policy in a read model |
| **A tenant with no org chart needs an administrator for every delegation** | `managersOf` returns nobody | §5 above: the alternative makes "unmanaged" a bypass. `delegation.requireApproval` is the honest way out |
| **Four more settings** | The catalogue grows to sixteen | Each is a business decision a tenant genuinely differs on, and three of the four are 07 §4's own words needing a number |

## 8. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| A delegation covers permissions, not a scope | 07 §4's first row offers "all approvals, or a document type, library, or single document", and only the first is built. A scoped delegation is an ACL question — which node, inherited how — and this phase deliberately did not touch the resolver (§3) | The ACL phase, which is what would make a scope mean the same thing here as everywhere else |
| Delegation applies to approval tasks only | The overlay is bound at the engine's one check. Nothing else in the product asks `authorityFor`, so a delegation of `document:edit` is a row that authorises nothing today | The phase that gives another capability a reason to ask |
| No re-approval when a delegation is extended | There is no extend. A delegation that needs new dates is a new delegation | Nothing — this is the decision. The period somebody agreed to is the period that runs |
| A declined request writes no audit action of its own | 13 §2 names four Delegation actions and this phase wrote four. A delegation that never came into force authorised nothing, and the refusal with its ground is on the row | A catalogue that grows a fifth row, deliberately, in the document first |
| `delegation.requested` and `delegation.expired` are delivered nowhere | The Phase 4, 9 and 10 position: the outbox row is the record until a consumer exists | Phase 12 |
| No delegation widget on the dashboard | 13's, including any "who is covering for whom" summary. The screen this phase built is the working surface; a dashboard card over it is dashboard work | Phase 13 |
| The approval queue is not paged by manager | `subordinatesOf` is not transitive down the department tree — `is_manager` is a membership fact, not a position in a hierarchy, and reading it as transitive would invent a reporting line the data does not state | An org model that states reporting lines, if a tenant ever needs one |
| No MFA step-up on an emergency declaration | The obvious control on a path that bypasses a control, and MFA is Phase 14's — there is nothing to step up to | Phase 14 |
| No SIEM stream of `DELEGATION_*` | Out of scope, named by the brief | Phase 17 |

**The Phase 10 report's limit rows discharged here: none, and that is the right answer.**

Its **"no monthly partitions"** row carries a two-part trigger — twenty million rows in one tenant's
trail, or the phase that gives audit its own disposition. This phase fired neither. It adds two
audit rows per delegated decision to a table that already carries one per document view, which does
not move a volume argument, and it gives audit no disposition. The trigger is neither this phase's
to fire nor to reset, and it stands as Phase 10 left it.

Its **"no disposition or hold screens beyond the API"** row is explicitly **Phase 13's**, and is
said so here because Phase 10 named "the position Phase 9 took for the activity feed" without naming
the phase. Those screens are dashboard work; this phase built a screen for its own capability and
none for anybody else's.

Phase 10's remaining limits are untouched and belong elsewhere: the published-document delete edge,
`ON_ARCHIVE` schedules, the recycle bin's two kinds, the legal hold not blocking a restore, the
document-only delete reason, the disposition-review reminder, quota accounting, and per-batch purge.

Phase 9's **"`ACCESS_DENIED` from `AclGuard` is wired but unreached"** row is also **not** discharged
here, for the same reason Phase 10 gave: its unblocker is the phase that puts `@ScopedTo` on object
routes, and this phase added none. §3 above records the related and stronger claim — that
`PrismaAclResolver` was deliberately *not* extended, and why.

## 9. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks (three pre-existing `import()` warnings, unchanged) |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 409 API tests, plus 126 domain (up from 116 — the period, chain, cycle and refusal rules), 26 contract, 21 web, 11 utils, 4 i18n and 2 worker |
| `pnpm test:integration` | 25 files / 422 tests against real PostgreSQL, two tenant databases (up from 24 / 405) |
| `pnpm build` | Clean, API and web — including the typed `/delegations` route |
| `pnpm prisma:deploy` | Verified against two tenant databases, including the new migration and the post-migrate gate, which raises if a tenant-scoped table has no row-level security policy. `delegation` carries one |

`delegation.integration.spec.ts` carries the phase's own assertions, and each asks something only a
database can answer at an instant:

- **A delegate decides a task that stays the delegator's.** `assignee_id` is Alice before and after;
  `decided_by_id` is Bob, `on_behalf_of_id` is Alice, `delegation_id` is the arrangement — and two
  audit events exist, the decision's own and `DELEGATION_USED` filed against the delegation.
- **A decision is refused the moment the delegation is revoked**, mid-flight, with the task still
  `PENDING` and still Alice's afterwards — and Alice can then decide it herself, which is what
  "reverts to the delegator" means when nothing moved.
- **The delegation cannot be deleted once anything was decided under it.** The restricting key
  raises, so the row an investigation would ask about survives by construction.
- **A delegate is refused when the delegator's authority goes.** Alice's role is withdrawn; the
  delegation is untouched, still `ACTIVE`, still naming `document:approve`, and the decision is
  refused with `DELEGATOR_LACKS_AUTHORITY`. Restoring the role authorises the *same* delegation
  again — no new row, no re-approval.
- **A delegation covering `document:approve` does not authorise a rejection.**
- **A chain is refused by default**, permitted for exactly one hop when the tenant setting allows it
  — with the depth derived from the graph rather than taken from the caller — and **a cycle is
  refused under either setting**, which a hop counter alone would wave through.
- **A delegation past its end date authorises nothing, with no job having run.** The row is still
  `ACTIVE` when the decision is refused, which is the assertion that proves the predicate rather
  than the sweep is what makes it inert.
- **The sweep records the expiry once** and writes nothing on redelivery.
- **The inbox shows a delegate the delegator's tasks and nothing else** — the task in Bob's list is
  still assigned to Alice, and it disappears when the cover is withdrawn.
- **An emergency delegation is `ACTIVE` with no approver, and its ground is in `audit_event.reason`**
  — where an ordinary delegation's is null, which is the attested difference between the two paths.
  It is refused a period beyond the emergency maximum.
- **Nobody approves a delegation they are party to**, however many permissions they hold: the
  delegator holding every permission in the catalogue is refused, the delegate is refused, an
  unrelated person is refused, and Alice's manager — through `user_department.is_manager` and
  nothing else — succeeds.
- **A pending delegation authorises nothing.** It is not "active but unapproved".
