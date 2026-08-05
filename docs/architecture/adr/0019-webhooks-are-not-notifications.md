# ADR-0019 — A webhook is its own delivery path, not a notification channel

- **Status:** Accepted
- **Date:** 2026-08-06
- **Phase:** 17

## Context

`NotificationChannel.WEBHOOK` has been a value in the schema since Phase 12 with no adapter behind
it, and [18 §3](../18-notification-architecture.md)'s channel table says:

> | Webhook | Phase 17 | Per-tenant outbound webhooks for integration, signed, retried, and audited |

Read together, those two facts describe an obvious piece of work: write a `NotificationPort`
adapter for the `WEBHOOK` channel, bind it beside `ResendMailAdapter`, and the existing pipeline —
recipients, preferences, templates, the `notifications.deliver` lane, the retry policy, the
suppression table — carries outbound webhooks for free.

It is genuinely tempting, because that pipeline is good and most of it looks reusable. The reason
it is wrong is one sentence, and it is the sentence Phase 12 built its whole module around:

> **No recipient list derived from a document reaches a renderer without every name in it passing
> the ACL resolver** — 18 §8, implemented as `RecipientVisibilityService`.

## Decision

**Webhooks are their own delivery path**, in the Integration module, with their own tables
(`webhook_endpoint`, `webhook_delivery`), their own lane (`webhooks.deliver`), their own retry
schedule and their own dead-letter state. Nothing about them goes through
`NotificationChannel`, `NotificationPort`, `notification_message` or the preference model.

`NotificationChannel.WEBHOOK` remains in the enum as **a value nothing will ever use**, and 18 §3
now says so rather than leaving a reader to infer it.

## Why the notification path cannot carry it

**The safety property has no meaning for an endpoint.** A notification is addressed to a *person*,
and the question the ACL walk answers — may this human be told that this document exists — is a
permission question with a subject. `https://hooks.acme.example/edms` is not a user, holds no
roles, appears in no ACL entry, and has no reach to resolve. There are only two ways to make the
walk run for it, and both are bad:

- **Invent a subject for the endpoint** so the check has something to check. Whatever answer comes
  back is fiction, and it is *load-bearing* fiction: a real disclosure decision made against a
  fabricated principal.
- **Skip the walk for this one channel** — `if (channel !== WEBHOOK)` inside the one code path in
  this product whose entire value is that it has no exceptions. Phase 12 wrote that path precisely
  because "a notification that tells somebody a document exists is a disclosure even when the link
  then refuses them"; a channel exempted from it is the exemption somebody later copies.

**Every other part of the pipeline is also about people.** A notification has the recipient's
preferences, their quiet hours in their own timezone, a digest frequency, a locale, a rendered
template in EN or AR, and a suppression keyed to a mailbox. None of those is a fact about an
endpoint. A webhook has a signature, a replay window, a retry schedule an administrator can read, a
consecutive-failure count and a dead-letter state. None of those is a fact about a person.

Sharing the path would mean a `notification_message` row with a null recipient, a null locale, no
template, no preference resolution and five columns that never apply — and a `webhook_delivery`'s
five columns bolted onto a table eight other things read.

## What replaces the reuse

The parts genuinely worth reusing were reused, and they are not in the notification module:

- **The outbox** — ADR-0011 — is the source of every event, unchanged.
- **The lane and schedule machinery** is Phase 4's, and `webhooks.deliver` declares
  `perTenantConcurrency` exactly as `documents.bulk` does.
- **`AdministeredWriter` and the hash-chained trail** record every endpoint change.
- **The HMAC construction** is Phase 9's `signManifest` and Phase 16's signature witness, a third
  time.

## Consequences

**The payload is identity, not content**, and that follows directly. An outbound webhook has no
subject to resolve reach against, so anything it carried would leave the tenant on the strength of
a URL somebody typed. The envelope names *what happened to which object, when*; the receiver calls
back through the ordinary API with its own API key and gets exactly what that credential's subject
may see. That is 18 §8's "every link resolves through normal authorisation", and it is stronger
here, because the callback is a credential with a person behind it.

The suite asserts it: a `document.published` delivery does not contain the document's title.

**The outbox routing table's default changed**, and this is the consequence with the longest reach.
A webhook subscriber is the first consumer in this product that wants *every* event family, and
therefore the first for which the prefix table's failure mode is **total** rather than partial. When
`delegation.*` routed nowhere from Phase 11 to Phase 12, the search index missed re-projections and
somebody eventually noticed a document was not findable. An integration told "you will hear about
everything" that silently receives nothing from one family has no such signal: absence is
indistinguishable from quiet.

So `routesFor` returns the webhook lane unconditionally, and its default is that lane rather than
`[]`. A later phase adding an event family gets webhooks without touching the function, and the
narrowing happens per endpoint (`webhookSubscribes`) where an administrator can change it without
a release.

**`NotificationChannel.WEBHOOK` is dead and is not removed.** It sits in a PostgreSQL enum that
`notification_preference.channels` is an array of, and dropping a value from an enum a column
depends on is a migration with no benefit at the end of it. It is documented as unused in 18 §3,
which is a cheaper and more durable correction than a schema change.

**A tenant that wants a *person* told about a webhook failure is not served by this.** No
notification is produced when an endpoint is disabled after twenty consecutive failures — the
disablement is on the row, in the audit trail, and on the screen. That is a real gap and it is
recorded as a limit rather than closed by reaching back into the path this ADR just separated from.
