# Integration

**Answers:** How does this tenant connect to other systems?

**Owns:** `WebhookEndpoint`, `WebhookDelivery`, `AuditSink`
**Depends on:** Audit — for `AUDIT_STREAM_SOURCE`, which this module declares and Audit implements
**Binds:** nothing in `core/`. It *consumes* `OUTBOUND_HTTP_PORT`, which is the only way anything in
this product reaches an address a tenant chose.

## What it does not own, and why

**API clients and the identity provider are Identity's.** They look like integration and they are
*authentication* — "who is this, and what may they do anywhere", which is Identity's own question.
An API client resolves to a person and needs `CredentialRepository`; a federated sign-in mints a
session and needs `SessionRepository` and the token issuer. Putting them here would mean this
module reaching into Identity's tables — the sideways call `modules/README.md` exists to prevent —
or Identity exporting its credential repository to a module with no business holding it.

What is here is what a *system on the other end* needs: outbound events, and a stream of the trail.

The permission is nevertheless shared. `integration:manage` gates all four resources across the two
modules, because they are one administrative surface and 08 §2's test for a permission is whether it
is a decision somebody can be trusted with *separately*. It is not: whoever may mint a key may mint
one bound to an auditor, and whoever may point a webhook at a URL can exfiltrate the same events a
sink would carry.

## The one decision to read first

[ADR-0019](../../../../../docs/architecture/adr/0019-webhooks-are-not-notifications.md): **a webhook
is not a notification.** `NotificationChannel.WEBHOOK` has been in the schema since Phase 12 and
18 §3 named this phase for it, and the adapter was still not written — because Phase 12's central
safety property is that *no recipient list derived from a document reaches a renderer without every
name in it passing the ACL resolver*, and that is a statement about **people**. An endpoint is not a
user, holds no roles and appears in no ACL entry; there is no honest answer to "may
`https://hooks.acme.example/edms` see this document".

The consequence that reaches furthest is in the *payload*: the envelope carries identity, type and
time and **never document content**. The receiver calls back through the ordinary API with its own
key and gets exactly what that key's subject may see.

## The three properties the delivery path is built around

**Write first, attempt second.** `fanOut` writes every delivery row and commits before it sends
anything; a crash mid-attempt leaves a `PENDING` row the sweep picks up. Send-then-record — what
most implementations do — loses the event in the one case that matters, because a crash between the
`POST` and the write leaves nothing able to say whether it went. That is ADR-0011's argument for the
outbox itself, one layer out.

**The timestamp is inside the signed string.** `v1:{unix seconds}:{exact body}`, HMAC-SHA256. A
receiver that checks only a body signature accepts a captured request forever, because a signature
over an unchanged body never expires. The signed body is the **stored bytes**, so a receiver that
parses and re-encodes before verifying will compute a different digest — a documented property, and
why the header names live in `@edms/domain` where a client library can read them.

**A dead delivery keeps its payload.** 18 §8's "never silently dropped", applied to a system
recipient: the row is what makes a manual replay possible a week later, when the outbox row may be
long processed and the rendering may have changed.

## Why two lanes

`webhooks.deliver` is the first lane in the product whose work is an HTTP request to somebody
else's server, so its slots are spent *waiting* rather than computing — concurrency 12, a low
timeout setting, and a per-tenant cap of 4 so one tenant's eight endpoints cannot be the whole lane
during a bulk import.

`audit.stream` caps at **1 per tenant**, and that is correctness rather than fairness. A push is a
contiguous range of one tenant's hash chain; two at once would either send a range twice or advance
the cursor past events nobody sent, and the gap-free sequence that makes the stream worth trusting
would stop being a guarantee this end can make.

## Shape

```text
integration/
├── integration.module.ts
├── domain/
│   ├── audit-actions.ts        the two actions this module writes; the other four are Identity's
│   └── webhook-envelope.ts     what a receiver gets, and why it is identity rather than content
├── application/
│   ├── ports.ts                the repositories, and the ADR-0019 argument in full
│   ├── webhook-admin.service.ts
│   ├── webhook-delivery.service.ts
│   └── audit-sink.service.ts   13 §6, both shapes
├── infrastructure/
│   ├── prisma-webhook.repository.ts
│   ├── prisma-audit-sink.repository.ts
│   └── webhook-lane.consumer.ts
└── presentation/
    └── integration.controller.ts
```
