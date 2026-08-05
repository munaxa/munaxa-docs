# Phase 17 — API & Integration: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the API and Integration phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 18 and after, and whoever audits what Phase 17 claimed.

The brief lists eleven items. **They are not eleven capabilities, and sorting them was the first
real decision of the phase** — four of them are one thing, two of them belong to Phase 16, and two
more are the same item.

| Group | Items | What the work actually was |
| --- | --- | --- |
| **One capability, four names** | SSO, LDAP, Azure AD, Google Workspace | One OIDC adapter. Two of the four differ in a discovery URL and a claim name; one is a wire protocol that is not reachable; and "Microsoft 365" is not authentication at all |
| **Genuinely new** | REST API (machine-callable), Webhooks | The phase's centre of gravity: a caller that is not a person, and a delivery path addressed to a system |
| **Owed by three phases** | SIEM streaming | Phase 9's, Phase 11's and Phase 12's rows, all naming the same absent thing |
| **Mostly Phase 16's** | Migration APIs, Import APIs | `POST /documents/bulk/upload` already is most of it. What is genuinely left is named rather than rebuilt |
| **One item, not two** | SDK preparation, OpenAPI documentation | And most of it existed. The work was noticing that the *document* and the *explorer* are different things |

Almost nothing in this phase is machinery nobody had; almost all of it is a decision about what a
system on the other end of a connection is allowed to be.

---

## 1. The named risk: `userId` is the subject of every reach decision in this product

Phase 14 put the reach predicate in `PrismaDocumentRepository.whereFor`. Phase 15 built ten reports
on it. Phase 16 resolved it per object across five bulk operations. All three assume the same thing,
and one line decides what happens when it is not true:

```ts
private async visibilityCondition(): Promise<Prisma.DocumentWhereInput> {
  const context = requireContext();
  if (context.userId === null) {
    return {};                       // an empty predicate — every document in the tenant
  }
  …
```

That is correct for what it was written for — the outbox consumers and the schedules, where the
search projection must materialise an entry's answer *for everybody*. Phase 15 met it from the other
side and worked around it, and its report says so plainly: *"a consumer's context has no user in it
and `visibilityCondition` answers a subject-less caller with an empty predicate, which would have
made every export a copy of the whole tenant"*.

**A machine token is the first thing in this product that arrives at a route without being
anybody.** And the natural implementation — the key authenticates, `userId` stays null, because a
machine is not a person and putting a person's identifier there feels like a lie — turns **every
list route in the product into a full tenant dump for anyone holding any key**. Nothing logs an
error. Every `403` passes. The routes behave exactly as written.

[ADR-0018](../architecture/adr/0018-machine-identity-as-a-delegated-subject.md) argues three shapes
and takes the third:

1. **No subject.** The above. Refused *structurally* — `api_client.subject_user_id` is `NOT NULL`
   with no default, so the implementation fails to insert rather than failing at read time.
2. **A principal of its own** — the key gets ACL entries, appears on the permissions tab, is
   nameable on a folder. Defensible, and refused on cost and on precedent. The cost is that
   `AuthorizationSubject` gains a kind and so does everything consuming one: the resolver's four
   methods, the search index's `acl_subjects` materialisation, `AclEntry.subject_type`, every
   `@ScopedTo` chain walk, Phase 14's `visibilityFilter` regions, the permissions screen's
   decided-at display. The precedent is Phase 11's, and it is the closer argument: 08 §3 lost its
   "active delegations" clause rather than the resolver gaining a subject, *because a delegation
   nameable in an ACL entry would be the permission grant 07 §4 says it must never be*. A key
   nameable in an entry is the same object with a different label — a grant outside the role model
   and outside the entry model, held by whoever has the string.
3. **A delegated subject.** The key is bound to a person when it is minted and acts as them,
   narrowed by scopes. **Nothing in the authorisation model changed.** Not one caller of
   `ACL_RESOLVER` was touched.

The suite asserts it in the only way that distinguishes the implementations: two keys bound to two
people send the **same list request**.

```
Ada's key → 2 documents
Ben's key → 1 document    (denied on the closed folder, individually)
```

A subject-less implementation gives both of them everything — including the folder Ben is explicitly
denied. And neither total is the tenant's row count, which is the failure that would have shown as a
number matching an unfiltered count.

### A scope narrows and never widens

`effective = subjectPermissions ∩ ⋃(permissionsForScopes(scopes))`, and the direction is the
security property. A client scoped `documents:write` whose subject may only read writes nothing.

Both halves are read at **authentication time**, on every request, rather than copied onto the key
when it was minted — Phase 11's rule for delegation authority applied to a credential, and the
consequence is the point: removing a role removes it from every key bound to that person on the next
call, and disabling the account stops every key they back. That is what makes offboarding work, and
it is asserted rather than assumed.

Six coarse scopes rather than a mirror of the forty-odd permission keys, because a scope model that
is a second copy of the catalogue is a second copy that drifts. What that buys is a property no
configuration can undo: **a permission absent from every scope's list is unreachable by any key.**
`document:sign` is the one that matters — 21 CFR Part 11 §11.200 requires a signature to be executed
by the person with two components they alone control, and a key in a script is neither — so ADR-0017
stays true when a machine is calling. `user:manage`, `role:manage` and `settings:manage` are
excluded by the same mechanism rather than by anybody remembering to.

### What a key is, and what it is not

`mdk.<prefix>.<secret>`. The prefix is stored in clear and indexed, so the lookup is one read rather
than a scan verifying every row's digest; the secret is scrypt-hashed with the same parameters and
the same verifier a password uses, because a key stolen from a table is exactly as damaging as a
password stolen from one.

**It exchanges for no session and no token**, and it is resolved on *every* request. A JWT minted
for the key would make revocation take up to an access token's lifetime — the wrong direction
entirely for a credential somebody has just found on a laptop.

It arrives in the same `Authorization: Bearer` header a person's token uses, told apart by its own
prefix. A second header would mean every client library, proxy and CORS allow-list learns a second
name for "the credential", and a request carrying both would need a precedence rule nobody would
remember.

### The honest cost, stated rather than buried

**A key bound to a tenant administrator *is* that administrator**, without a second factor and
without a session anybody can end. The product cannot prevent that and should not pretend to — an
administrator who needs an integration with administrative reach has a real requirement. What it
owes instead is that the decision is visible: the subject is a column in the list, it is in the
`API_CLIENT_CREATED` payload, and `audit_event.api_client_id` names the credential on every row it
wrote.

---

## 2. `ActorChannel.API` had been in the enum since Phase 0.5 and nothing had ever written it

Four places constructed an audit actor with the literal `'WEB'`: `AdministeredWriter`,
`DefaultDocumentService.open`, `DocumentPreviewService`, `SearchService` and
`AccessDenialRecorder`. So a bulk import running on a lane and a scheduled retention purge both
recorded themselves as a browser. The channel was a **guess in four places rather than a fact in
one**.

It is now `RequestContext.channel`, optional so nothing constructing a context had to change to
keep behaving as it did — absent means `WEB`, which is what the literal said. What sets it
deliberately is the API-key authenticator (`API`), the lane consumers (`WORKER`) and provisioning
(`SYSTEM`). Three enum values that had never been written now are.

**`audit_event.api_client_id` is a column rather than a payload field**, and 13 §4's argument for
`reason` is why: the chain's digest covers columns, so a value in `jsonb` is attested only as part
of a blob the verifier cannot address. "Which credential took this action" is the first question an
incident asks, and an answer somebody with database write access could change without breaking a
hash is not an answer.

That means the digest had to widen, and it widened by **the mechanism Phase 9 built for exactly
this** — `CHAIN_HASH_V3`, stamped per row, appended rather than interleaved so v1 and v2 rows keep
verifying byte-for-byte. Rows already written cannot be rehashed, because the table refuses `UPDATE`
to every role including the owner, which is precisely the property that makes the trail worth
having. `attestedFields(3)` reports it, so an evidence bundle never claims to attest a column its
digest did not cover.

---

## 3. A webhook is not a notification, and the enum value proves it

[ADR-0019](../architecture/adr/0019-webhooks-are-not-notifications.md).
`NotificationChannel.WEBHOOK` has been in the schema since Phase 12 with no adapter, and 18 §3's
table names this phase for it. The obvious work is a `NotificationPort` adapter bound beside
`ResendMailAdapter`, inheriting recipients, preferences, templates, the lane, the retry policy and
the suppression table.

It is wrong for one sentence, and it is the sentence Phase 12 built its module around:

> **No recipient list derived from a document reaches a renderer without every name in it passing
> the ACL resolver.**

That property is about **people**. `https://hooks.acme.example/edms` is not a user, holds no roles,
appears in no ACL entry and has no reach to resolve. There are exactly two ways to make the walk run
for it and both are bad: *invent a subject* so the check has something to check — load-bearing
fiction inside a disclosure decision — or write `if (channel !== WEBHOOK)` inside the one code path
in this product whose entire value is that it has no exceptions.

Everything else confirms it. A notification has preferences, quiet hours in the recipient's own
timezone, a digest frequency, a locale and a rendered template; none means anything for an endpoint.
A webhook has a signature, a replay window, a visible retry schedule and a dead-letter state; none
means anything for a person.

**So `NotificationChannel.WEBHOOK` is a value nothing will ever use**, and 18 §3 now says so rather
than leaving a reader to infer it. It is not removed: it sits in a PostgreSQL enum that
`notification_preference.channels` is an array of, and dropping a value from an enum a column
depends on is a migration with no benefit at the end of it.

### The payload is identity, never content

This follows directly, and it is the decision most likely to disappoint an integrator. The envelope
carries the delivery id, the event id, the type, the instant, the tenant, the subject's type and id,
and the correlation id. It does **not** carry the document's title, its status, its author or its
confidentiality.

Three reasons that compound. It is a **disclosure with no permission behind it** — an outbound
webhook has no subject to resolve reach against, so anything it carried leaves the tenant on the
strength of a URL somebody typed. It **goes stale in the worst direction** — a delivery retried for
a day carries the state the document had a day ago, and a receiver acting on it acts on the past. And
it is **unbounded** — a payload sized by whatever the aggregate holds grows when a later phase adds
a column.

The receiver calls back through the ordinary API with its own key and gets exactly what that key's
subject may see. That is 18 §8's "every link resolves through normal authorisation", and it is
*stronger* here because the callback is a credential with a person behind it.

The outbox row's own payload is deliberately not forwarded either: its shape is each module's
internal business and has never been a contract, and forwarding it would freeze every module's event
payload into a public API by accident.

### Write first, attempt second — and why the attempt may be lost

`fanOut` writes every delivery row and **commits** before it sends anything. The attempt happens
outside that transaction; if the process dies mid-attempt the row is `PENDING` with a due
`nextAttemptAt` and the sweep picks it up a minute later.

The inverse — send, then record — is what most implementations do, and it loses the event in the one
case that matters: a crash between the `POST` and the write leaves no record that anything was sent,
so the event is either never delivered or delivered twice with nothing able to tell which. This is
ADR-0011's argument for the outbox itself, one layer out.

The attempt also happens **outside** the transaction for a second reason: a receiver taking ten
seconds must not hold a database connection, and therefore a slot in the pool, for the length of
somebody else's server's response time.

### The timestamp is inside the signed string

`v1:{unix seconds}:{exact body}`, HMAC-SHA256, presented as `X-Munaxa-Signature: v1=<hex>`.

A receiver that checks only a body signature **accepts a captured request forever**, because a
signature over an unchanged body never expires. With the timestamp covered by the digest, a receiver
enforces a window and a replay outside it fails to verify. The suite asserts all four cases — valid,
wrong key, tampered body, stale timestamp — using `verifyWebhookSignature`, which is written from
the documented scheme rather than by calling the sender's own `createHmac`. Asserting that a
function equals itself would prove nothing about whether a customer can verify what we send.

The signed body is the **stored bytes**, not a re-serialisation. A receiver that parses the JSON and
re-encodes before verifying computes a different digest — a documented property of every
implementation of this scheme, and why the header names live in `@edms/domain` where a client
library can read them.

### Retried, and dead-lettered with its payload intact

Retries are **not** BullMQ's. `webhooks.deliver` declares `attempts: 1`, and the delivery row
carries its own attempt count and `nextAttemptAt` — because a webhook's retry schedule is a tenant
setting, has to survive a worker restart, and has to be *visible to the administrator whose endpoint
is failing*. A lane-level retry would be a second, invisible schedule with different numbers.

The backoff is exponential with **full jitter**, which is the one place this differs from the
outbox's. A webhook's peer is somebody else's server: without jitter, an endpoint that goes down
while a hundred deliveries are in flight gets all hundred retries at the same instant, repeatedly —
a synchronised herd aimed at a system that is already unwell.

A spent delivery is `DEAD` with `nextAttemptAt` null so the sweep never sees it again, and **its
payload survives**. That is 18 §8's "never silently dropped" applied to a system recipient, and it
is what makes a manual replay possible a week later — when the outbox row may be long processed and
the rendering may have changed.

An endpoint disables itself after twenty consecutive failures, recorded with the reason and
reversible. Re-enabling clears the counter as well, because an endpoint whose receiver has been
fixed and which came back with nineteen failures still on it would disable itself again on the next
hiccup.

---

## 4. The outbox routing table's *default* changed, and that is the finding with the longest reach

The prefix table in `routesFor` has now silently dropped an event family **twice** — `delegation.*`
from Phase 11 until Phase 12 found it, and `library.*` until Phase 14. Phase 12 reconsidered the
registry alternative on that evidence and kept the table, and the mitigation it added was a test
asserting every event type routes *somewhere*.

A webhook subscriber is the first consumer for which that is not enough, because it is the first
whose failure mode is **total rather than partial**. When `delegation.*` routed nowhere, the search
index missed re-projections and the notification lane missed messages, and somebody eventually
noticed a document was not findable. An integration built on "tell me when anything happens" that
silently receives nothing from one family **has no such signal**: absence is indistinguishable from
quiet, and its author has no way to discover the gap at all.

So the webhook lane is not a line somebody has to remember to add. It is returned unconditionally,
and **the default changed from `[]` to that lane**. An event type matching no branch now reaches
webhooks instead of nowhere, so the next phase that adds an event family gets webhooks without
touching the function — which is the property the original comment claimed for the whole table and
which was false twice.

Phase 16 shipped its `bulk.` line in the same commit as the event and asserted the routing rather
than the comment. This phase does at least that, and one more thing: `outbox-routing.spec.ts` now
asserts that **every** event type any module publishes — including the twelve on the
`DELIBERATELY_UNROUTED` list, which are unrouted *for the index and the notification lane* — reaches
the webhook lane. The narrowing then happens per endpoint, in `webhookSubscribes`, where an
administrator can change it without a release.

The integration suite's outbox assertions were updated rather than left: one row now produces two
jobs, and the test that used to assert "an event nothing routes is enqueued nowhere" now asserts the
reverse, with the reason above written into it.

---

## 5. Federation: four brief items, one adapter, and two things that are not authentication

17 §2 already decided the shape — *"Per-tenant OIDC/SAML; the tenant's domain determines the
provider; JIT provisioning to pre-mapped roles"* — so the phase's job was to notice how many of the
brief's items that sentence already covers.

**SSO, Azure AD and Google Workspace are one adapter.** Entra ID and Google Workspace are OIDC
providers that differ in their **discovery URL** and in **which claim carries the groups**. Both are
columns on `identity_provider`. Building three adapters would be building one adapter three times,
and the third would be the one that drifts. Google Workspace's ID token has *no* groups claim at
all, which is why `ClaimMapping.groups` is nullable — a schema requiring one would have made the
second of the brief's two named providers unconfigurable.

**LDAP is genuinely different and is not built.** It is a wire protocol rather than an HTTP redirect
flow: BER-encoded ASN.1 over a socket, with its own bind, search and TLS negotiation. The choice was
between hand-writing an ASN.1 codec in a security product and naming the phase that closes it. The
report names the phase.

**"Microsoft 365" is a third thing again**, and conflating it with Entra ID because both say
"Microsoft" is the trap. It is not authentication at all — it is a *content* integration,
SharePoint and OneDrive as a document source or destination — and it belongs with the import mapping
in §7 below rather than here.

### The dependency question, answered with commands

```
$ node -e "require.resolve('jose')"              # from apps/api
Error: Cannot find module 'jose'
$ node -e "require.resolve('openid-client')"
Error: Cannot find module 'openid-client'
$ node -e "require.resolve('ldapjs')"
Error: Cannot find module 'ldapjs'
$ node -e "require.resolve('samlify')"
Error: Cannot find module 'samlify'
$ node -e "require.resolve('cbor')"
Error: Cannot find module 'cbor'
$ ls node_modules/.pnpm | grep -iE '^(jose|jsonwebtoken|openid|ldap|cbor|fido|@simplewebauthn|xml2js|fast-xml|samlify)'
                                                 # nothing: absent from the store entirely
```

Unlike Phase 16's `sharp`, these are not in the lockfile *at any level* — not unlinked, absent. So
"reach it by adding it to `apps/api/package.json`" is not even the unblocker; the lockfile would
have to gain a package, which CI's `--frozen-lockfile` refuses.

But that is only half the question, and the other half changes the answer:

```
$ node -e "const c=require('node:crypto');
           const {publicKey}=c.generateKeyPairSync('rsa',{modulusLength:2048});
           const jwk=publicKey.export({format:'jwk'});
           c.createPublicKey({key:jwk,format:'jwk'});"        # Node 22: works
$ node -e "console.log(typeof globalThis.fetch)"
function
```

Node imports a JWK directly and verifies RS256 and ES256 natively, and has a fetch. **OIDC is
reachable with zero dependencies.**

### Why hand-writing this is not the trade SAML and WebAuthn refuse

Phase 14 deferred WebAuthn because *"CBOR, COSE and attestation formats should not be hand-written
in a security product"*, and that is exactly right. It applies to SAML too — XML canonicalisation
and XML-DSig are the same shape of problem.

**There is no cryptography in `domain/oidc.ts`.** OpenSSL does the signature. What is written is the
*checks*, and every one is a string or a number comparison a reader can verify by eye:

1. **`alg` against an allow-list matched to the key's own type.** This closes the two oldest JWT
   vulnerabilities there are — `none`, which accepts an unsigned token, and the RS256→HS256
   confusion attack, where an attacker signs with the *public* key as an HMAC secret. Both fail
   because no symmetric algorithm is in the table at all, rather than because a check noticed.
2. **The issuer, compared exactly.** Without it, a token from *any* provider verifies and anybody
   can register an application and sign in as whoever they like.
3. **The audience, including `azp` when several are listed.** The check most hand-rolled
   implementations omit: the same provider issues tokens to many applications, and one of them may
   be the attacker's.
4. **The nonce, in constant time.** Without it, an ID token captured from any other flow with the
   same provider replays into ours.

The difference from CBOR and XML-DSig is that in those formats the **parsing is the hard part**, and
a subtly wrong implementation still accepts valid input and looks fine for years. Here the parsing
is a base64url split.

Fourteen tests against real generated RSA and EC keys assert each refusal by name, including the
`dsaEncoding: 'ieee-p1363'` detail without which every ES256 token fails to verify — which would
have looked like a provider problem rather than ours.

### The column whose absence was the phase's first finding

`user.password_hash` has been nullable since Phase 1, and **nothing anywhere recorded where an
identity came from**. A row with no password could equally be an invitation nobody has accepted or
somebody who signs in through Entra ID, and no query could tell them apart. `identity_source`,
`external_id`, `identity_provider_id` and `federated_at` close it.

### JIT provisioning grants exactly what the mapping says

`ProvisioningService` bootstraps a *tenant* and was the nearest existing seam. It is deliberately
not reused: what it does — create an organisation, seed eight roles, refuse to run twice — is a
different act from creating one person on their first sign-in, and generalising it would put the
tenant bootstrap one branch away from a path an unauthenticated caller reaches.

`rolesForClaims` is pure and runs **one way**: provider value → Munaxa role key. Nothing in a token
can name a role, which is what "pre-mapped" in 17 §2 means — a provider that could name a role would
be a provider that can grant itself `user:manage`. A mapped key that matches no role in the tenant
is **dropped rather than created**, asserted directly: provisioning with `['READER',
'A_ROLE_THAT_DOES_NOT_EXIST']` produces exactly `['READER']` and creates no role.

**A returning federated user's roles are not re-synchronised on each sign-in**, and that is the
decision to argue. Re-synchronising would make the provider the authority on Munaxa roles, so an
administrator's local grant of `document:approve` would silently vanish at the person's next
sign-in. The mapping decides what somebody *starts* with; what they end up with is the tenant's own
business.

A mapping onto `TENANT_ADMIN` is **accepted**, deliberately. Refusing it would be this product
deciding a customer's access model for them — "the Entra group `edms-admins` is our administrators"
is exactly what a large customer wants federation for. What the product owes instead is visibility:
the mapping is in the audit trail's `before` and `after`, so "who made `all-staff` map to
`TENANT_ADMIN`" is a question the trail answers.

### Two checks that are the difference between federation and an open door

**`state` is stored server-side and is single-use.** Without it this endpoint exchanges any code
anybody sends it, which is **login CSRF**: an attacker completes a flow against their own provider
account, hands the code to a victim's browser, and the victim ends up signed in as the attacker —
after which everything they do lands in the attacker's account. Stored server-side rather than in a
cookie because the callback may arrive on a different origin from the one that started.

**`redirect_uri` is configured, never taken from the request.** A `redirect_uri` read from a query
string is one an attacker sets to their own site, and the provider will happily deliver the
authorization code there. This is the open-redirect in every hand-rolled OIDC integration.

Both `state` and `nonce` are stored as **digests**, keyed by the state's digest, so a leaked cache
yields neither in a usable form.

---

## 6. 17 §6's SSRF row stopped being unfalsifiable

That section has had this row since Phase 0:

> **SSRF** — No user-supplied URL is fetched by the server; the OIDC discovery endpoint is the only
> outbound URL, from a configured allow-list.

Both halves were true the way an unfalsifiable statement is true. Nothing fetched a user-supplied
URL because nothing fetched anything except the mail provider's fixed endpoint, and the allow-list
did not exist because nothing needed one.

**Phase 17 is where the sentence starts describing a real risk.** A webhook endpoint is a URL a
tenant administrator types; an OIDC discovery document is a URL a tenant administrator types; a SIEM
collector is a URL a tenant administrator types. Three of the phase's four capabilities are,
structurally, "post this to wherever the customer says" — and tenant administrators are a role every
customer has several of.

The exploit needs no response body at all: a `POST` to an internal admin endpoint is an *action*,
and a signed webhook payload is attacker-chosen content delivered with the server's own network
position. On a cloud host the target list starts at `169.254.169.254`, whose metadata service
answers with credentials.

`OUTBOUND_HTTP_PORT` is the only path, and refuses in an order where each check closes a bypass for
the one before it:

1. **Scheme** — `https` only, plus an `http` escape hatch for a development collector that is
   refused outright in production. `file:`, `gopher:` and `redis:` are what turn a fetcher into a
   file reader and a protocol-smuggling gadget.
2. **Host, against the deployment's allow-list.** An **operator's** setting and the only
   configuration in the phase a tenant cannot edit — a boundary the people inside it can move is not
   a boundary. **Empty by default**, so webhooks, federation and audit push are all inert until an
   operator names a host. A leading dot covers subdomains; a bare entry covers only itself, so
   `hooks.example.com.evil.net` does not match, which a naive `endsWith` would let through.
3. **Every resolved address**, against the private, loopback, link-local, CGNAT and unique-local
   ranges — including IPv4-mapped IPv6, which is the same address wearing a different notation.
   *Every* answer rather than the first: a name resolving to one public and one private address is
   the rebinding attack pre-assembled, and picking whichever came back first is a coin toss.
4. **The connection goes to the address that was checked**, with the hostname restored in `Host` and
   SNI. `fetch` given a hostname resolves it *again* inside the stack, so resolve-validate-then-
   fetch-by-name is a control that does not control anything.
5. **No redirects, at all.** A permitted host answering `302 http://169.254.169.254/` would
   otherwise carry the request past every check above, and re-running the checks per hop is a
   control one forgotten branch from being absent.

A refusal names the rule and never the resolution, so it is not a DNS oracle for the network the
server sits in.

`permits()` answers the policy question without opening a socket, which is why an administrator
saving a webhook is told *at that moment* that the host is not permitted rather than discovering it
in a delivery log an hour later. `OutboundFailureKind` separates `REFUSED` — this deployment's
policy, no socket opened — from a timeout and a network error, because sending somebody to debug a
firewall that is working correctly is worse than telling them nothing.

The suite exercises the real adapter with a real allow-list and only the network stubbed; the
injected `fetch` **rejects**, so a check that failed to refuse would fail loudly rather than quietly
opening a socket. A fake with its own allow-list would have let the suite prove a refusal the real
class never made.

---

## 7. The decisions the specification left open

### What a SIEM sink actually is: both shapes, because they are not alternatives

13 §6 says *"Optional per-tenant streaming of security events to an external sink"* and leaves the
mechanism open. Phase 9's report, Phase 11's and Phase 12's all name it as owed.

**`PULL`** is a cursor the customer's collector polls with an ordinary API key. It makes no outbound
request at all — so it works for a collector inside the customer's own network, which is most of
them, and it cannot be the source of an SSRF because there is no URL. **`PUSH`** posts signed
batches to an HTTPS collector on the allow-list, and costs the whole of §6 above. That is why they
are configured separately rather than one being a mode of the other.

**The cursor is `audit_event.sequence`, and it is the reason this integration is worth having.**
13 §3 allocates it as `max + 1` under a per-tenant advisory lock rather than from a PostgreSQL
sequence, precisely so that a hole is visible — and that makes it a **completeness guarantee a
consumer can check**: a collector that has stored N and receives N+2 *knows* it missed one, rather
than hoping a timestamp window caught everything. Most SIEM integrations cannot offer that. Every
streamed row carries its `hash`, `previous_hash` and `chain_hash_version`, so a collector can verify
the chain it stored without asking again.

The cursor advances **only on a 2xx**, and the order is the whole of the reliability argument:
advancing first and posting second loses a range on any failure, with no way to discover which range
was lost because the cursor no longer points at it. A failure records the reason on the sink and
leaves the cursor where it was, so the next pass sends the same range — at-least-once, which is safe
because every event carries its sequence.

**A filtered sink is no longer gap-free, and the report says so rather than leaving it to be
discovered.** A tenant may name the actions it wants — how a volume-priced SIEM stays affordable —
and the cursor then advances past the whole slice rather than past the last carried event, so a
tenant streaming only `LOGIN_FAILED` whose next ten thousand rows are document views does not have a
cursor that never moves. The gaps are the rows the tenant asked not to receive. An **unfiltered**
sink, which is the default, keeps the guarantee in full.

`ip_address` and `user_agent` are absent from the stream, exactly as from the audit wire contract. A
continuous feed of every colleague's address into a third-party system is a disclosure nobody asked
for when they turned streaming on; an investigation uses the evidence bundle.

### Where does the machine caller's data live, given that it is authentication?

**API clients and the identity provider are Identity's; webhooks and the sink are Integration's.**
The first pair answers "who is this and what may they do anywhere" — Identity's own question — and
both need its credential and session repositories. Putting them in `integration/` would mean that
module reaching into Identity's tables, which is the sideways call `modules/README.md` exists to
prevent, or Identity exporting its credential repository to a module with no business holding it.

The permission is nevertheless shared. `integration:manage` gates all four across two modules,
because they are one administrative surface and 08 §2's test is whether a permission is a decision
somebody can be trusted with *separately*. It is not: whoever may mint a key may mint one bound to
an auditor, and whoever may point a webhook at a URL can exfiltrate the same events a sink carries.
Four permissions would suggest four boundaries that do not exist, and an administrator holding three
could obtain the fourth's effect through the ones they hold.

The audit actions split the other way, and had to: `IntegrationAudit` is two files because **each
module owns the actions it writes**, and the lint rule forbidding a cross-module reach into `domain/`
turned that from a convention into a constraint. One group in 13 §2's catalogue, two files in the
code — the same shape `SecurityAudit` and `IdentityAdminAudit` already have.

### Are "Migration APIs" and "Import APIs" new?

**Mostly not, and working out what is left was the point.** `POST /documents/bulk/upload` already
turns N uploaded files into N documents *under the caller's reach, resolved per object*, with a
`bulk_operation` record, a per-object outcome and a queue lane declaring a per-tenant concurrency
cap. Building a second bulk path would be building Phase 16 again with an import-shaped name — and
worse, the second one would be the one that forgets to resolve reach per object.

Two things are genuinely left, and neither is built:

- **A mapping from a foreign system's shape to this one.** A SharePoint library's columns are not
  this product's metadata fields, and the work is a per-source translation with a preview, a dry
  run and a per-row rejection report. That is a *content* integration, and it is where "Microsoft
  365" actually belongs.
- **A resumable long-running import.** Phase 16's report names the queued bulk consumer as
  *shipped-seam-not-consumer* — `bulk.synchronousLimit` and `documents.bulk` exist and every bulk
  operation currently runs in its request. An import larger than a request can hold is exactly the
  case that closes it, and **that is Phase 16's seam rather than this phase's**: the lane, the
  record and the per-tenant cap are all built, and what is missing is a consumer.

Both are named in §10 rather than half-built.

### Is "SDK preparation" separate from "OpenAPI documentation"?

**No — they are one item, and most of it existed.** `bootstrap.ts` has built a `DocumentBuilder`
document and served it at `/api/docs` since Phase 0.5.

What the phase found is that **the document and the explorer are different things and were one
flag**. 15 §6 has always said OpenAPI is *"served at `/api/docs` in non-production **and emitted as a
build artifact**"* — two deliverables, two audiences:

- The **explorer** is an interactive surface that enumerates every route and offers a "try it"
  button against the running deployment. Correctly refused in production, and configuration still
  refuses to boot with `OPENAPI_ENABLED` there.
- The **document** is a contract: what an SDK is generated from, what a customer's integration team
  reads, and what 15 §8's compatibility rule is diffed against between releases. Refusing to serve
  it in production meant the one deployment whose contract anybody cares about was the one that
  would not state it.

So `/api/openapi.json` is served everywhere `OPENAPI_DOCUMENT_ENABLED` permits, production included.
It renders no HTML, executes nothing, and describes routes every guard still refuses — enumerating
an API has never been a permission this product pretended to enforce, since `RoutePermissionRegistry`
publishes the whole route table at boot and 15 §8 requires deprecations to be *announced* in the
document.

**What it deliberately does not do is add a second definition of every shape.** The document is
built from what Nest already knows — routes, methods, parameters — and **not** from a
hand-maintained `@ApiProperty` decorator set on DTO classes. Every contract is already a zod schema
in `@edms/contracts`, and 15 §6 says those are the only definition of each shape; a decorator set
beside them would be a second one, diverging the first time somebody edited one and not the other.

The consequence is stated rather than hidden: **the document describes the route surface and not the
body shapes**, so it is not yet enough to generate a fully typed SDK from. Closing that is a
zod-to-JSON-Schema projection over the existing schemas — one derivation from the source of truth,
not a second source beside it. "Preparation" is not "built", and Phase 15's precedent is followed:
ship the seam and name the phase, rather than add a fifth declared-but-unbound contract.

---

## 8. What was found by building this phase

**The API key's separator was ambiguous against its own alphabet.** A key was written
`mdk_<prefix>_<secret>` with both segments `base64url`, whose alphabet is `A-Za-z0-9-_`. So a key
whose prefix or secret happened to contain an underscore — roughly one in three — split into more
than three parts and was refused as malformed by its own authenticator.

It is worth noting how it was caught. The unit tests passed: they were written by whoever chose the
format, with fixture values that contained no underscore. The **integration suite** caught it,
because it mints real keys from real `randomBytes` output, and it failed intermittently in exactly
the way a format defect does. The separator is now `.`, which is outside `base64url` entirely, so
the split is unambiguous by construction rather than by luck — and there is now a unit test with an
awkward key in it.

**`AuthModule.withVerifier` could not take the API-key authenticator as a second argument.** It was
written that way first, by symmetry with `TOKEN_VERIFIER`, and it does not work: a class registered
*inside* `AuthModule` resolves its dependencies from that module's scope, and the machine-credential
resolver needs Identity's credential repository and settings reader. `JwtTokenService` gets away
with it because it depends on configuration alone. Both the binding and `AuthenticationMiddleware`
are now provided by the composition root — the one place that may import both `core/` and a module,
which is what this needed and what `TOKEN_VERIFIER` has used since Phase 1.

**The audited read is `open`, not `get`.** A test asserting `ActorChannel.API` reached the trail
found nothing at first, because `DefaultDocumentService.get` writes no audit row — 13 §5 counts an
explicit *open* rather than every row a list drew, which the service's own comment says and which is
easy to miss when writing a test about something else.

---

## 9. What was built

| Area | Added |
| --- | --- |
| Domain | `integration.ts` — scopes and the intersection rule, the key format, the webhook signing string and subscription match, the jittered backoff, the claim and role mappings, the label-boundary domain match, the sink filter — all pure and all specified |
| Permissions | `integration:manage`, seeded to `TENANT_ADMIN` alone |
| Settings | Four feature flags (`apiClients`, `webhooks`, `federation`, `auditStreaming`), `webhook.maxAttempts`, `webhook.timeoutSeconds`, `audit.streamPageSize` |
| Queues | `webhooks.deliver` (the second lane to declare `perTenantConcurrency`) and `audit.stream` (the first to cap at 1, for correctness rather than fairness), plus two schedules |
| Schema | `api_client`, `webhook_endpoint`, `webhook_delivery`, `identity_provider`, `audit_sink`, four enums, `INTEGRATION` on `audit_subject_type`, `audit_event.api_client_id`, and four columns on `user` — all five tables carrying `tenant_id`, so the post-migration SQL discovers and forces RLS |
| Core | `OUTBOUND_HTTP_PORT` and its allow-listed adapter; `API_KEY_AUTHENTICATOR`; `RequestContext.channel` and `.apiClientId`; `CHAIN_HASH_V3`; `routesFor`'s new default |
| Identity | `api_client` with its authenticator; `domain/oidc.ts` and its fourteen tests; the OIDC discovery, the federation service and the provider administration; the federated user repository |
| Integration | A new module: webhook endpoints, deliveries, the signed delivery path, the audit sink and its two shapes, one lane consumer for two lanes |
| Audit | `AuditStreamSourceAdapter` implementing the port Integration declares; `api_client_id` threaded through the record, the writer, the buffer, the verifier and the wire |
| Web | `admin/api-clients` and `admin/webhooks`, with a shown-once credential dialogue |
| Contracts | `integration/integration.ts` |
| Docs | ADR-0018 and ADR-0019; 03 §3, 13 §2/§6, 15 §1/§5/§6, 16 §2, 17 §2/§6, 18 §3 and 19 §5 updated |

---

## 10. What it costs

| Cost | Figure | Why it is accepted |
| --- | --- | --- |
| A key bound to an administrator is that administrator | No second factor, no session to end | The requirement is real; what the product owes is visibility, and the subject is a column, a payload field and an attested audit column |
| A key is resolved on every request | One indexed read plus one scrypt verification per machine call | It is what makes revocation immediate; a JWT would make it take an access token's lifetime |
| `lastUsedAt` is coarse | At most one write per key per hour per process | A write per request would put an `UPDATE` in front of every read a machine performs |
| One webhook per event **per endpoint** | A tenant with eight endpoints subscribed to everything makes eight outbound requests per event | Bounded at 50 active endpoints, capped at 4 concurrent per tenant, and narrowed by subscription |
| Every event now routes to a lane | The outbox enqueues one more job per row, always | The alternative is the silent-drop defect this table has had twice, and the webhook consumer no-ops when the tenant has no endpoints |
| A webhook carries no content | A receiver must call back to learn anything | An outbound webhook has no subject to resolve reach against; a callback has one |
| Provider metadata is cached for an hour | An administrator repointing a discovery URL waits up to an hour | Two round trips per federated sign-in would make a provider's availability our own |
| The audit chain digest widened again | `CHAIN_HASH_V3`; rows keep three field sets | Rows already written cannot be rehashed, so versioning is the only honest way to widen |
| The outbound allow-list is empty by default | Three capabilities are inert until an operator names a host | The failure mode of the alternative is the server attacking its own network |

---

## 11. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| **LDAP is not built** | A wire protocol, not an HTTP redirect flow: BER-encoded ASN.1 over a socket with its own bind and TLS negotiation. `ldapjs` is absent from the store entirely | A lockfile that can gain a dependency — the same deployment-packaging decision Phase 16 named for `sharp`, which is Phase 18's |
| **SAML is not built**, so 17 §2's "OIDC/SAML" is honestly half | Verifying an assertion needs XML canonicalisation and XML-DSig; there is no XML parser here at any level, and hand-writing C14N is the trade Phase 14 refused for CBOR | The same lockfile change. `identity_provider_kind` has one value so adding `SAML` is a migration rather than a redesign |
| **Microsoft 365 content integration is not built** | It is not authentication, and it is not a bulk path either: it is a *mapping* from SharePoint's shape to this one | The phase that builds the import mapping below |
| **WebAuthn is still not built** — Phase 14's row | `cbor`, `fido2-lib` and `@simplewebauthn/server` are absent from the store entirely; attestation formats are the hand-written-parser trade | The same lockfile change |
| **The MFA role policy is still unenforced** — Phase 14's other row | Switching it on locks out exactly the accounts that administer a tenant, and the only way back in is ADR-0013's operator console, which no phase has built. Phase 12's chain-broken alert is a stand-in for an operator *channel*, not a recovery path for people who cannot sign in | ADR-0013's console. It is **not scheduled to any phase**, and what it would take is named in §12 |
| **The import mapping and the resumable import are not built** | Bulk upload already does N files → N documents under per-object reach. What is left is a foreign-shape translation and a consumer for the queued bulk path | Phase 16's own seam for the second; a per-source mapping design for the first |
| **The OpenAPI document describes routes, not body shapes** | A decorator set beside the zod schemas would be a second definition of each shape, and 15 §6 says the schemas are the only one | A zod-to-JSON-Schema projection over `@edms/contracts` — one derivation, not a second source |
| **Nobody is notified when a webhook endpoint disables itself** | It is on the row, in the trail and on the screen. Telling a person means reaching back into the notification path ADR-0019 just separated from | A `security.*` notification type whose recipient is resolved from a permission rather than from a document — which is a shape Phase 12 has (`retention.review-due`) and which this phase did not need |
| **A dead delivery cannot be replayed from the screen** | The row and its payload survive, which is what makes a replay *possible*; there is no button | A route that re-queues a `DEAD` delivery, which is small and was not needed to make the guarantee true |
| **An API client cannot be scoped to a folder** | Scopes are coarse by design, and a key nameable in an ACL entry is ADR-0018's refused alternative | A new ADR superseding 0018, paying the cost it names deliberately |
| **Quota accounting still does not exist** | ADR-0012's and Phase 21's, as Phases 10, 13, 15 and 16 each recorded | Phase 21 |
| **`ARCHIVED`, `REINSTATED`, `LINKED` still have no writer** | This phase built none of those capabilities either; an integration platform archives nothing | The phase that builds each |
| **Production readiness and the integrity sweep** | Out of scope, named by the brief | Phase 18 |

---

## 12. The operator console, named rather than half-built

ADR-0013 describes it and **no phase is scheduled to build it**. Phase 17 needed it for one thing —
enforcing 17 §2's MFA role policy — and declined rather than building half of one, so it is worth
saying what "half of one" would have been and what the real thing takes.

The tempting half is a break-glass route: a bearer token from an environment variable that bypasses
the MFA check for one sign-in. That is a **second authentication path with no ACL, no audit actor
and no expiry**, guarded by a secret in a deployment's configuration — a strictly worse security
posture than the lock-out it exists to escape.

What ADR-0013 actually requires is a separate surface with: its own authentication, independent of
any tenant's directory; cross-tenant reads under a role that is *not* `edms_app` and whose grants
are visible in the database; every action written to the affected tenant's own trail with an actor
that is honestly external; and a deployment story that keeps it off the customer-facing host. That
is a phase, not a route.

Until it exists, the MFA policy stays a constant nothing reads — which is the honest state, and is
what `MFA_REQUIRED_ROLES` has been since Phase 14.

---

## 13. Limit rows discharged from earlier reports

Earlier reports are historical and stand unedited; these lines are their discharge.

| Row | Phase | Status |
| --- | --- | --- |
| The optional per-tenant SIEM sink (13 §6) | 9 | **Discharged.** Both shapes built — a pull cursor and an optional push — over the gap-free sequence |
| `DELEGATION_*` reaching a SIEM | 11 | **Discharged**, by the same stream. All four delegation actions are in it, unfiltered by default |
| `NOTIFICATION_SUPPRESSED` reaching a SIEM | 12 | **Discharged**, likewise |
| Inbound provider webhooks for delivery receipts (`providerMessageId` recorded, nothing consuming one) | 12 | **Open, and narrowed.** The outbound half is built; an inbound receipt needs a *public* route that verifies a provider's own signature scheme — a different construction from this phase's, and one per provider. The delivery mechanism this phase built does not close it |
| WebAuthn | 14 | **Open.** `cbor`, `fido2-lib` and `@simplewebauthn/server` are absent from the store entirely, answered with commands in §5 |
| The MFA role policy | 14 | **Open, and now declined rather than deferred.** §12 says what the blocker is and what closing it takes |
| Report delivery — a finished export as a notification with an attachment, plus `report_schedule` | 15 | **Open.** This phase built a delivery path addressed to *systems*, and ADR-0019 is the argument that it is not the notification path — so it does not close a row about telling a *person* their export is ready. That row needs a `reporting.export-ready` notification type with a signed link, which is Phase 12's machinery and nobody's phase yet |
| The evidence-CSV formula finding | 15 | **Open**, and Phase 18's, as Phase 16 recorded |
| The queued bulk consumer (shipped seam, no consumer) | 16 | **Open**, and this phase confirms Phase 16's own framing: an import larger than a request can hold is the case that closes it, and the lane, the record and the cap are all already built |
| The rasteriser, the Arabic watermark font, non-PNG thumbnails | 7, 16 | **Untouched**, as the brief instructs. All three wait on Phase 18's deployment-packaging decision |

**Phase 12's report stated that `retention.due` and `bulk.operation-completed` were the only
coalesced families.** That is still true: this phase adds no notification type and no coalesced
family, because everything it delivers is addressed to a system.

---

## 14. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean |
| `pnpm typecheck` | Clean |
| `pnpm test` | Clean — 550 API, 164 domain, 26 contracts, 21 web, 11 utils, 4 i18n, 2 worker |
| `pnpm test:integration` | **530 tests across 31 files**, against two real tenant databases |
| `pnpm build` | Clean |

The phase's own assertions, all against a real PostgreSQL:

- **Two keys bound to two people, one list request, different rows *and different totals*** — the
  assertion that distinguishes a delegated subject from a subject-less one, and would have shown an
  empty predicate as a total matching an unfiltered count.
- A key resolves to its subject with the **scope-narrowed** permission set: `document:view` present,
  `document:create` absent, though the subject holds both.
- `ActorChannel.API` reaches the trail with the client's identifier beside it, on a row stamped
  `chain_hash_version` 3.
- A revoked key, a wrong secret and rubbish are refused **identically**.
- A key **stops working the instant its subject is disabled** — the assertion that makes offboarding
  more than an intention.
- A webhook delivery verifies under a receiver's own implementation of the documented scheme, and
  fails under a wrong key, a tampered body and a stale timestamp.
- A `document.published` delivery **does not contain the document's title**.
- An event redelivered by the outbox produces **one** `POST`, not two.
- A failing delivery retries with its payload intact, dead-letters at the configured attempt, and is
  never re-attempted afterwards; the endpoint disables itself at the threshold and re-enabling
  clears the count.
- The **real** outbound adapter refuses a host off the allow-list, a lookalike a suffix match would
  admit, a permitted host resolving to `127.0.0.1`, a host resolving to one public and one private
  address, plaintext, credentials in the URL and `file:` — **opening no socket**, asserted by an
  injected `fetch` that rejects.
- A federated sign-in provisions with **exactly** the mapped roles, creates no role for an unmapped
  key, writes no password hash, and records `identity_source = FEDERATED`.
- A returning signer matches by **subject first**, an existing local account binds by address once,
  and an account already bound to another provider subject is not claimable.
- The audit stream pages contiguously by sequence, resumes exactly where it left off, refuses when
  the tenant has not enabled streaming, and **advances its cursor only on a 2xx**.
