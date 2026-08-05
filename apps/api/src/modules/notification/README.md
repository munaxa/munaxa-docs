# Notification module

**Answers:** Who needs to be told?

| | |
| --- | --- |
| **Owns** | Template, NotificationMessage, delivery attempts, preferences, quiet hours, digests, suppressions, coalescing windows |
| **Depends on** | Identity, Document, Library |
| **Binds in core** | Nothing in core. It is the only module that calls `NOTIFICATION_PORT`. |

## Layers

```text
notification/
├── notification.module.ts   composition for this module
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
| `notification.queued` | A message exists for a recipient and channel. |
| `notification.sent` | The provider accepted it. |
| `notification.failed` | Delivery failed; carries whether a retry is worthwhile. |

## The pipeline, and what now drives it

Phase 1 implemented the machinery and gave it no producers, and this file said so. **Phase 12 is
the phase that calls it.** The `notifications.deliver` lane — the last declared lane in the product
without a subscriber — has one, and the four phases that deferred delivery here in the same words
("the outbox row is the record until a consumer exists": Phase 4 for `workflow.*`, Phase 9 for
`audit.chain-broken`, Phase 10 for `retention.due`, Phase 11 for the four `delegation.*`) are
discharged.

```text
outbox event → NotificationLaneConsumer → NotificationEventService
  → recipients        computed per event type, then ACL-filtered where a document is involved
  → notify(type, recipients, values)
       → contacts     USER_DIRECTORY (Identity's only public surface for this)
       → channels     type defaults ← user preference ← mandatory override
       → suppression  a dead address produces a SUPPRESSED row, never no row
       → hold         quiet hours and the digest window, whichever is later
       → template     tenant override ?? the one the product ships
       → render       substitution only; values escaped for HTML; email wrapped in the layout
       → persist      one row per (recipient, channel)
DeliveryService.deliverBatch('EMAIL')   → NOTIFICATION_PORT → SENT / FAILED / SUPPRESSED
DeliveryService.releaseHeld()           → quiet hours that closed → QUEUED
DigestService.collect(frequency)        → one summary per recipient; members → DIGESTED
NotificationEventService.releaseBatches → one summary per closed coalescing window
```

**Email is not a separate framework.** It is the `EMAIL` channel of this one — same catalogue,
same templates, same preferences, same delivery record. A parallel mail subsystem would need
its own copy of all four and would drift from them.

**In-app is delivered by being written.** There is no adapter and nothing to send, which is
exactly why a mail provider outage cannot affect it. `deliverBatch('IN_APP')` throws rather
than reporting success for doing nothing.

### The template language is not an engine

`{{ name }}` substitution, and that is the entire grammar. No conditionals, no loops, no
property access, no expressions.

Templates are tenant-editable data. An engine that evaluates expressions turns "an
administrator edited the approval email" into server-side code execution, and every
general-purpose engine has had that CVE. A substituting renderer cannot: the worst a malicious
template can do is say something untrue, which is what review is for.

Values are escaped for HTML bodies and not for subjects or plain text — escaping those would
show a person `&amp;`. A missing value is **reported, not rendered blank**: "Document  was
approved by " reaches somebody looking like a defect, and nobody can tell which value was lost.

### Recipients are ACL-filtered, and that is the module's central safety property

A recipient list is computed from an event — an approval task's assignee, a document's owner — and
every one of those is a claim about who may *see* the document. `RecipientVisibilityService` puts
each name through `ACL_RESOLVER` before anything is rendered.

The failure it prevents is total and quiet: somebody is removed from a folder, keeps an approval
task assigned before the change, and is emailed the document's number, title and rejection reason.
They click the link and are correctly refused — having already learned everything the notification
said. **A notification that tells somebody a document exists is a disclosure even when the link
then refuses them** (18 §8).

Recipient lists with no document behind them — the two parties to a delegation, an administrator
told an address was suppressed — are not filtered, because there is no object to resolve.

### Preferences cannot silence a mandatory type

Resolution is tenant policy → user preference → type default. A security type resolves to its
defaults if a preference would leave it with no channel: a person must be told their account
changed, and an attacker who can suppress the warning has already won. They may still choose
*which* channel.

A stored preference with **no** channels means "off" and is honoured for everything else. Phase 1
read an empty list as "no opinion", which was indistinguishable from having no row — and left "off"
inexpressible, which is what §5 offers. The absence of a row is what means no opinion.

Channels the deployment cannot deliver on are dropped at resolution rather than queued — a
message waiting for an adapter that does not exist is an outage nobody sees.

### Idempotency

The key is `(eventId, recipientId, channel)`, unique per tenant. Re-running whatever produced
an event cannot put the same notification in somebody's inbox twice. Callers with no natural
event id should mint one and keep it, not generate a fresh one per attempt.

### Templates ship with the product

`domain/default-templates.ts` holds EN and AR for every type. The `notification_template` table
is for tenant *overrides*, so an empty table is a fully working tenant and a row exists only
where somebody deliberately changed something — the same argument as settings.

### Holding a message back is a state

`HELD` and `DIGESTED` were added to `DeliveryState` in Phase 12, beside a `release_at` that gates
the delivery claim. `release_at` alone would have worked and was rejected: an operator asking "what
is waiting to go out" would then get one number covering both a mail outage and a quiet-hours hold,
which are the two conditions that most need telling apart.

A digested message is deliberately **not** `SUPPRESSED`. Suppression means an address that must not
be written to, and overloading it would make "how many addresses are we refusing" a question the
table answers wrongly.

### A digest is a list, and the renderer still does not do lists

The list of collected subjects is composed by `composeDigestItems` and handed to the renderer as a
single `items` *value*, escaped for the HTML body exactly as a document title is. The template
language gained no loop, no conditional and no property access; the digest gained a list. That
separation is the whole reason composition and substitution are kept apart.

### Suppression is about a mailbox, not a person

`notification_suppression` is keyed by the address. Identity owns users and nobody reads its
tables — but the stronger reason is that somebody who corrects their address is reachable again at
once, and somebody who inherits a colleague's old address does not inherit their bounces. The
crossing of the tenant's threshold writes `NOTIFICATION_SUPPRESSED` to the trail and alerts the
administrators **once**; every subsequent bounce is counted and says nothing.

### One consumer, five schedules, one lane

`BullMqAdapter.subscribe` constructs one `Worker` per call, so two subscribers on one lane race
each other for its jobs — the constraint Phase 11 hit and recorded. `NotificationLaneConsumer` is
therefore the single subscriber on `notifications.deliver` and answers for all five of its
schedules: the delivery pass, the three digest collections, and the coalescing-window release.

## Still to build

Push (18 §3 marks it "Future — no code is written in anticipation") and SMS, both of which the port,
the preference model and the message table already accommodate. **SMTP**: `MAIL_DRIVER` names it and
no adapter exists, so the value is refused at boot rather than failing at the first send — the
on-premise deployments 18 §3 wants it for are Phase 18's. Watchers and subscriptions, which 18 §4's
`DocumentPublished` row needs and no phase has built. Delivery receipts beyond acceptance: the port
carries `providerMessageId` and nothing consumes a webhook that would report what became of it.
