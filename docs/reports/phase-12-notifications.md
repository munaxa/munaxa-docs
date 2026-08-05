# Phase 12 — Notifications: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Notifications phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 13 and after, and whoever audits what Phase 12 claimed.

Phase 1 built the entire notification framework and gave it nothing to notify about. Its own README
said so in one sentence — *"what exists is the pipeline and its tests"* — and that sentence stood
for eleven phases.

`notify(type, recipients, values)` resolved recipients through `USER_DIRECTORY`, resolved channels
through tenant policy → user preference → type default, picked a tenant override or the shipped
template, rendered by substitution and nothing else, and persisted one `QUEUED` row per
`(recipient, channel)`. `DeliveryService.deliverBatch` sent through `NOTIFICATION_PORT` in one
transaction per message, so one hard bounce could not roll back the forty-nine that went out. The
idempotency key was `(eventId, recipientId, channel)`, unique per tenant.

The catalogue held **three** types, all `security.*`, with a comment that read like a schedule:

> Document, workflow and retention types arrive with the phases that raise them — a catalogue entry
> for a notification nothing sends is an entry nobody can test.

Those phases have all now happened. Four of them deferred delivery here in the same words —
**the outbox row is the record until a consumer exists** — Phase 4 for `workflow.*`, Phase 9 for
`audit.chain-broken`, Phase 10 for `retention.due`, Phase 11 for the four `delegation.*`. And
`notifications.deliver` was the last declared lane in the product with no subscriber.

So this phase's job was almost entirely to *call* what already existed, and to answer the four
questions 18 left genuinely open. It rebuilt none of the pipeline.

## 1. The routing table was wrong, and only this phase could see it

`routesFor` in `prisma-outbox.dispatcher.ts` is a prefix match. Its comment defended that choice
against a per-module registry with a specific claim:

> A prefix is derived from the aggregate name, which the event type already carries, so a new event
> in an existing module routes correctly with no change here at all.

**That claim is false**, and the evidence had been accumulating since Phase 11 shipped. Phase 11's
four events are named `delegation.requested`, `delegation.approved`, `delegation.revoked` and
`delegation.expired`. Their aggregate is `identity`. No prefix matched them. Every one had been
claimed, found unroutable, and marked processed — *"An event nothing consumes. Marked processed
rather than retried forever"* — from the day it was published. Phase 11's report says the events are
"delivered nowhere" and attributes it to the missing consumer; the consumer was only half the reason.

The failure mode is exactly the one the comment predicted for a registry — an event that "silently
stopped being delivered" — occurring in the prefix table instead, because the premise is wrong. A
prefix is not derived from the aggregate name. It is derived from whatever string the module chose
for its event type, and nothing checks that the two agree.

**The registry was reconsidered on that evidence and still rejected**, for a reason this phase
discovered rather than inherited. A route is not the only thing the notification consumer needs to
know about an event: it must switch on the event type *anyway*, to decide who the recipients are and
what each template placeholder means. A registry would move the routing half of that decision into
the publishing module and leave the recipient half in the consumer — one question, answered in two
files in two modules, that must agree. The prefix table keeps both halves inside one switch.

What makes forgetting **detectable** instead of silent is a test rather than a registration:
`src/__tests__/outbox-routing.spec.ts` asserts that every event type in every module's
`*_EVENT_TYPES` list routes somewhere or is named in an explicit "deliberately unrouted" list, and
that every family 18 §4 names reaches the notification lane. That is the property a registry would
have bought, and it would have caught `delegation.*` in Phase 11.

The table gained `delegation.*`, `audit.*` and `storage.*`, and `document.*` and `retention.*`
gained the notification lane beside the search one. `revision.*` deliberately did **not**: publishing
a revision and publishing a document are one act, and routing both would notify twice about one
thing.

## 2. Three events that did not exist, because one event meant three things

`workflow.stage-activated` was published in three places: when a stage activated, when a reminder
timer fired, and when a deadline passed under `NOTIFY_ONLY`. Identical payloads, three meanings.

That was harmless while nothing consumed it. It stopped being harmless the moment 18 §4 asked for
three *different* notifications from it — "your approval is needed", "this is still waiting for you"
and "this passed its deadline" — which are three different things to say to the same person about
the same task.

So the workflow engine publishes `workflow.task-assigned`, `workflow.reminder-due` and
`workflow.overdue`. Three event types rather than a discriminator field, because a field would have
changed a shipped payload shape — which 02 §6 forbids — and would have made every consumer branch on
it to discover whether the event was for them. That is precisely the argument Phase 11 gave for
splitting `delegation.requested` off `delegation.approved`.

`workflow.stage-activated` is unchanged and still published at activation. It is the *workflow* fact
— a stage became active — and is wanted whether or not anybody is told. The three new ones carry the
document and the stage name, because §4's fourth principle is that a notification "carries enough
context to act", and resolving a stage index back to a name in the consumer would mean reading
Workflow's aggregate from another module to render a sentence.

## 3. The four things the specification left open

### Digests — a held message is a state, and the list is composed rather than templated

`DigestFrequency` had four values since Phase 1 and nothing read one; `digestible` was on every
catalogue entry and nothing read it; quiet hours existed nowhere at all.

**What a held message *is*** had three candidate answers and the report of the rejected two matters.

*A `QUEUED` row nothing collects* — a `release_at` in the future, invisible to the delivery claim —
works, and was rejected. An operator asking "what is waiting to go out" would get one number
covering both a mail outage and a quiet-hours hold, which are the two conditions that most need
telling apart.

*A window on the delivery query alone* is the same answer with the column moved into a `WHERE`.

So: **`release_at` gates the claim, and the state says why the row is not moving.** `DeliveryState`
gained `HELD` and `DIGESTED`. Two rather than one, and neither is a synonym for an existing value —
a digested message is emphatically not `SUPPRESSED`, because suppression means an address that must
not be written to and overloading it would make "how many addresses are we refusing" a question the
table answers wrongly. The brief warned that adding a sixth value changes a column an existing table
already writes; adding two is honest about what the column now has to say, and the migration is
additive with neither value used inside it.

**A digest's values are a list, and the renderer does substitution only** — deliberately, for the
server-side-execution reason `template.ts` states at length. The list is therefore not built by the
template. `composeDigestItems` assembles the collected subjects into one plain-text value in code,
and the renderer escapes it exactly as it escapes a document title. The template language gained no
loop, no conditional and no property access; the digest gained a list. One rendering rule was
added — an escaped value's newlines become `<br>` in an HTML body, *after* escaping — which is a
statement about whitespace and cannot introduce markup.

**The accumulator is the held rows themselves.** Nothing is kept in memory, nothing is keyed on an
"open digest" record, and a process that dies mid-window loses nothing. Which window a message
waits for is stored on the message rather than re-read from the preference at collection time,
because the two answers differ the moment somebody changes their mind mid-window and the honest one
is the choice that was in force when the message was held.

**Quiet hours** are per *person*, in their own table, not per `(user, type)` like preferences:
nobody wants to be quiet for approvals and loud for publications at three in the morning. The window
is minutes past local midnight plus an IANA zone, because "do not write to me between 19:00 and
07:00" is a rule about a clock face and two timestamps would expire. A start after the end wraps
midnight, which is the ordinary case rather than a special one.

"Non-urgent" needed a value. `NotificationUrgency` is 18 §4's own last column, and it is a different
question from both flags beside it: `mandatory` asks whether a preference may silence a type,
`digestible` whether a rollup may delay it, and neither says whether waking somebody at 03:00 is
warranted.

**In-app is never held, on either mechanism.** §3's first row calls it "the authoritative inbox:
every notification lands here regardless of other channels". Quiet hours are about being
interrupted, and a row in an inbox nobody is looking at interrupts nobody; a digest exists to
replace a stream of *emails*.

The two holds **compose**: a message caught by both waits for the later window, because a digest
delivered at 03:00 would defeat the quiet hours it was collected under.

### The two ports files — merged, and what did not survive

`application/ports.ts` (the Phase 0.5 sketch) is deleted. `application/notification.ports.ts` is the
whole contract, as the module README said it would be: *"they merge when the Phase 0.5 stubs'
remaining methods — digests, delivery receipts — are built by the phase that owns them."*

Nothing outside the module imported either file, so the merge cost nothing. What is worth recording
is that the sketch was not simply superseded — three of its shapes were **wrong**, and the file
says why. Its `notify` took a `templateKey`, which is a caller choosing a channel on the recipient's
behalf. Its message record carried no rendered text, which would have let a template edited in
March change what the record says was sent in February. Its preference repository was per user
rather than per `(user, type)`, which cannot express "email me approvals and nothing else" — the
preference §5 exists for. Its `digest` field on the preference *was* right, and had nothing reading
it until now.

### Bounce handling — a table of addresses, not a column on a user

18 §7 says repeated hard bounces suppress the address and alert an administrator. `DeliveryReceipt`
had carried `permanentFailure` since Phase 0.5 and nothing acted on it; `DeliveryState.SUPPRESSED`
existed and nothing wrote it.

Three homes were considered. A **column on the user** is unavailable — Identity owns users and
nobody reads its tables — but that is the weaker objection. A **count derived from
`notification_message`** makes an operational decision a scan over history that can never be cleared
without deleting the record of what was sent. A **table of addresses** wins on the strongest
argument: suppression is a fact about a *mailbox*. Somebody who corrects their address is reachable
again immediately, and somebody who inherits a colleague's old address does not inherit their
bounces.

The threshold is a tenant setting defaulting to three, not one, because a provider occasionally
reports a transient condition as permanent and cutting somebody off from every notification in the
product on one such report is the worse failure. The crossing — and only the crossing — writes
`NOTIFICATION_SUPPRESSED` to the trail and alerts the administrators. Every subsequent bounce is
counted and says nothing, because an administrator told forty times about one dead mailbox stops
reading the alert, which is the failure §1's fifth principle exists to prevent.

A suppressed address still produces a `SUPPRESSED` **message row** rather than no row. §8's last
prohibition is "silently dropped on failure", and "we did not try, because this address is dead" is
exactly what somebody investigating needs to read.

### A mail adapter — one, and the enum's other value refuses at boot

`MAIL_DRIVER` accepts `NONE`, `SMTP` and `RESEND`, and only `UnconfiguredNotificationAdapter`
existed. The choice between the two real drivers was decided by **testability**, not preference.

An HTTP adapter can be exercised: `fetch` is a constructor parameter, and every response class the
adapter must classify is reachable from a unit test running in CI with no outbound network. An SMTP
adapter cannot be exercised anywhere this repository builds — it needs a socket, a server, a TLS
negotiation and a multi-step protocol, and this environment can add no dependency (the lockfile
cannot be regenerated without registry access to `@munaxa/*`), so it would have been hand-rolled
*and* untested. "A provider you cannot test in CI is a provider whose failure modes you are guessing
at" applies to both — but it applies to *all* of an untested SMTP client and only to the wire of a
tested HTTP one.

So `ResendMailAdapter` exists and `MAIL_DRIVER=SMTP` is **refused at boot**, naming the decision.
That is the `OCR_DRIVER=HOSTED` precedent exactly: a value the schema accepts and no adapter
satisfies fails to start rather than failing when an approver is not told about an approval. CI
still runs `MAIL_DRIVER=NONE`, and the honest limit is stated in §7 below: the wire protocol is
exercised by neither suite. What *is* tested is the part everything else depends on — which failures
are permanent, including the two that sit on the wrong side of the 4xx line (429 is transient; 401
and 403 are transient *for the address*, so a wrong API key cannot suppress a whole directory one
bounce at a time).

**Branding.** 18 §6 names `platform/themes/docs/brand.ts` as the source of the email hexes. The API
depends on no `@munaxa/*` package — it renders no UI — and pulling the design system into a NestJS
process to read four strings would put a React peer dependency in the API's tree. The three values
are therefore **settings**, whose defaults carry the Docs brand hex with its provenance recorded.
That is also the stronger reading of §6's own words: "tenant branding" means a tenant with its own
brand gets its own colour, which a fixed import could never have given. The email layout is a
single-column table with inline styles and `dir="rtl"` for Arabic, because mail clients are not
browsers.

## 4. The named risk: a recipient list is a set of claims about who may see a document

18 §4's rows say things like "watchers, subscribers of the folder or type, and readers where the
type marks the document as requiring acknowledgement". Every one of those is a question about who
may **see** a document, and `PrismaAclResolver` is the only thing entitled to answer it (08 §3).

The failure this phase could have shipped without noticing is quiet and total. Somebody is removed
from a project's folder, keeps an approval task assigned before the change, and is emailed
"QMS-PROC-0042 — Supplier Audit Procedure has been rejected. Reason: the tolerances in section 4 are
wrong." They click the link and are correctly refused — having already learned the document's
number, its title, its state and a sentence of its content. **A notification that tells somebody a
document exists is a disclosure even when the link then refuses them**, which is §8's third and
fourth prohibitions read together.

`RecipientVisibilityService` is the answer, and the decisions in it are worth stating.

**Where it filters.** Every recipient list derived from a document, before anything is rendered. An
approval task's assignees are filtered too — holding a task is not the same as being able to read
the document, and a task outlives the permission that justified it.

**Where it does not.** Lists with no document behind them: the two parties to a delegation, an
administrator told an address was suppressed, a person told their own password changed. There is no
object to resolve, and §4 names those people by their relationship to the event. Passing them
through a document walk would refuse every one of them.

**The ACL resolver is unchanged**, and this is the second consecutive phase to decline to extend it.
Nothing new was needed: `AuthorizationSubject` has always been a *parameter* rather than the request
context, so `resolve` already answered questions about somebody other than the caller. What was
missing was a way to build a subject for a recipient, and that went on `USER_DIRECTORY` —
`authorizationSubjectFor` — beside the four routing lookups Phase 4 put there for the same reason.
It returns **no delegations**: 08 §3 lost its "active delegations" clause in Phase 11 rather than the
resolver gaining a subject, and a recipient's visibility must not depend on cover they were given.

**Nothing is cached.** The walk costs one query per recipient per document event. Caching it would
mean choosing how long a stale "yes" is acceptable for, and for a disclosure question that is zero.

## 5. The second risk: the storm, and where coalescing lives

18 §7's last row requires bulk operations to emit **one summary notification, never one per
object**. The idempotency key does nothing about it: it prevents duplicates of *one* event, and a
sweep produces five hundred distinct ones.

The mechanism is a **row that increments** — `notification_batch`, one open window per operation —
and the rejected alternative is instructive. A delayed job whose id encodes the batch *would*
coalesce, exactly as the search projection's debounce does. It would also keep the **first**
payload and discard the rest, because that is what a repeated job id means. A summary of five
hundred purges would say "1". A row is the only shape that can count.

The window's end is set when it opens and never extended, so a sweep that runs for an hour produces
one summary at the window mark and another for the remainder — rather than a window that never
closes because objects keep arriving. Windows are deleted as they are claimed, in the same
transaction that reads them, so a redelivered release finds nothing.

**Which operations it covers.** `retention.due` — the disposition-review reminder Phase 10 left
owing — is coalesced per tenant per day, and a nightly sweep settling five hundred schedules
produces one message reading "500 documents are due for retention review". That is the only form of
that message anybody would read, and it is asserted in the integration suite with five hundred real
events.

**Which it does not, and why that is not a gap.** The other bulk paths named in the brief produce no
per-recipient storm. A folder delete cascading over its documents raises `document.deleted`, and 18
§4 names **no recipient for a deletion** — inventing one to have something to coalesce would be
building a capability rather than notifying about one. A delegation expiry sweep produces one
notification per person about their *own* delegation, which is not a storm for anybody. A search
rebuild notifies nobody.

## 6. What was built

| Area | What exists |
| --- | --- |
| Domain | `NotificationUrgency`; `DeliveryState.HELD` and `DIGESTED`; quiet-hours and digest-window arithmetic as pure functions, unit-tested; the RTL/LTR email layout |
| Catalogue | Nineteen new notification types — one per row of 18 §4 that has a producer — with EN and AR templates for every channel each one offers |
| Settings | Six: three branding values, the digest hour, the bounce threshold, the coalescing window |
| Database | `notification_quiet_hours`, `notification_suppression`, `notification_batch`; `release_at`, `digest_window` and `digest_message_id` on `notification_message`; two enum values |
| Notification | The lane consumer; the event→notification translation; the digest collector; the coalescing accumulator and release; bounce counting and suppression; the ACL-filtered recipient walk; the merged ports file |
| Workflow | Three events — assignment, reminder, overdue — where one event had carried three meanings |
| Identity | `holdersOfPermission` and `authorizationSubjectFor` on `USER_DIRECTORY` |
| Outbox | `delegation.*`, `audit.*` and `storage.*` routed for the first time; `document.*` and `retention.*` routed to the notification lane; a test that asserts no published event goes unrouted |
| Infrastructure | `ResendMailAdapter`; `MAIL_DRIVER=SMTP` refused at boot |
| Permissions | `notification:manage`, seeded to every role — the widest `own` scope in the catalogue |
| Audit | `NOTIFICATION_SUPPRESSED` added to 13 §2's Security group, with its reasoning, and written |
| Queue | Five schedules on `notifications.deliver`, and the lane's first consumer |
| API | Nine routes under `/notifications` (none naming a recipient) and seven under `/admin/notifications` |
| Web | `/notifications` — the inbox, per-type preferences and quiet hours; `/admin/notification-templates` — template editing and the suppression register |

## 7. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **One ACL walk per recipient per document event** | Not batched, not cached | It is the phase's central safety property. The walk is a two-table read, and a document event has single-digit recipients |
| **Two enum values on a column an existing table writes** | `HELD` and `DIGESTED` | Additive, unused inside their own migration, and each is a truthful position no existing value expressed |
| **Three tables and three columns for one capability** | Quiet hours, suppressions, batches | Each answers a question the others cannot, and §3 records the rejected single-table alternatives |
| **A minute of latency on every email** | Delivery is a schedule, not a job per message | A provider is reachable or it is not; fifty delayed jobs discovering an outage separately produce fifty backoff curves where one belongs. In-app is unaffected — it is delivered by being written |
| **The digest collector holds one transaction over a whole pass** | Claim and `DIGESTED` transition must be atomic together | A crash between them would leave messages a summary already names still waiting to be sent individually. The pass is bounded at two thousand messages |
| **A permission every role holds** | `notification:manage` | 15 §5 asserts at boot that every mutating route declares one, and no existing permission fits: `document:view` was the near miss and is wrong, because somebody with no document permission still receives security notifications and could then not read them |
| **Six more settings** | The catalogue grows to twenty-two | Each is a business decision a tenant genuinely differs on, and three of the six are 18 §6's own words needing a value |
| **Two more events published at stage activation** | `stage-activated` and `task-assigned` | They are two facts — one about the workflow, one about the people — and 18 §4 needs the second to say anything useful |

## 8. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| **No SMTP adapter**; `MAIL_DRIVER=SMTP` refuses at boot | §3 above: an untested hand-rolled SMTP client is a larger risk than an unbuilt one, and this environment can add no dependency. 18 §3 wants SMTP for on-premise | Phase 18 — production readiness, where on-premise deployment is the subject |
| **The hosted adapter's wire is exercised by no suite** | CI runs `MAIL_DRIVER=NONE` and has no outbound network. What *is* tested is the classification everything else depends on | A deployment with a provider account, or a recorded-fixture harness |
| **No watchers and no subscriptions** | 18 §4's `DocumentPublished` row names "watchers, subscribers of the folder or type"; there is no such model. The built list is the document's owner and author | The phase that builds subscription, which is a capability rather than a notification |
| **`RevisionPublished` notifies nobody** | Its recipients are "everyone who acknowledged the previous revision", and there is no acknowledgement model. A catalogue entry keyed to a table that does not exist is the entry Phase 1's rule forbids | The phase that builds acknowledgement |
| **`LockExpiring` notifies nobody** | Phase 6 built check-out expiry as a predicate a later operation sweeps against, not as a scheduled event. Nothing fires | A timer on the lock, if a phase ever needs one for its own sake |
| **The chain-broken alert goes to tenant users, not to an operator** | Its recipient is an operator, and ADR-0013's cross-tenant console does not exist. It goes to holders of `audit:view` — the closest thing this deployment has, and who a compliance incident is escalated to anyway. **If the tenant's trail is broken by somebody inside the tenant, the alert may reach them** | ADR-0013's operator console |
| **No delivery receipts beyond acceptance** | `providerMessageId` is recorded and nothing consumes a provider webhook that would say what became of the message | Phase 17, which builds inbound webhooks |
| **No dead-letter visibility for notifications** | The lane declares one, per the queue catalogue, and nothing surfaces it | The operator surface that surfaces any of them |
| **A digest is per recipient, not per recipient and type** | §3 says "hourly or daily rollup per user"; a per-type digest would be several emails an hour, which is the volume problem inverted | Nothing — this is the decision |
| **No unread badge anywhere but the notification screen** | `GET /notifications/unread-count` exists and is the endpoint a badge would call. Where it renders is the dashboard's | Phase 13 |
| **No push and no SMS** | 18 §3 marks push "Future — the port and the message model already accommodate it; no code is written in anticipation" | The phase that decides push is wanted |
| **No SIEM stream of `NOTIFICATION_SUPPRESSED`** | Out of scope, named by the brief | Phase 17 |

## 9. Limit rows discharged from earlier reports

**Phase 11's "`delegation.requested` and `delegation.expired` are delivered nowhere" — discharged.**
All four `delegation.*` events are consumed. §1 above records the part its report could not have
known: they were unroutable as well as unconsumed, and the routing table is now asserted rather than
assumed.

**Phase 11's "no delegation widget on the dashboard" — not this phase's, and it is Phase 13's.**
Its report says so; this report confirms it rather than silently leaving it. The same applies to
this phase's own unread count: the endpoint exists and the widget is the dashboard's.

**Phase 10's "no disposition-review reminder" — discharged**, and coalesced. §5 above.

**Phase 10's "`retention.due` is delivered nowhere" — discharged.** Its report predicted the shape
exactly: "the disposition queue is a screen somebody opens, not a notification — Phase 12 makes it
one."

**Phase 9's "the chain-broken alert is not delivered" — discharged, with a stated weakness.** §8
above records that its recipient is an operator and this product has no operator channel, so the
alert goes to `audit:view` holders inside the tenant.

**Phase 9's "`ACCESS_DENIED` from `AclGuard` is wired but unreached" — not discharged.** Its
unblocker is the phase that puts `@ScopedTo` on object routes, and this phase added none. The ACL
walk it performs is a *recipient* filter rather than a request refusal — nobody was denied access to
anything; somebody was simply not told about something they cannot see — and recording a denial for
it would put a row in the trail for every notification that reached fewer people than it might have.

**Phase 10's "no monthly partitions"** carries a two-part trigger — twenty million rows in one
tenant's trail, or the phase that gives audit its own disposition. This phase fires neither. It adds
one audit row per *suppression*, which is a handful a year, and gives audit no disposition. The
trigger stands as Phase 10 left it.

## 10. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks (three pre-existing `import()` warnings, unchanged) |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 441 API tests (up from 409), plus 126 domain, 26 contract, 21 web, 11 utils, 4 i18n and 2 worker |
| `pnpm test:integration` | 25 files / 431 tests against real PostgreSQL, two tenant databases (up from 422) |
| `pnpm build` | Clean, API and web — including the typed `/notifications` and `/admin/notification-templates` routes |
| `pnpm prisma:deploy` | Verified against two tenant databases, including the new migration and the post-migrate gate, which raises if a tenant-scoped table has no row-level security policy. All three new tables carry one |

`notification.integration.spec.ts` carries the phase's own assertions, and each asks something only
a database can answer at an instant:

- **An event consumed once produces one message per recipient and channel**, and the same event
  redelivered produces none — against the unique index that enforces it, not against a belief.
- **A recipient who may not see the document is not told about it.** Mallory holds the approval task
  and no role; the real `PrismaAclResolver` refuses her; the table has no row for her at all, while
  Bob gets both his channels.
- **A preference silences a type**, and **a mandatory type cannot be silenced** — the same empty
  channel list produces nothing for `document.published` and an email for `audit.chain-broken`.
- **Quiet hours hold a non-urgent message and release it afterwards.** The email is `HELD` with a
  `release_at` of 07:00 the following morning; the in-app row beside it is `DELIVERED` immediately;
  the urgent alert raised in the same window goes out; and the held one is sent once the window
  closes and not before.
- **A digest collects a window and releases it as one message.** Three held messages become one
  summary naming "3", and all three move to `DIGESTED` pointing at it — so none is still waiting to
  be sent individually.
- **A hard bounce suppresses the address**, writes `NOTIFICATION_SUPPRESSED` to the trail with the
  provider's reason in the attested `reason` column, alerts the administrator, and makes the **next**
  send `SUPPRESSED` rather than attempted — while everybody else's mail still goes out.
- **A bulk sweep produces one summary rather than five hundred rows.** Five hundred `retention.due`
  events produce no message at all and one window counting 500; the release produces two messages
  (one per channel) for the one controller, and a second release produces none.
- **A tenant template override replaces the shipped one and reverts when removed**, and a template
  naming a placeholder its type does not provide is refused at save time.

`outbox-routing.spec.ts` asserts the property §1 is about: every event type any module publishes
routes somewhere, or is named as deliberately unrouted with its reason.
