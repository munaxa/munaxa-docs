# Phase 18 — Production Readiness: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Production Readiness phase. Historical — superseded, never revised.
**Audience:** whoever operates this product, whoever audits what Phase 18 claimed, and whoever builds Phase 19 and after.

The brief lists sixteen items. **Most of them already existed as seams, and finding out which was
the first work of the phase** — because a phase that reads "Performance, Caching, Queues,
Monitoring, Health Checks, Logging, Disaster Recovery, Backup, Restore, Scalability, Security
Testing, Penetration Testing Preparation, Load Testing, Production Documentation, Deployment
Documentation, CI/CD validation" and starts building will build a second caching layer beside the
one Phase 14 already invalidates correctly.

| Group | Items | What the work actually was |
| --- | --- | --- |
| **Ports declared in Phase 0.5 and bound to nothing** | Monitoring, Logging | `METRICS` and its label rule have existed since Phase 0.5 with `grep -rn "provide: METRICS"` finding *nothing*. Binding it without choosing a customer's backend, and deciding which of the ten names actually get emitted and from where |
| **Already built; the work was verification** | Performance, Caching, Queues, Scalability, Health Checks | Phase 14's decision cache, Phase 16's per-tenant caps, Phase 8's keyset pagination, the three probes. What was owed was *tests* and honesty about which claims are measured |
| **A decision, not a task** | Deployment documentation, CI/CD validation | What a production image contains, which native bindings are pinned, and whether the sandbox constraint that shaped six phases binds a *release*. Answered with a command |
| **Named-owner rows** | (not in the brief) | Phase 0.5's metrics row, Phase 12's SMTP adapter, Phase 14's TOTP key, Phase 15's evidence-CSV finding, and the integrity sweep three reports call Phase 18's |
| **Two things wearing one name** | Security Testing, Penetration Testing Preparation | A suite and a document. Neither is "run a scanner" |
| **A claim, or a measurement** | Load Testing | 19 §8 has named a harness since Phase 0 and no phase has ever recorded a number. The harness exists; the numbers still do not, and §7 says why |
| **Procedures pointed at and never written** | Disaster Recovery, Backup, Restore, Production documentation | 20 §§6 and 7 are tables. `docs/operations/` is four runbooks |

---

## 1. The metrics port, and the question binding it actually asks

Phase 0.5 declared `METRICS`, a label rule, and a catalogue of ten names. Seventeen phases later
nothing had been bound to it, and the debt report's row 9 is not an apology — it is the argument:

> Which backend a deployment scrapes is an operational decision, and binding one now would make it
> an architectural one.

That is right, and it means the question is not *whether* to bind but **what shape a binding takes
that does not choose for a customer**. The answer was already in the codebase twice:
`STORAGE_DRIVER` and `MAIL_DRIVER` are both "name your provider, and `NONE` is a real value". So
`METRICS_DRIVER=NONE|PROMETHEUS`, and the shape is the same.

**`NONE` is a no-op rather than a refusal, and it is the only driver in `configuration.ts` that
is.** Every other unbound port in this product is bound to an adapter that *fails* naming the
variable that would configure it — storage, OCR, antivirus, mail — and that posture is right for
all four and wrong for this one. A deployment with no storage driver cannot store a document, so
failing at the first upload is honest. A deployment with no metrics driver **works**; it is simply
unobserved. Turning that into an exception would mean every call site needs a `try`, or
`LoggingBehavior` takes down the request it was measuring — telemetry failing the work it watches is
the classic way an observability layer becomes the outage.

### Why pull, and why that is the whole of the SSRF argument

`PROMETHEUS` exposes an in-process registry in the text exposition format at `GET /api/metrics`, for
a scraper to **pull**. It makes no outbound request at all.

That was not a preference. Phase 17 made `OUTBOUND_HTTP_PORT` the only outbound path in the product,
with an allow-list that is empty by default, and 17 §6 says nothing may add a second. A push
exporter would have to either go through that boundary — making a deployment's telemetry depend on
an operator remembering to allow-list their own collector — or become the second path. **It is the
same argument Phase 17 made for the SIEM `PULL` sink**, reached independently from the other
direction, and the coincidence is worth noting: a product with one carefully guarded egress point
keeps arriving at pull-based integrations.

It is also the shape that declines to choose a backend. The text format is read directly by
Prometheus, VictoriaMetrics, Grafana Agent, the OpenTelemetry Collector's `prometheus` receiver,
Datadog's OpenMetrics check and every hosted agent worth naming. OTLP would have chosen one.

### The label rule stopped being a comment

`metrics.ts` has carried this since Phase 0.5:

> The label rule matters more than the interface: labels are bounded sets — queue name, status,
> driver. A tenant id or a document id as a label is an unbounded cardinality explosion that will
> take the metrics backend down.

A rule in a comment is a convention, and a convention about cardinality is one somebody breaks
during an incident by adding the tenant id that would have told them which customer it was. So
`METRIC_CATALOGUE` now declares, per name, its kind and **the exact label names it accepts**, and
the exporter drops anything else with one warning per offending key.

The failure mode of the alternative is what makes this worth the code: a metrics backend that falls
over some days later, with nothing pointing at the commit that did it. `METRICS_MAX_SERIES` is the
backstop for the case a declaration cannot see, and `edms_metrics_series_dropped_total` says when it
bit — because a silently capped registry reads as "there is no traffic on that route".

### Which of the ten names are emitted, and from where

**All of them.** A bound exporter with no call sites would be a second unbound port wearing a
binding.

| Name | Emitted from | Labels, and the one that is deliberately absent |
| --- | --- | --- |
| `http.request.duration` | `RequestObservabilityInterceptor`, first in the interceptor chain so it covers what the others do | Route **template**, never the path — a path label is the document id wearing another name |
| `message.duration` | `LoggingBehavior`, beside the line it already logs | Message name, from the handler catalogue; not the tenant or the user on the same log line |
| `outbox.pending` | `MetricsSampler` | None. A level, not an event |
| `outbox.dispatch.failures` | `OutboxDispatchScheduler`, which is the layer that knows a pass *finished* | A coarse reason; the specific error is on the row's `last_error` |
| `queue.depth` | `MetricsSampler` | Lane and state |
| `job.duration` | `BullMqQueueAdapter`'s worker wrapper | Lane, never the tenant — one series per lane per customer is the explosion |
| `job.failures` | The same worker's `failed` handler | `exhausted`, because a lane that retries successfully is healthy and one dead-lettering is not |
| `audit.chain.verified` | `AuditVerificationService`, on **both** paths | `intact` |
| `authorization.denied` | `AccessDenialRecorder`, before the trail is touched | Permission and reason, **never the actor** |
| `storage.presign` | `TenantScopedStorage` — the one wrapper every signed URL passes through | Operation and driver |

Two of those needed a sampler rather than a call site, and the distinction is the interesting part:
eight are *events* and two are *levels*. Nothing in the product passes a point where lane depth is
known, and a gauge derived from dispatcher passes reads **zero exactly when the backlog is
unbounded**, because a stalled dispatcher claims nothing. So `MetricsSampler` runs on its own
interval — and **only when an exporter is configured**, which is what lets the interval be short
enough to be useful without imposing a Redis round trip per lane on a deployment that scrapes
nothing.

`authorization.denied` deserves its own sentence. 17 §9's first alert is "repeated `ACCESS_DENIED`
by one actor", and the obvious label is the actor. It is refused: a series per user is precisely the
unbounded cardinality the rule forbids, and *which* actor is a question the audit trail answers with
a row. The alert fires on the rate; the investigation reads the trail.

### The scrape endpoint is not public, and that is a decision

Health is public because an orchestrator holds no credentials and the body is dependency names. **A
metrics body is different in kind**: queue depths, error rates, authorisation-refusal counts by
permission, and the route table with volumes. None of it is one tenant's data and all of it is
reconnaissance — "which permissions are refused, on which routes, how often" is the opening move of
exactly the enumeration 17 §9 alerts on.

So it carries `METRICS_SCRAPE_TOKEN`, required by boot validation in **every** environment whenever
the driver is real. A separate credential rather than a permission on a role, because the scraper is
the operator's infrastructure and not a person in any tenant's directory — ADR-0013's argument for
the operator console, applied to one route. It is version-neutral, because a Prometheus job
configuration that had to be edited at a major version is an alerting gap on release day.

---

## 2. Tracing: the same question, a different answer

20 §5's Traces row has said this since Phase 0:

> Request → use case → repository → adapter, and the outbox hop into workers.

**That is a span per repository call, which is a span for every row a list draws**, on the
most-loaded route in the product, forwarded to a collector that charges per span. The brief's own
framing is the answer — *a span per request is cheap and a span per repository call is not* — and
this phase takes it and makes 20 §5 say so rather than leaving a promise nobody could afford to
keep.

What is emitted is **one span per request**. W3C `traceparent` is parsed (strictly: a malformed or
all-zero value starts a new trace rather than propagating, because the header is attacker-controlled
on any public route and would otherwise reach a third party's collector), carried on
`RequestContext`, put on every log line, echoed in the response, and forwarded outbound. What that
buys is the thing a customer's tracing actually needs: **their** trace id joining their gateway,
this deployment and their webhook receiver into one trace rather than three unrelated ones.

The use-case layer is carried as `message.duration` — a histogram — which answers "is this handler
slow" without emitting a tree.

The span is a structured log record rather than an OTLP export, because this build contains no OTLP
encoder. Which brings us to the two variables that described exporters no build of this product has
ever had.

**`SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT` are now refused at boot.** They have been in
`configuration.ts` since Phase 0.5 and in 20 §3's key-variable list since Phase 0, read by nothing.
A variable that is accepted and ignored is worse than one that is refused: an operator who sets it
believes errors are reaching Sentry, and discovers otherwise during the incident it was set for.
This is the `OCR_DRIVER=HOSTED` precedent applied to configuration rather than to a driver.

---

## 3. The packaging decision, answered with a command

Three phases were waiting on this. Phase 16: `sharp` is in the store, linked into no workspace
package, and reaching it is a lockfile change `--frozen-lockfile` refuses; `@pdf-lib/fontkit` is
absent entirely. Phase 17: `jose`, `ldapjs`, `samlify` and `cbor` are absent, so the unblocker is
not "link it" but "the lockfile gains a package". Both reports named the deployment-packaging
decision as Phase 18's.

**The first finding refines what every previous phase concluded, and it is worth stating precisely.
The public npm registry is reachable from this environment:**

```
$ npm pack nodemailer@7.0.3 --registry=https://registry.npmjs.org
$ ls
nodemailer-7.0.3.tgz
```

So the constraint has never been the network. It is a **credential**, and it binds through pnpm's
resolution rather than through the package being fetched:

```
$ pnpm install --lockfile-only          # after adding one dependency to apps/api
 ERR_PNPM_FETCH_401  GET https://npm.pkg.github.com/@munaxa%2Fconfig-eslint: Unauthorized

$ pnpm install --lockfile-only --offline
 ERR_PNPM_NO_OFFLINE_META  Failed to resolve @munaxa/config-typescript@>=1.0.0 <2.0.0-0
   in package mirror /root/.cache/pnpm/metadata-v1.3/npm.pkg.github.com/@munaxa/config-typescript.json
```

**Any write to the lockfile re-resolves every direct dependency**, including the `@munaxa/*` scope
on GitHub Packages, which needs a `read:packages` token this environment does not have. There is no
`--offline` path, because the metadata was never cached. So the answer is the one Phase 16 and Phase
17 reached, with the reason corrected: **the lockfile still cannot change here**, and it is one
token away from changing anywhere else.

That is not a wall, and the report should not describe it as one. A release engineer with a
`read:packages` token runs `pnpm add sharp` and it works. What this environment cannot do is
*produce* that commit.

### So what does a production image contain?

Everything that does not require a lockfile change, which turned out to be most of what the item
actually asks.

`Dockerfile` builds three targets from one commit — `api`, `web`, `worker`. `node:22-bookworm-slim`
rather than Alpine, because Prisma's glibc query engine is the tested path and an OpenSSL mismatch
is the classic container that builds and cannot connect. Non-root as the image's own `node` user,
under `dumb-init`, because Node does not forward SIGTERM to children and 20 §4's "workers drain
their in-flight jobs before exiting" is false without it. The registry token is a **build secret**
rather than a build argument: an argument is recorded in the image's history and readable by
anybody who can run `docker history`, which is the ordinary way a token leaks.

Two properties are decisions rather than defaults.

**LibreOffice and Tesseract are build arguments on the worker target alone.** Both are real system
packages this product shells out to by a configured path, and both are large — roughly 600 MB and
120 MB. `WITH_LIBREOFFICE` and `WITH_TESSERACT` decide whether the binaries are *present*;
`OFFICE_DRIVER` and `OCR_DRIVER` decide whether they are *called*. Presence has to be a property of
the image because an image without LibreOffice cannot be configured into having it, and an API image
should not carry 600 MB for a converter it never invokes.

**No Node dependency was added, and no base image pretends otherwise.** A `sharp`-preinstalled base
image would look like progress and change nothing: `pnpm install --frozen-lockfile` would still
refuse a package the lockfile does not name, and it must refuse, because an image whose dependency
set differs from the one CI tested is an image nothing has tested. **The blocker has never been the
operating system.**

### CI/CD validation

The images job builds all three targets on every push and pull request. It exists because of what
the alternative was: **a Dockerfile that nothing builds is a placeholder that looks like a
deliverable** — it stays plausible until a release engineer runs it for the first time, under
pressure, and discovers which `COPY` names a path that does not exist. Writing one and not wiring it
to a gate would have been exactly the thing the brief's items 9 and 11 forbid.

It builds and does not push. Which registry, under which credentials, with which retention is a
deployment decision this repository has no answer to; what it can assert is that the images build
from this commit.

---

## 4. The three named-owner rows

### Phase 15's evidence-CSV finding, and the objection that had to be answered rather than ignored

Phase 15 found that Phase 9's `evidenceCsvRow` quotes every field uniformly, neutralises no
spreadsheet formula, and *says in its own comment that uniform quoting is what prevents the
injection*. It does not — a CSV reader strips the quotes before the spreadsheet parses the cell, so
`"=1+1"` is a formula. Phase 15 deliberately did not fix it, and its reason is correct:

> an evidence bundle's bytes are what a signed manifest's digest attests, and rewriting the writer
> silently changes what a re-export of the same range produces

**That is an argument against a silent change, not against the fix.** So the rendering rule became a
**named profile the manifest states**:

- `RFC4180` — Phase 9's exact behaviour, reachable by configuration, so an investigation holding a
  bundle produced before this change can reproduce its bytes and check them against the digest in
  the manifest it already has.
- `RFC4180_FORMULA_NEUTRALISED` — the default from now on, and what 15 §4 requires of any file this
  product hands to a spreadsheet.

Three things make that honest rather than a version bump. **No row hash changes**: a digest is over
the audit row's own fields, never over the CSV rendering, so every chain link and every signature
written before this is untouched and `attests` says exactly what it always said. **An artefact
digest is over the bytes actually written**, so a re-export under a different profile produces a
different `sha256` — which is the fact that had to become legible rather than be avoided. And
`manifestVersion` is `2`, because a reader that does not know about `csvProfile` must not assume the
old one.

The header row is deliberately *not* run through the cell writer, and the comment says why: quoting
it would change the bytes under both profiles and break the one property the profile exists to
preserve. That is not a hypothetical — the first implementation quoted the header, and the existing
unit test caught it.

The cell rule moved to `core/persistence/csv.ts`, shared with Phase 15's report writer, because the
module boundary lint forbids `audit/domain/` reaching into `reporting/domain/`. That is the
`StreamDigest` precedent exactly, and it is what stops the two writers drifting into one
neutralising and the other not.

### Phase 14's TOTP row, which is a question about where any key lives

Phase 14's row asks for "a key management service", and reading that as a request for an integration
is the mistake. **The deployment's secret store already is one.** A KMS, a sealed secret, a mounted
file, a vault agent and — on a single on-premise server — an environment file with `0600` on it are
the same thing from inside this process, and every other secret it holds already arrives that way.
A `KEY_MANAGEMENT_PORT` would have been an eleventh port with one adapter, bought for one column,
with a network call in the sign-in path that fails closed when the KMS blinks.

[ADR-0020](../architecture/adr/0020-key-management-and-rotation.md) argues that and identifies what
the row was *actually* about — two properties the arrangement did not have:

**One key, one purpose.** Phase 14 derived the sealing key from `JWT_ACCESS_SECRET`. That derivation
was careful — domain-separated SHA-256, precisely so one string was not doing two cryptographic
jobs — and it still left the two on **one rotation clock**. Rotating the token secret is routine
with a fifteen-minute blast radius; it also, silently, made every enrolled authenticator in the
deployment unreadable, and nothing would have failed until somebody tried to sign in.

**Every sealed value names the key that sealed it.** Both keys unseal, new seals use the current
one, and a stale row is re-sealed **the next time its owner successfully proves a code** — inside
the transaction that records the success. That is the only moment in the system where the plaintext
and a proof of it exist together; a deploy-time pass would need every tenant's authenticator secrets
unsealed in one process, which is the exposure sealing exists to prevent.

The consequences are stated rather than hidden: a rotation never completes for an account nobody
signs into, so the old key is discarded when the operator is willing to force re-enrolment for
whoever is left; and removing a key rows are still sealed under produces an error naming
`MFA_TOTP_SEALING_KEY` rather than a failed sign-in that looks like a wrong code. Both are tested
against a real database. `v1` stays readable for ever, which is what makes this a deploy rather than
a migration — a deployment that sets no dedicated key produces byte-identical ciphertext.

### Phase 12's SMTP adapter — and yes, this phase could test one

Phase 12 refused to build it, and its reason was about evidence rather than about SMTP:

> an untested hand-rolled SMTP client is a larger risk than an unbuilt one, and this environment can
> add no dependency

The second clause is still true — `nodemailer` needs a lockfile change. The first is answerable by
producing the evidence, and that is what this phase did rather than overruling the objection.

The work splits so that almost none of it needs a mail server. **`mime.ts` is a string
transformation** — RFC 2047 encoded words so an Arabic subject survives, folding, the multipart
boundary, dot-stuffing — and is unit-tested against the specifications' own examples, including the
two defects that would otherwise ship: a multi-byte character split across two encoded words (which
decodes to a replacement character in every client, and only for subjects long enough to need a
second word), and **header injection**, because this product's subjects are rendered from tenant
templates with document titles substituted in and `Subject: x\r\nBcc: …` is the attack.

**`smtp-session.ts` is a command sequence and a reply-code comparison**, driven in the integration
suite against a socket the suite controls, replaying transcripts of what Postfix, Exchange Online
and a small relay actually answer. That is deliberately not "a server I also wrote, agreeing with my
client": the assertions are about the bytes this client writes and the branch it takes, and every
branch is defined by RFC 5321 rather than by a vendor. **The STARTTLS upgrade is a real handshake**
against a fixture certificate, so the credential path runs over a channel that is genuinely
encrypted — and a test asserts that a self-signed certificate is *refused* by default, which is what
makes `MAIL_SMTP_REJECT_UNAUTHORIZED` a control rather than a comment.

Transport security is `node:tls`. **This is the same trade Phase 17 made for OIDC verification and
refused for XML-DSig**, and the distinction is unchanged: SMTP is a line protocol where a reader can
check every branch by eye, and CBOR and XML canonicalisation are formats where the parsing is the
hard part and a subtly wrong implementation still accepts valid input.

The classification is the load-bearing logic, exactly as it is for the hosted driver: **5xx
permanent, 4xx transient, and a transport failure not permanent** — a mail server being unreachable
says nothing about the address. Getting it backwards would either retry a nonexistent mailbox for
ever or suppress a real one because a relay greylisted a first attempt, which is what a correctly
configured relay does to every new sender.

Two things the suite does **not** prove, stated rather than implied. It does not talk to a real MTA
in CI — the transcripts are fixtures, and a wrong fixture is a wrong test. And it does not prove
deliverability, which is SPF, DKIM and DMARC and is a property of a deployment's DNS.

*(For what it is worth outside the suite: during development the adapter was pointed at CPython's
own `smtpd`, which accepted the message with the Arabic subject and display name correctly encoded.
That is third-party interop evidence and it is **not** in CI, because `smtpd` was removed from
Python 3.12 and a test that silently skips on the runner is worse than no test.)*

---

## 5. The integrity sweep, which three reports called Phase 18's

17 §8 has promised this since Phase 0 — *"a rolling verifier plus verification on every preview
fetch; mismatch quarantines and raises an incident"* — and 13 §2 has carried `INTEGRITY_MISMATCH`
with the note *"Phase 18 — the integrity sweep that would detect one"*. Nothing had ever written
that action.

`storage.verify-integrity` runs nightly, reads a bounded page of blobs back from the store,
re-hashes each, and records the finding on the row. Three decisions in it.

**A pass carries no cursor.** The page is ordered by the column the pass writes — least recently
verified first, never-verified before everything else — so a blob checked now sorts to the end and
the next call naturally takes the next set. A crashed pass loses nothing, and there is no stored
position for a restore or a failover to disagree with.

**A verified blob writes no audit row.** One chained, retention-governed row per blob per pass to
say that nothing happened would be millions of them — 13 §2's argument against auditing favourites,
at a far larger scale. The *finding* is recorded on the row, where the next pass reads it. Only a
mismatch is an event.

**The read is bounded, and a blob too large is marked checked anyway.** `StoragePort.read` returns a
whole `Buffer` — there is no streaming read on the port — so an unbounded pass would hold a 2 GB
scan in a background lane's memory, which is what 19 §5 forbids. Blobs above
`STORAGE_INTEGRITY_MAX_BYTES` are skipped, and their `integrity_checked_at` is stamped even though
the status stays `UNVERIFIED`. Without that stamp the ordering would return the same
too-large blobs on every pass for ever and the sweep would never reach anything else — a bug the
ordering choice creates and the stamp closes.

`IntegrityStatus` is its own enum rather than a value inside `ScanStatus`, and the reason is the
remedy: `INFECTED` means the bytes are what was uploaded and the upload was hostile — destroy them.
`MISMATCH` means the bytes are **not** what was uploaded — a storage fault or a tampering incident,
recovered by a restore. Collapsing them would make "was our object store corrupted" a question this
product cannot answer.

The quarantine is the half of 17 §8's sentence that is not the detection: a mismatched blob is
unreachable through the same gate an infected one fails, and **nothing but a successful re-read
clears it**. An operator with a database connection cannot mark a blob good, deliberately — a blob
marked good by a human is exactly what the control exists to prevent.

It rides `retention.run` rather than taking a lane of its own. That lane has one subscriber, and a
second BullMQ `Worker` on the same queue would take its jobs at random, so the schedule has to be
answered by the class that answers the other two — through the `BlobReaper` port Retention already
reaches Storage through. A new lane would have needed a concurrency, a retry policy, a dead-letter
queue and a consumer, for work whose shape is identical to the sweep already there.

---

## 6. Security testing and penetration testing preparation are two items

### The suite, and what it deliberately does not assert

Sixteen phases built the controls, and every one is tested by the suite that built it:
deny-precedence is `acl.integration.spec.ts`; the empty predicate Phase 17 made unrepresentable is
`integration-platform.integration.spec.ts`'s two keys with different *totals*; the outbound
allow-list is `allow-listed-http.adapter.spec.ts`, which asserts that no socket opens; the hash
chain's three digest versions are `audit-chain.integration.spec.ts`.

**Restating any of those in a file named "security" would be ceremony** — a second assertion of the
same property, proving nothing the first did not, and doubling what a change to the property costs.
The brief's own framing is right: a suite asserting what the code already asserts is ceremony. So
`security.integration.spec.ts` asserts only what has no owning suite, and each of its assertions
fails when a **future** phase adds something and forgets a rule:

**Every tenant-scoped table isolates.** Discovered with the same query the post-migration gate uses,
so the two cannot protect different sets. Four assertions: the discovery finds tables at all (the
failure mode of a suite built on discovery is passing vacuously); RLS is `ENABLED` **and `FORCED`**
— the second is the half the deploy gate does not check, and it is the half that matters most,
because without it the *owner* bypasses the policy and the owner is who migrations run as; the
`tenant_isolation` policy exists on each; and — the behavioural one — **as `edms_app`, with one
tenant set, every table returns zero of the other tenant's rows**. A policy can exist and be wrong.
It runs as the application role deliberately, because CI's `edms_owner` is the cluster superuser and
a suite asking this question as the owner would be asking it of a connection that bypasses every
policy. That is Phase 14's finding, followed as a rule.

**No API-key scope reaches `document:sign`, `user:manage`, `role:manage` or `settings:manage`** —
ADR-0018's property that coarse scopes buy, asserted over the catalogue, with a positive control so
that a `permissionsForScopes` returning nothing would not pass every case.

**Production refuses every configuration that weakens a control** — thirteen cases, each varying one
thing from a fixture that boots.

A fourth check became a **boot refusal instead of a test**, which is strictly stronger.
`RoutePermissionRegistry` has failed the boot on a mutating route with no permission since Phase 1;
it could not fail on a route declaring a *misspelt* one, because a string is a string, and the
consequence is a route that refuses everybody for ever — which reads to a customer as a broken
feature rather than as a defect. It now rejects any declared permission the catalogue does not
contain. An assertion in a suite is something somebody can skip; a process that will not start is
not.

### The preparation, which is a document

`docs/operations/penetration-testing.md`: the threat surface **by what it is rather than by route**
(unauthenticated, person-authenticated, machine-authenticated, object-level, content, outbound,
asynchronous, evidence — each with the control worth attacking); the scope boundary with a reason
per exclusion; **what is in scope and usually assumed not to be** (the tenant administrator is in
the threat model; a valid session is in it for *reach*, where the question is never "can they call
the route" but "does the total obey their reach"); the two-tenant test-account story; and the
answer to what a tester may do to a tenant's data — **anything, to their own tenant**, which under
ADR-0015 is a database, so the blast radius is a restore-by-reprovisioning rather than a backup.

It also says what it is not: no test has been performed, no staging deployment exists, and no
scanner was run — because running one and pasting the report is not what this item is, and a clean
automated scan against a permission model this size would say almost nothing.

---

## 7. Load testing: the harness exists and the numbers do not

19 §8 has said this since Phase 0:

> Scenarios, thresholds and the harness live in `edms/infra/loadtest/` … Every phase records its
> measured numbers against the table in §1, and a regression against the previous phase blocks the
> release.

**The directory did not exist, no harness was written, and no phase has ever recorded a number.**
That is the same shape as 19 §5's fairness sentence, which was false until Phase 16 and now says so,
and this section is that admission for §8.

Phase 18 built the harness and **deliberately did not produce numbers**. A load test needs a target
and this product has no deployment: figures taken against one PostgreSQL container on a build
machine with no object store would measure nothing a customer runs, and writing them into §1's table
would be worse than the empty column — the next phase would be held to a baseline that means
nothing.

So `infra/loadtest/` holds the scenarios as data with §1's own thresholds beside each, and a
dependency-free Node runner that exits non-zero when one is missed. That is the half of "a
regression blocks the release" a script can enforce; the other half needs a stored baseline, and the
first run against staging *is* that baseline. It is a step in the release checklist rather than in
CI, because a shared runner's timings would fail these thresholds for reasons unrelated to the
release.

**Three of §8's five named scenarios are not implemented, and `scenarios.mjs` says which and why**
rather than letting the count pass unremarked. 100 parallel uploads measures the object store rather
than the API, because bytes never pass through it (19 §2). 500 approvals per minute and a full-tenant
index rebuild both need a seeded corpus, which is a fixture generator rather than a request loop and
is the larger half of that work. Two were added instead — document detail and **the dashboard**,
because it is the most-loaded route in the product and Phase 13's "bounded queries, independent of
rows" is a claim a load test can falsify and a unit test cannot.

**19 §5's fairness claim was measured by nobody, including this phase.** The per-tenant cap is a
counter in Redis exercised by the integration suite; the *property under load* needs two tenants each
queueing thousands of jobs against a running broker. Named here rather than left to be assumed.

---

## 8. What was found by building this phase

**The evidence CSV's header would have broken its own reproducibility promise.** The first
implementation ran the header row through the profile's cell writer, on the reasoning that a rule
applied to the body and not the header has one row's hole in it. It does not: quoting the header
changes the bytes under *both* profiles, which breaks the one property the profile was added to
preserve. The existing unit test caught it, and the header is now bare with a comment saying why the
omission is deliberate.

**`net.Server#close` waits for open sockets, which hung the SMTP suite rather than failing it.** A
test whose client failed mid-conversation left a connection open, `afterEach` never resolved, and
seventeen tests reported a thirty-second timeout instead of the one real failure.
`closeAllConnections` is `http.Server`'s, not `net.Server`'s, so the connections are tracked and
destroyed. Worth recording because the symptom — a suite that hangs — points at the test that is
running rather than the one that failed.

**A socket in string mode cannot be handed to `tls.connect`.** The SMTP session used
`setEncoding('utf8')` and reading was clean until STARTTLS, at which point the upgrade produced a
socket that never emitted data. Decoding per chunk instead is safe here because SMTP replies are
ASCII, so no multi-byte character can straddle two chunks — which is the sentence that had to be
true for the change to be correct rather than merely working.

**`realRetention`'s test helper needed the storage service and fifteen suites do not.** The
integrity sweep reaches Storage through Retention's port, so the fixture gained an optional
dependency. That is a smell worth naming rather than hiding: it exists because one queue lane may
have one subscriber, and the alternative — a second `Worker` on `retention.run` — would take jobs
from the first at random.

---

## 9. What was built

| Area | Added |
| --- | --- |
| Observability | `METRIC_CATALOGUE` with per-name labels; the Prometheus registry and its no-op sibling; `METRICS_REGISTRY` and `/api/metrics`; `MetricsSampler`; `RequestObservabilityInterceptor`; W3C trace context and its fourteen tests; metric call sites in seven files |
| Storage | The rolling integrity verifier: `IntegrityStatus`, two columns, one index, the sweep, the quarantine, `INTEGRITY_MISMATCH` and `storage.integrity-mismatch` |
| Identity | `MFA_TOTP_SEALING_KEY`, the versioned seal, and the re-seal on a successful challenge |
| Audit | The evidence CSV profile, `manifestVersion: 2`, and `csvProfile` on the manifest |
| Notification | The SMTP adapter: `mime.ts`, `smtp-session.ts`, `smtp-mail.adapter.ts`, and `MAIL_SMTP_*` |
| Core | `core/persistence/csv.ts`, shared by both writers; `AdministrativeChange.outcome`; the registry's catalogue check |
| Config | Eleven variables added, two refused, one boot refusal removed (`MAIL_DRIVER=SMTP`) |
| Packaging | `Dockerfile` (three targets), `.dockerignore`, and the `images` CI job |
| Tests | `security.integration.spec.ts`; the SMTP suite; the sealing-key rotation suite; the integrity-sweep suite; the Prometheus registry suite; the trace-context suite |
| Load | `infra/loadtest/` — scenarios, thresholds, a runner, and a list of what it does not measure |
| Docs | `docs/operations/` (four runbooks); ADR-0020; 13 §6, 17 §§8/9, 18 §3, 19 §§5/8, 20 §§3/4/5/6/7 updated; README, ARCHITECTURE and `.env.example` |

---

## 10. What it costs

| Cost | Figure | Why it is accepted |
| --- | --- | --- |
| Every request now writes a completion log line and a histogram observation | One log record and one map lookup per request | It is the span. Under `METRICS_DRIVER=NONE` the observation is a method call that returns |
| Lane depth and outbox backlog are sampled | One Redis round trip per lane plus a bounded query per tenant database, every 15 s | **Only when an exporter is configured.** `NONE` costs one `if` at boot |
| The metrics registry holds series in process memory | Bounded by `METRICS_MAX_SERIES` | An unbounded registry is the failure the label rule was written to prevent |
| The integrity sweep reads blobs back from the store | One `GET` per blob per pass, bounded per pass and per blob | At the defaults a tenant with 200,000 blobs is fully re-verified about every four months. Faster costs reads against the object store |
| A blob above the size bound is never verified | Stamped as looked-at, left `UNVERIFIED` | The alternative is a sweep that returns the same blobs for ever and reaches nothing else. Closed by a streaming read on the storage port |
| Re-exporting an evidence range produces different bytes than before Phase 18 | A different artefact `sha256` | It is *stated* on the manifest, and the old profile reproduces the old bytes exactly. No row hash changes |
| A TOTP rotation never completes for a dormant account | The old key cannot be discarded on a schedule | Re-sealing needs the plaintext, which exists only when its owner proves a code. A deploy-time pass would unseal every tenant's secrets in one process |
| The SMTP client opens one connection per message | No pipelining, no connection reuse | A round trip per message, and a failure attributable to the message that caused it. Reuse is an optimisation; correctness is not at stake |
| The production images carry development dependencies | Larger images | `prisma` is a devDependency and generates the client, so a `--prod` tree has neither the generator nor a way to run it. The Dockerfile says so and §11 names the fix |
| CI builds three images on every push | Several minutes, cached | A Dockerfile nothing builds is a placeholder that stays plausible until a release |

---

## 11. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| **No numbers against 19 §1's table** | A load test needs a target and there is no deployment. Numbers from a build machine would be a baseline that means nothing | A staging deployment. §7 |
| **19 §5's fairness property is unmeasured at scale** | It needs two tenants each queueing thousands of jobs against a running broker | The same |
| **No OTLP or Sentry exporter** | Both need a lockfile change; both variables are now refused rather than ignored | One `pnpm add`, from an environment with a `read:packages` token (§3) |
| **`sharp`, `@pdf-lib/fontkit`, `ldapjs`, `cbor` — the rasteriser, the Arabic watermark font, non-PNG thumbnails, LDAP, SAML, WebAuthn** | All the same blocker, now precisely characterised: the *registry* is reachable, the private scope's credential is not, and any lockfile write re-resolves everything | The same commit. This is the packaging answer, and it is a token rather than a wall |
| **"Verification on every preview fetch"** — the second clause of 17 §8 | A full read and a SHA-256 in front of every page view is a cost 19 §1's preview target has no room for | A streaming digest on the storage port, or a cached verification whose staleness is its own question |
| **The production image carries dev dependencies** | `--prod` drops the Prisma generator that produces the client | A build that generates the client where a prod tree can carry it |
| **No restore has been performed, and the RTOs are targets rather than measurements** | There is no deployment to restore | The first quarterly test, which the runbook makes a procedure rather than an improvisation |
| **No automated failover for any DR scenario** | Half of one fails over when it should not and does not when it should | A phase whose subject is the platform rather than the product |
| **No penetration test has been run** | This phase produced the preparation; a test needs a staging deployment and an engagement | Both |
| **`ARCHIVED`, `REINSTATED` and `LINKED` still have no writer** | Phase 13 §2's rows. This phase built none of those capabilities either — production readiness archives nothing | The phase that builds each |
| **Audit partitioning is still not built** | Phase 10's two trigger conditions — twenty million rows in a tenant, or a disposition for the trail's own retention — have **neither fired**. No deployment means no tenant has any number of rows | The trigger stands unchanged. Phase 18 restated it rather than inventing a new one to look decisive |
| **The MFA role policy is still unenforced** | Phase 14's and Phase 17's row, unchanged: switching it on locks out exactly the accounts that administer a tenant, and the way back in is ADR-0013's operator console | ADR-0013's console, which is still nobody's phase |
| **Quota accounting still does not exist** | ADR-0012's and Phase 21's, as Phases 10, 13, 15, 16 and 17 each recorded | Phase 21 |
| **No operator console** | Explicitly out of scope, and building half of one is what Phase 17 §12 described. Phase 18 needed it for nothing and built none of it | ADR-0013 |

---

## 12. Limit rows discharged from earlier reports

Earlier reports are historical and stand unedited; these lines are their discharge.

| Row | Phase | Status |
| --- | --- | --- |
| Metrics and tracing are ports without an exporter (debt row 9) | 0.5 | **Discharged.** Bound behind a driver, exported by pull, with all ten names emitted and the label rule enforced rather than described. Tracing is one span per request, and 20 §5 now says so |
| No SMTP adapter; `MAIL_DRIVER=SMTP` refused at boot | 12 | **Discharged.** Built, and the testability objection answered rather than overruled — §4 |
| The TOTP secret is sealed with a key derived from the signing secret | 14 | **Discharged**, and re-scoped: ADR-0020 argues the row was about rotation rather than about an integration |
| Phase 9's evidence CSV still does not neutralise formulas | 15 | **Discharged**, without the silent change Phase 15 warned against: a named profile the manifest states |
| Production readiness and the integrity sweep | 16, 17 | **Discharged.** §5 |
| The rasteriser, the Arabic watermark font, non-PNG thumbnails | 7, 16 | **Open, and now precisely characterised.** Not a wall: the registry is reachable and the private scope's credential is not (§3) |
| LDAP, SAML, WebAuthn | 14, 17 | **Open**, same blocker, same characterisation |
| Inbound provider webhooks for delivery receipts | 12 | **Open.** Needs a public route verifying a provider's own signature scheme, one per provider. Untouched |
| Report delivery — a finished export as a notification with an attachment | 15 | **Open.** Needs a `reporting.export-ready` notification type with a signed link; Phase 12's machinery and still nobody's phase |
| The queued bulk consumer (shipped seam, no consumer) | 16, 17 | **Open**, untouched. The lane, the record and the cap are built; a resumable import is what closes it |
| The import mapping and the Microsoft 365 content integration | 17 | **Open**, untouched |
| The OpenAPI document describes routes, not body shapes | 17 | **Open**, untouched. A zod-to-JSON-Schema projection over `@edms/contracts` |
| Nobody is notified when a webhook endpoint disables itself | 17 | **Open**, untouched |
| A dead delivery cannot be replayed from the screen | 17 | **Open**, untouched |
| An API client cannot be scoped to a folder | 17 | **Open**, and still ADR-0018's refused alternative |
| The MFA role policy | 14, 17 | **Open, and declined again** on the same reasoning. §11 |
| `ARCHIVED`, `REINSTATED`, `LINKED` have no writer | 13, 17 | **Open**, untouched |
| Quota accounting | 10, 13, 15, 16, 17 | **Open.** Phase 21's |

---

## 13. What the phase deliberately did not do

**It did not build half an operator console.** Phase 17 §12 described what half of one would have
been — a break-glass route guarded by a secret in configuration, with no ACL, no audit actor and no
expiry — and this phase needed it for nothing and built none of it.

**It did not add a caching layer.** "Caching" is in the brief; 19 §4's table is built, Phase 14's
decision cache is invalidated by prefix inside the transaction that changed an answer, and Phase
13's dashboard and Phase 15's reports each argue in writing why they cache *nothing*. A new cache
would have been a second thing to invalidate and a stale figure somebody acts on.

**It did not touch quotas or entitlements.** Named out of scope by the brief and by ADR-0012.

**It did not partition `audit_event`.** Phase 10 set two trigger conditions and named both so they
could not be reset silently. Neither fired. The trigger stands unchanged — a phase that arrives,
meets neither condition and restates the existing trigger is the honest outcome; inventing a new one
would be the quiet reset Phase 10 wrote its section to prevent.

---

## 14. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean |
| `pnpm typecheck` | Clean |
| `pnpm test` | Clean — **614 API** (was 550), 164 domain, 26 contracts, 21 web, 11 utils, 4 i18n, 2 worker |
| `pnpm test:integration` | **578 tests across 33 files** (was 530 across 31), against two real tenant databases |
| `pnpm build` | Clean |

The phase's own assertions, all against a real PostgreSQL unless noted:

- **Every tenant-scoped table, discovered rather than listed, returns zero of another tenant's rows
  to the application role** — and has RLS `ENABLED` *and* `FORCED`, which the deploy gate does not
  check.
- A write naming another tenant is refused by the policy's `WITH CHECK`, with every application
  layer above it bypassed.
- The metric registry **drops** an undeclared name, an undeclared label — including a tenant id — a
  metric recorded as the wrong kind, and a series past the bound, and *says* how many it dropped.
- `traceparent` is refused for a future version, a short id, non-hex, an injected newline and an
  all-zero id, and round-trips what it emits.
- A TOTP enrolment sealed under Phase 14's key **is read after the dedicated key arrives**,
  **re-seals on the next successful challenge**, still verifies afterwards, and produces an error
  naming `MFA_TOTP_SEALING_KEY` when the key it was sealed under is removed.
- An evidence CSV neutralises `=HYPERLINK(…)` and every formula leader, **reproduces the
  pre-Phase-18 bytes under the old profile**, leaves the JSONL untouched, and states the profile on
  a `manifestVersion: 2` manifest.
- The SMTP client sends the commands in order, **reads a multi-line reply as one reply**, falls back
  to `HELO`, upgrades to TLS against a real handshake, authenticates with `PLAIN` and with `LOGIN`,
  **refuses credentials on an unencrypted channel and refuses a stripped STARTTLS**, refuses an
  unvalidated certificate by default, and classifies a rejected mailbox as permanent and a
  greylisting and a hang-up as transient.
- A MIME header cannot be injected through a subject, a multi-byte character is never split across
  two encoded words, and a leading dot in a body is doubled.
- The integrity sweep **verifies a blob, writes no audit row for it**, quarantines one whose bytes
  changed underneath the application, records both digests on a row whose outcome is `FAILED`, and
  makes the quarantined blob unreachable.
- Production refuses to boot without the antivirus gate, object storage, a mail provider, the
  checkpoint key, the witness key or the sealing key; and refuses plaintext outbound requests, the
  interactive explorer, a short signing secret and SMTP without transport security.
- No API-key scope reaches `document:sign`, `user:manage`, `role:manage` or `settings:manage`.
