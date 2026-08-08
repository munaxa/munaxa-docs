# Phase 6.4 — Event Consumers & Notification Completeness

**Status: COMPLETE**

Audit first, then implement only what the audit proved missing. Three verified gaps were closed,
one authorization defect was found and fixed while tracing recipient resolution, and eleven
declarations were classified as reserved, intentionally silent or not implemented and left alone.

The Phase 6.0 audit was treated as a hypothesis, not a finding, and it was wrong in one important
place: §17 of that report said `document.approved` / `document.rejected` "exist". They exist as
notification types. Nothing had ever published the events behind them.

---

## 1. Event Architecture Audit

The path is unchanged by this phase and was verified end to end at real call sites:

```
domain event → outbox_message (same transaction as the change)
             → PrismaOutboxDispatcher (FOR UPDATE SKIP LOCKED, per tenant)
             → routesFor(eventType) → one or more lanes
             → lane consumer → NotificationEventService.handle
             → RecipientVisibilityService (ACL) → DefaultNotificationService.notify
             → notification_message → DeliveryService → transport
```

Findings about the architecture itself:

- **The outbox is the only boundary, and nothing crosses it.** No module calls a transport from
  inside a business transaction. `DeliveryService` runs on a schedule, off the write path entirely.
- **At-least-once is real and handled.** The dispatcher marks a row processed only after enqueue,
  and derives the job id from `outbox:{rowId}:{lane}` so a re-dispatch replaces rather than
  duplicates.
- **The routing table is a prefix match with a test as its safety net.** `outbox-routing.spec.ts`
  asserts every declared type routes somewhere. That test is a claim about the *table*, and this
  phase found the blind spot it cannot see: a type can route correctly and still have no producer.

## 2. Event Producer/Consumer Matrix

66 declared event types, classified from actual call sites — the factory function's usages outside
its own declaration file and outside tests — never from names, catalogues or comments.

| Class | Count | Types |
| --- | --- | --- |
| **A — produced and consumed** | 47 | All `workflow.*`, `revision.*`, `preview.*`, `retention.*`, `delegation.*`, `library.*`, `storage.*` (three of six), `audit.*`, `search.*`, `administration.*`, `organization.*`, `reporting.*`, `bulk.*`, and `document.created/published/checked-out/checked-in/moved/deleted/restored/number-assigned` |
| **C — produced, consumer missing** | 0 | — |
| **D — declared, never produced** | 10 | `document.approved`, `document.rejected`, `document.submitted`, `notification.queued`, `notification.sent`, `notification.failed`, `user.created`, `user.disabled`, `user.roles-changed`, `storage.checksum-mismatch` |
| **E — consumer never registered** | 0 | Every lane has exactly one subscriber; `composition.spec.ts` resolves them all |
| **F — obsolete** | 0 | — |

**B — produced and intentionally unconsumed** is a property of a lane rather than of a type: every
event reaches the webhook fan-out by design (Phase 17), so no type is unconsumed outright. Eleven
are on `DELIBERATELY_UNROUTED` for the search index and notification lanes, each with a stated
reason.

**Two of the ten D-class types were the phase's main finding and are now A-class:**
`document.approved` and `document.rejected` are published from `DocumentService.transition`.

**The remaining eight stay D-class**, and each is a decision recorded rather than an omission:

- `document.submitted` — `DocumentSubmittedPayload` requires a `workflowVersionId` the transition
  does not hold, and 18 §4 names no recipient for a submission. Publishing it would mean either
  widening a shipped payload or inventing a producer for a fact nobody asked to be told.
- `notification.queued` / `sent` / `failed` — declared in Phase 1 against a delivery-receipt
  model that does not exist. Their only route is back into the notification lane, where the switch
  has no branch for them. **RESERVED.**
- `user.created` / `disabled` / `roles-changed` — authorization is read from the database on the
  next request rather than projected anywhere, which is why they are on the unrouted list.
  **NOT IMPLEMENTED**, correctly.
- `storage.checksum-mismatch` — Phase 18's integrity sweep. **RESERVED.**

## 3. Notification Catalogue Audit

23 types. Traced catalogue → producer → recipient resolver → service → persistence → delivery →
UI exposure.

| Verdict | Count | Types |
| --- | --- | --- |
| **Functional end to end** | 18 | The three workflow types, five document types, four delegation types, three retention types, `bulk.operation-completed`, `security.file-quarantined`, `security.address-suppressed`, `audit.chain-broken`, `digest.summary` — minus the two below that were only nominally functional |
| **Nominally functional, now real** | 2 | `document.approved`, `document.rejected` — catalogue entry, templates, consumer branch and route all present; no producer until this phase |
| **RESERVED — no producer, capability exists** | 2 | `security.password.changed`, `security.session.revoked` |
| **RESERVED — no producer, no capability** | 1 | `security.sign-in.new-device` |

The three `security.*` types are the phase's most delicate call, so the reasoning is explicit.

`security.sign-in.new-device` needs a notion of a *known* device. Nothing in the product records
one, so there is no event that could fire. **RESERVED**, unambiguously.

`security.password.changed` and `security.session.revoked` are different: the acts happen.
`UserAdminService.setPassword` writes `PASSWORD_CHANGED` to the trail and ends every session;
`MfaService` revokes all sessions on enrolment and removal. What is missing is an *event* —
Identity publishes none for either — and creating one, routing it, and adding consumer branches
would be building a producer for a notification type rather than completing an existing path.

That is a real gap and it is named as one. It is **not** implemented here, for a reason the brief
states directly: these are `mandatory: true` security notifications, and a mandatory notification is
a control. Adding two new events, two routes and two recipient rules is new business behaviour in a
phase whose rule is to complete existing behaviour, and it deserves its own phase with its own
threat model — in particular, whether telling somebody "your sessions ended" through the same mail
path an attacker may have just compromised is the right control at all. **Backlogged as P1.**

## 4. Recipient Resolution Audit

| Recipient class | Resolver | ACL-filtered | Exists |
| --- | --- | --- | --- |
| Document owner | `document.ownerUserId` | Yes | ✅ |
| Author / creator | `document.createdBy` | Yes | ✅ |
| Approvers / assignees | event payload `assigneeIds` | Yes | ✅ |
| Escalation target | event payload `toAssigneeId` | Yes | ✅ |
| Delegation parties | event payload, both parties | No — no document to resolve | ✅ |
| Delegation approvers | event payload `approverIds`, resolved when requested | No | ✅ |
| Capability holders (`retention:manage`, `audit:view`, `user:manage`) | `UserDirectory.holdersOfPermission` | No — addressed by capability | ✅ |
| Bulk requester | operation row `requestedById` | No — the requester caused it | ✅ |
| **Watchers / subscribers** | — | — | ⚪ No subscription model. 18 §4 records it as a limit |
| **Acknowledgement recipients** | — | — | ⚪ No acknowledgement model |
| **Operators (cross-tenant)** | — | — | ⚪ ADR-0013's console does not exist; `audit:view` holders stand in, with the weakness named |

No new recipient class was created. `RecipientVisibilityService` is unchanged.

**Verified negatively**: an event that names a user explicitly does not thereby entitle them to be
told. A `workflow.task-assigned` naming a role-less user produces no message, asserted through the
real `PrismaAclResolver` rather than a stub.

## 5. Phase 6.1 Event Consumer Verification

`document.archived`, `document.reinstated` and `document.expired` are produced, route to the search
index and the notification lane, and hit **no branch** in `NotificationEventService`. The switch's
default returns zero.

**Verdict: INTENTIONALLY SILENT**, and the evidence is 18 §4 itself — the event → notification map
has no row for archival, reinstatement or expiry. The phase's stop condition applies literally: *an
event's intended recipient is undefined*. Inventing a recipient list for them would be choosing an
audience by writing a template, which is the disclosure decision §8 forbids.

The search-index half is the half that matters for these three, and it works: each resolves to its
document and the projection re-reads current truth.

## 6. Phase 6.2 Bulk Event Consumer Verification

| State | Event | Consumer | Verdict |
| --- | --- | --- | --- |
| requested (sync) | — | — | The `200` is the answer |
| queued | `bulk.operation-queued` | `documents.bulk` lane only | ✅ Correct. Not the notification lane: "your operation was accepted" is the `202` the caller already holds. Not webhooks either — how this deployment schedules its own work is not an outcome |
| running | none (row `progress`) | polled through the bulk API | ✅ A row, not an event — a progress event per batch would be a storm |
| completed (sync) | `bulk.operation-completed` | notification lane, coalesced per requester | ✅ |
| completed (async) | `bulk.operation-completed` | same | ✅ Verified: `BulkExecutor.complete` publishes from the consumer's finishing transaction |
| **failed** | **none** | — | 🟠 **GENUINE GAP, not implemented** |

A bulk operation that dies terminally writes `FAILED` to `bulk_operation` and publishes nothing, so
the requester is told only if they look. Closing it would require a `bulk.operation-failed` event
**and a new notification type**, and Step 12 forbids creating a notification type to make the
architecture look complete. The requester is not left blind — the operation's state is on its own
API — so this is recorded as a product-surface gap rather than worked around. **Backlogged as P2.**

`bulk.operation-completed` also had no **UI label**: it and `digest.summary` fell through to the
generic "Notification" fallback that `type-labels.ts`'s own comment calls unhelpful. Both now have
`en` and `ar` labels. That is a table entry, not a feature.

## 7. Outbox/Dispatcher Verification

| Property | Where | Verdict |
| --- | --- | --- |
| Registration | one consumer per lane, asserted by `composition.spec.ts` | ✅ |
| Transaction boundary | `outbox.publish` inside the business transaction; enqueue after commit | ✅ |
| Idempotency | `jobId = outbox:{rowId}:{lane}` | ✅ |
| Tenant context | `runWithContext(systemContext(tenantId))` per job, tenant from the payload | ✅ |
| Retry | BullMQ lane policy; unroutable rows marked processed rather than retried forever | ✅ |
| Failure | per-tenant pass isolation; a failed enqueue backs the row off rather than blocking the queue | ✅ |
| Duplicate delivery | every consumer idempotent on `eventId` | ✅ |
| Ordering | not guaranteed, and not assumed — the notification path is per-event | ✅ |

**No notification delivery can partially commit a business transaction.** Delivery is a scheduled
pass reading committed rows; message *creation* runs in the consumer's own transaction, downstream
of the commit that produced the event. This was the property most worth checking and it holds.

## 8. Idempotency Report

| Consumer | Key | Double delivery | Retry after failure | Loss on failure |
| --- | --- | --- | --- | --- |
| `NotificationEventService` (per-event) | `(eventId, recipientId, channel)`, unique index | Second delivery creates nothing | Job retried, same key | Outbox row stays unprocessed until enqueued |
| Coalescing windows | `accumulate` increments; `claimClosed` deletes in the claiming transaction | Redelivered release finds nothing | — | — |
| Batch summary | `batch:{key}:{releaseAt}` | Cannot double-send | — | — |
| Suppression alert | `suppression:{maskedAddress}:{bounceCount}` | One alert per crossing | — | — |
| Delivery | transport `idempotencyKey = messageId` | Provider deduplicates | **New in this phase** — see §12 | Row keeps its state and reason |

Traced to the unique index, not inferred from the dispatcher's guarantees.

## 9. Tenant Isolation Report

Every notification query carries `requireContext().tenantId`, and under ADR-0015 the tenant is a
whole database. Verified against the two-tenant PostgreSQL environment:

- Tenant A's event produces messages only for tenant A recipients.
- A manipulated recipient id — a well-formed UUID belonging to nobody in this tenant — matches no
  row and changes nothing.
- A deleted or disabled user is skipped by `subjectFor`, which returns null rather than refusing:
  there is nobody to decide about.
- A stale recipient id that once held access is refused by the ACL walk at send time, not by a
  cached answer — visibility is never cached, deliberately.
- System-level events (`audit.chain-broken`, `storage.file-quarantined`) resolve their recipients
  from `holdersOfPermission` inside the tenant's own context.

## 10. Authorization Report

**One defect found, fixed, and proved by test.**

`NotificationController` documents its own security property: *"every route here is about the
caller's own notifications, and none takes a user identifier — that absence is the authorisation."*
It was true of four routes out of five. `POST /notifications/:id/read` takes an identifier, and the
predicate behind it was `(id, tenantId)`. Any signed-in user holding `notification:manage` — a
permission seeded to **every** role, `GUEST` included — could clear a colleague's unread marker
using an id they had seen or guessed. Message ids are UUIDv7 and therefore time-ordered.

It is an integrity defect rather than a disclosure: the route answers `204` either way, so it is not
even an oracle for whether an id exists. But it made a stated control false, which is the definition
of a phantom control this phase exists to find.

The predicate now carries `recipientId`. No new permission, no new model, no API change. Two
integration tests hold it closed, and **both were confirmed to fail against the old predicate**
before the fix was restored.

Everything else verified as sound: the inbox, unread count, mark-all-read and preference routes take
no subject; the admin controller sits behind `settings:manage`; recipient resolution runs the real
ACL resolver per recipient per send.

## 11. Sensitive Data / Logging Report

| Concern | Finding |
| --- | --- |
| Document contents | Never in a payload. Notifications carry title, number and a link |
| Signed URLs | None. `documentLink` is an ordinary route that resolves through normal authorization |
| Storage keys | Absent |
| Access tokens / secrets | Absent. Template rendering refuses a placeholder the type does not declare, asserted by a test that tries `{{password}}` |
| Email addresses in logs | Redacted. Delivery logs the reason and never the address; suppression logs and audit payloads carry `a***@domain` |
| Audit payloads | The suppression row carries the masked address and the count, filed against the nil user id rather than a person |
| Inbox API | Returns `id`, `typeKey`, `subject`, `bodyText`, `createdAt`, `readAt`. No `address`, no `bodyHtml`, no `failureReason` |
| New logging in this phase | The delivery-failure line adds `attempts` and `willRetry`, both integers |

No change needed.

## 12. Delivery Failure & Retry Report

**This was the second real gap, and the largest.**

18 §7's provider-outage row asks for "exponential backoff, capped attempts, dead-letter queue with
operator visibility". Every other row in that table is marked *Built in Phase 12*. This one was
built nowhere:

- a transient failure wrote `DeliveryState.FAILED`;
- `claimQueued` selects `state: QUEUED`;
- `DeliveryState.FAILED` appeared in exactly **one** place in the entire product — the assignment
  that produced it. No query read it;
- `attempts` had been incremented on every attempt since Phase 12 and consulted by nothing.

So a mail provider unreachable for sixty seconds lost every email queued in that minute,
permanently and silently. The in-app copy survived — that row *is* its delivery — which is why the
loss was invisible from any screen.

Completed using the columns that already existed, with no new subsystem:

| Piece | Implementation |
| --- | --- |
| Backoff | `release_at` set to `now + min(300s, 2^attempts s)` — the same curve and cap as the outbox dispatcher, so a deployment has one to reason about |
| Withholding | none: `claimQueued` already declines a `QUEUED` row whose `release_at` is in the future. That predicate is what quiet hours and digests are built on |
| Capped attempts | `MAX_DELIVERY_ATTEMPTS = 5`, a constant rather than a setting — how often to re-dial a mail server is plumbing, not a policy a quality manager has a view on. The bounce *threshold* stays a setting because that one is about people's mailboxes |
| Dead letter | the fifth attempt leaves `FAILED` with its reason and **no** `release_at`, so nothing resurrects it |
| Operator visibility | `notification.delivery.failures{channel, outcome}`, where `outcome` is `retrying` or `terminal`. Alerting belongs on the second; the first is what a blip looks like. Both labels are bounded sets |
| Escalation | the log line moves from `warn` to `error` when the attempts are spent |

A hard bounce is untouched: it still suppresses on the first attempt with no backoff, because
repeating a send to a mailbox that does not exist only damages the sending domain's reputation.
That distinction has its own test, so the retry cannot quietly swallow it.

**Not fixed, and named:** `claimQueued` does not use `FOR UPDATE SKIP LOCKED`, so two concurrent
delivery passes could claim one message. The transport's `idempotencyKey` is the message id, so the
provider deduplicates. Pre-existing, out of this phase's scope, **backlogged as P3**.

## 13. UI/API Coverage Report

| Capability | API | UI | Verdict |
| --- | --- | --- | --- |
| Inbox, paginated | `GET /notifications` | notifications screen | ✅ |
| Unread state / count | `GET /notifications/unread-count` | screen + dashboard tile | ✅ |
| Mark read / mark all read | `POST /notifications/:id/read`, `/read-all` | screen | ✅ — authorization fixed this phase |
| Tenant filtering | every query | — | ✅ |
| Recipient filtering | every query | — | ✅ |
| Preferences, quiet hours | `GET/PUT /notifications/preferences` | screen | ✅ |
| Template overrides | `admin/notifications/templates` | admin screen | ✅ |
| Suppressions | `admin/notifications/suppressions` | admin screen | ✅ |
| Type labels | — | `type-labels.ts` | ✅ — two missing entries added |
| **Failed / dead-lettered messages** | none | none | 🟠 Metric only. A list would be a new admin surface |
| **Event-to-notification traceability** | `idempotency_key` holds the event id | not exposed | 🟠 Present in the data, absent from every screen |

No notification centre was built; one exists. The last two rows are product-surface gaps, recorded
rather than filled — Step 11 says not to turn this phase into a frontend change.

## 14. Implemented Changes Report

| # | Change | Files |
| --- | --- | --- |
| 1 | Publish `document.approved` and `document.rejected` from the transition that performs them | `document.service.ts` (`announce`) |
| 2 | Carry the reviewer's comment to the rejection event without touching the audit payload's `reason` | `workflow-engine.service.ts`, `workflow/application/ports.ts`, `document-context.adapter.ts`, `document.service.ts` |
| 3 | Retry transient delivery failures with capped attempts and backoff | `delivery.service.ts`, `notification.ports.ts`, `prisma-notification.repositories.ts` |
| 4 | `notification.delivery.failures` counter | `core/observability/metrics.ts`, `delivery.service.ts` |
| 5 | Scope `markRead` to its recipient | `prisma-notification.repositories.ts`, `notification.service.ts`, `notification.ports.ts`, `notification.controller.ts` |
| 6 | UI labels for `bulk.operation-completed` and `digest.summary` | `type-labels.ts`, `en.ts`, `ar.ts` |
| 7 | Tests: 3 delivery-retry, 4 recipient-scoping and isolation, 3 producer regression | `notification.integration.spec.ts`, `workflow-engine.integration.spec.ts` |
| 8 | Correct 18 §4's false claim and 18 §7's unbuilt row | `18-notification-architecture.md` |

**Change 2 deserves its own note.** The obvious implementation is to widen the transition's
`reason` to carry the reviewer's words. That field has held the *stage outcome* — the literal
`REJECTED` — since Phase 4 and is written into the audit payload's `after`, so widening it would
change the shape of eighteen phases of trail rows to improve one email. `decisionComment` is a
separate, optional field that the trail does not read.

It also produced the phase's most instructive bug. The field was declared on both sides and
correctly populated, and the notification still rendered "Reason: REJECTED", because
`document-context.adapter.ts` — the seam between the engine's port and Document's use case — copied
the fields it knew about and dropped the new one. A field an adapter does not forward is a field the
use case never sees, however carefully both sides declare it. Only a test that ran the real path
found it.

## 15. Deleted Code Report

**Nothing was deleted.** No dead code was found: the ten never-produced event types are declarations
with stated future purposes, not orphans, and `DeliveryState.FAILED` — the one value that was
written and never read — is now read.

## 16. Dependency Reduction Report

No dependency added, removed or upgraded. No new module, port or symbol beyond one metric name in
an existing catalogue and one optional field on two existing interfaces. `RecipientVisibilityService`,
`AclResolver`, the outbox, the queue and the settings catalogue are untouched.

## 17. Validation Report

Every gate executed against real infrastructure — PostgreSQL 16, both tenant databases, Redis. None
skipped.

| Gate | Result |
| --- | --- |
| `pnpm install` | up to date |
| `pnpm format:check` | pass |
| `pnpm lint` | 0 errors, 3 warnings (pre-existing) |
| `pnpm typecheck` | 13/13 |
| `pnpm test` | 636 API, 164 domain, 82 web, 26 contracts, 11 utils, 4 i18n, 2 worker — 1 skipped (pre-existing) |
| `pnpm test:integration` | **617 passed, 33 files, 0 skipped** |
| `pnpm build` | 9/9 |
| `pnpm verify:styles` | 10/10 |
| `pnpm test:visual` | 28 |
| Accessibility | not run — no component markup changed; the only UI change is two entries in a label map |
| Two-tenant isolation | included above; `tenant-isolation.integration.spec.ts` 6/6 |

Integration rose from 607 to 617: ten new tests, no test removed or weakened.

**Two fixes were verified by reverting them.** The recipient-scoping predicate was removed and both
isolation tests failed with the exact cross-user write they describe. The producer change was
verified the other way: the assertions were written before it and failed against the old code.

## 18. Architecture Compliance Report

| Rule | Held |
| --- | --- |
| The API never enqueues inside a transaction (ADR-0011) | ✅ unchanged — the new event is an outbox row |
| Notification never reached from a domain transaction | ✅ unchanged |
| Recipient lists derived from documents pass the ACL resolver (18 §8) | ✅ unchanged; the two new events use the existing `documentEvent` branch, which filters |
| A shipped event's payload shape does not widen | ✅ both payloads used as declared in Phase 3 |
| Audit payload shapes unchanged | ✅ `reason` still carries the stage outcome |
| `core/**` never depends on a module | ✅ the metric name is declared in core and consumed by a module |
| Permission semantics unchanged | ✅ no permission added, removed or re-scoped |
| One consumer per lane | ✅ unchanged |

## 19. Remaining Event/Notification Backlog

| # | Item | Why not now | Priority |
| --- | --- | --- | --- |
| 1 | `security.password.changed` / `security.session.revoked` producers | Needs two new Identity events and their threat model; §3 | P1 |
| 2 | `bulk.operation-failed` notification | Needs a new notification type, which Step 12 forbids; §6 | P2 |
| 3 | `ChangesRequested` notification | 18 §4 names it; no event is declared and inventing one is a new type | P2 |
| 4 | Dead-letter admin surface | Metric exists; a list is a new admin screen | P2 |
| 5 | `claimQueued` without `SKIP LOCKED` | Pre-existing; the transport deduplicates | P3 |
| 6 | Watchers / subscribers; acknowledgement recipients | No model exists; 18 §4 already records both as limits | P3 |
| 7 | `security.sign-in.new-device` | No known-device model | P3 |
| 8 | Cross-tenant operator channel for `audit.chain-broken` | ADR-0013's console does not exist | P3 |
| 9 | Inbound provider delivery receipts | Phase 12's open row | P3 |
| 10 | Event-to-notification traceability in the UI | The link exists in the data | P3 |
| 11 | Search projection staleness on `SUBMITTED` / `UNDER_REVIEW` / `CHANGES_REQUESTED` | Those transitions publish nothing; the index catches up at publication | P3 |

## 20. Phase 6.4 Final Status

**COMPLETE.**

Not because every event now has a consumer — it does not, and should not. Ten declared types have no
producer, three lifecycle events are deliberately silent, and eleven families are deliberately
unrouted. Each is classified against evidence and left alone.

Complete because the three things that were *false* are now true:

1. Two of 18 §4's named notifications had never been sent to anybody. They are now published from
   the transition that performs the act, with a regression test that runs the real approval.
2. A provider outage silently and permanently destroyed queued email. It now backs off, retries a
   capped number of times, dead-letters visibly, and is counted.
3. A controller documented an authorization property that one of its routes did not hold. It holds
   now, and two tests confirmed to fail against the old code keep it holding.

And because the architecture's own prose has been corrected where it was wrong: 18 §4 claimed every
row but two had a producer, and 18 §7's provider-outage row described behaviour nothing implemented.

Three limitations are stated rather than worked around: mandatory security notifications with no
producers, a failed bulk operation that tells nobody, and no dead-letter screen. None was fixed by
inventing business functionality, which is the outcome the phase asked for.
