# Notification module

**Answers:** Who needs to be told?

| | |
| --- | --- |
| **Owns** | Template, NotificationMessage, delivery attempts, preferences, digests |
| **Depends on** | Identity |
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

## The framework

Phase 1 implements the machinery. There are no producers yet — the events that raise
notifications belong to the phases that raise them — so what exists is the pipeline and its
tests, as Phase 0.5 shipped ports before their consumers.

```text
notify(type, recipients, values)
  → recipients        USER_DIRECTORY (Identity's only public surface for this)
  → channels          type defaults ← user preference ← mandatory override
  → template          tenant override ?? the one the product ships
  → render            substitution only; values escaped for HTML
  → persist           one row per (recipient, channel), QUEUED
DeliveryService.deliverBatch(channel)
  → NOTIFICATION_PORT → SENT / FAILED / SUPPRESSED
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

### Preferences cannot silence a mandatory type

Resolution is tenant policy → user preference → type default. A security type resolves to its
defaults if a preference would leave it with no channel: a person must be told their account
changed, and an attacker who can suppress the warning has already won. They may still choose
*which* channel.

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

## Still to build

Digests and quiet hours (Phase 12), the remaining channels, bounce handling, and the worker
consumer that calls `deliverBatch` on a schedule — which needs the outbox dispatcher (R5).
Until then delivery is a method with tests and no caller.
