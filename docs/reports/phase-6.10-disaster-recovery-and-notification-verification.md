# Phase 6.10 — Disaster Recovery Restore Rehearsal & Notification Production-Path Verification

## 1. Executive summary

**Status: PARTIALLY COMPLETE.**

Both objectives were pursued to the end. One is fully verified, one is verified in the half that this
repository's backup design actually covers, and the phase found a **P0 that had made every scheduled
background job in the product inert since the first one was written.**

- **The notification production path is VERIFIED.** A person submitted a document in a browser, a
  second person approved it in theirs, and the resulting notification was traced through every
  boundary to the recipient's own screen — event, outbox row, dispatch, lane, consumer, message row,
  inbox. Nothing was synthetic at any point.
- **Disaster recovery is PARTIALLY VERIFIED — database restore verified; object storage NOT
  VERIFIED.** The first restore in this repository's history was performed: two tenants in two
  databases, backed up, restored into a freshly-initialised empty PostgreSQL cluster, compared
  table-by-table with **zero differences**, and then *served by the real product in a real browser*.
  What was not restored is the object store, because the documented backup does not include it —
  §13 says so rather than working around it, and §31's own rule forbids calling the whole thing
  verified.

**The P0.** Every scheduled fan-out in this product derives a job identifier that embeds the firing's
own `repeat:<name>:<epoch>` id. BullMQ refuses a custom job id containing `:` unless it happens to
split into exactly three parts — a compatibility carve-out for its own older repeatable ids. So every
scheduled job threw on its first line: **no email had ever been sent, no retention swept, no document
expiry fired, no audit chain verified, no webhook retried, no audit sink streamed, no search
projection written, no workflow timer set.** The outbox dispatcher was unaffected, because
`outbox:<row>:<lane>` is three parts by coincidence — which is exactly why nothing noticed: in-app
notifications arrived, so the pipeline looked alive.

It was found because §23 asked for retry evidence, and retry needs a delivery pass, and there had
never been one. Fixed under the brief's §3 clause — without it §23 is unexecutable — and guarded by
an integration test against a real broker.

| | Count |
| --- | --- |
| P0 | **1** (fixed) |
| P1 | 1 (fixed — documentation) |
| P2 | 2 (deferred) |
| P3 | 2 (deferred) |

## 2. Scope

Only the two gaps Phase 6.9 named. No feature work, no architecture change, no new backup system, no
new notification system, no notification type invented, no Platform modification.

Executed against `apps/api/dist/main.js`, `next start` over the production build, PostgreSQL 16 in
**two clusters** — a source and a freshly-`initdb`'d destination — Redis, and real Chromium.

## 3. Existing DR architecture — IMPLEMENTED

`docs/operations/disaster-recovery.md` and `backup-and-restore.md` describe seven scenarios and a
per-tenant restore. Read against the code rather than taken on trust, three claims check out and one
does not:

| Claim | Verdict |
| --- | --- |
| A restore is one customer's, because each tenant has its own database (ADR-0015) | **True.** The catalogue names a connection string per tenant; `migrate-tenants.mjs` and the API read the same one |
| The post-migration gate raises on a tenant-scoped table without RLS | **True**, and exercised — it is step 3 of the rehearsal |
| The audit chain verifier is what makes a restore checkable | **True**, and it has no HTTP route: it is a schedule, which is how the P0 below stayed invisible |
| Restores are tested quarterly | **False as written.** §4 of that document already admitted no restore had ever been performed. It has now, once |

## 4. Existing backup procedure — IMPLEMENTED, and partly unexecutable as written

`backup-and-restore.md` §1 backs up PostgreSQL by continuous WAL archiving plus a nightly base
backup, and object storage by versioning plus cross-region replication. Redis and the search index
are deliberately not backed up, each with a stated reason that survives inspection.

**What is and is not in scope of the artefact this rehearsal produced:**

| Component | In the backup? |
| --- | --- |
| PostgreSQL, per tenant database | **Yes** — schema, data, grants, RLS policies and the audit immutability revoke all travel in the dump |
| Object storage (document blobs, audit checkpoints) | **No.** A different mechanism entirely (bucket versioning + replication) |
| Redis | **No**, by design. Queues are fed from the transactional outbox; consumers are idempotent |
| Search index | **No**, by design. Derived, and rebuilt rather than restored |
| Configuration and secrets | **No.** `TENANT_CATALOGUE`, `JWT_ACCESS_SECRET`, `AUDIT_CHECKPOINT_SECRET`, `SIGNATURE_WITNESS_SECRET` must be **recreated** by the operator |

**Must be recreated:** the cluster roles (`infra/sql/cluster/01-roles.sql`), every secret, and the
tenant catalogue entry pointing at the restored database. **Must be reconfigured:** nothing else —
step 5 of §2 is an edit to one catalogue entry.

## 5. Backup artefact — VERIFIED

Custom-format `pg_dump`, one file per tenant database, because `pg_restore --create` is the command
the document names and it reads custom or directory format.

| | primary (`dr_edms_acme`) | secondary (`dr_edms_rival`) |
| --- | --- | --- |
| Bytes | 408,833 | 373,529 |
| SHA-256 | `3bfe233babf037dc…` | `014db333cc574407…` |
| Table-of-contents entries | 906 | 906 |
| `TABLE` entries | 237 | 237 |
| `TABLE DATA` entries | 79 | 79 |
| Archive created at | 2026-08-09 09:28:51 UTC | 2026-08-09 09:28:51 UTC |

Verified **before** anything was restored, with `pg_restore --list` — which parses the archive's
table of contents, so a truncated or unreadable file fails there rather than half way through writing
a database. The digest is recorded rather than compared: there is nothing to compare a first backup
to, and its purpose is the *next* one.

## 6. Restore environment — VERIFIED empty

A second PostgreSQL 16 cluster, `initdb`'d for this rehearsal on port 5442, with no application
tables, no tenant data, no users, no audit events and **not even the `edms_owner` and `edms_app`
roles**. The rehearsal script refuses a destination that already holds either tenant database:
restoring over an existing copy proves that a restore can overwrite, which is not the claim.

The source cluster was never written to, never dropped and never restored over. The dev databases
holding unrelated work (`ci_edms_acme`, `ci_edms_rival`) were untouched throughout; the rehearsal
used its own `dr_edms_*` pair.

## 7. Restore procedure — VERIFIED, after a defect in the documented order

`scripts/dr-rehearsal.mjs`, which is `backup-and-restore.md` §2 with the comparison and the timings
recorded. Every step uses this repository's own tooling, unmodified.

1. `psql "$DEST_ADMIN_URL" -f infra/sql/cluster/01-roles.sql`
2. `pg_dump --format=custom` per tenant, then `pg_restore --list` to verify
3. `pg_restore --create --exit-on-error --dbname="$DEST_ADMIN_URL" <file>` per tenant
4. `psql "$RESTORED_ADMIN_URL" -f infra/sql/database/01-grants.sql`
5. `node scripts/apply-post-migrate.mjs` against the restored URL

**Step 1 used to be step 2, and that is P1-1 below.** No manual prerequisite is hidden: the cluster
itself is provisioned by the operator (`initdb`), and the script refuses rather than inventing one.

**Not performed: the point-in-time half.** §2's `pg_wal_replay_pause()` and recovery to a target LSN
need a WAL archive, and an archive is a property of a running cluster rather than of a repository.
What is proven is that the artefact reconstitutes the environment; what is **not** proven is the
five-minute RPO the architecture claims.

## 8. Restore timing — measured

| Step | Duration |
| --- | --- |
| Backup (both databases) | 0.49 s |
| Artefact verification | 0.09 s |
| Cluster roles | 0.05 s |
| `pg_restore` (both databases) | 3.68 s |
| Grants + post-migration SQL (both databases) | 16.91 s |
| **Restore total** (roles → serving-ready schema) | **20.6 s** |
| Application boot against the restored cluster | ~12 s |
| First successful authenticated request | within ~15 s of boot |
| First successful document operation | immediately after |

The two checkpoint passes took 165 s and 167 s each, and are **not** part of the restore: they are the
rehearsal's own comparison, reading every table of every tenant twice.

## 9. Database verification — VERIFIED

Compared source against restored across **every table of every tenant of both databases**, plus the
audit tail, the document roll, the user roll, the revision roll and the notification roll.

**Result: `differences: []`.** An empty list here is a statement about the whole schema — 79 tables ×
18 tenant rows × 2 databases — rather than about a sample.

**MUST MATCH:** every row count, tenant identity, document identifiers and statuses, revision
identifiers, user identifiers, role grants, the latest audit sequence, and its `hash` and
`previous_hash`. All matched.

**MAY DIFFER:** nothing. A dump-and-restore of a whole database has no legitimate divergence.

**EXPECTED TO BE RECREATED:** cluster roles, secrets, the catalogue entry; and separately Redis and
the search index, which are outside the artefact by design rather than inside it and different.

**The one thing that nearly reported a catastrophe, and was mine.** The first comparison said the
restored databases were completely empty. They were not. The source cluster's `edms_owner` had been
created out of band as a *superuser*, which bypasses row-level security regardless of `FORCE`, while
the destination's was created by `infra/sql/cluster/01-roles.sql` and correctly was not — so the two
sides were answering different questions and the difference presented as total data loss. Both sides
are now read as `edms_app` with `app.tenant_id` set, which is the only question worth asking: *what
can this tenant's own connection see?*

## 10. Tenant isolation verification — VERIFIED

Through the real application path, on the restored environment, across two **databases** rather than
two `WHERE` clauses.

| | Result |
| --- | --- |
| Tenant A user → Tenant A document, in the browser | Opens, with its title and its number |
| Tenant A user → Tenant B document, in the browser | Renders a refusal; the neighbour's title appears nowhere |
| Tenant A user → Tenant B document, at the API with a real token | `403`/`404` |
| Tenant B's database → notifications produced in tenant A | Zero rows |

The neighbour's document identifier is a real one that exists in the other restored database, so the
refusal is isolation rather than absence.

## 11. RLS verification — VERIFIED

On both restored databases:

- **77 of 77** tenant-scoped tables have row-level security **ENABLED**
- **77 of 77** have it **FORCED** — enabled alone leaves the owner outside it, which is the Phase 1
  defect that gave this product an integration suite in the first place
- **77** policies present
- `_prisma_migrations` and `tenant` carry none, correctly: one is not tenant-scoped and the other
  *is* the discriminator

**Application role security:** `edms_app` is not a superuser and does not bypass RLS. Neither is
`edms_owner`, on a cluster built from the roles file — which is stronger than the source cluster this
rehearsal started from, and is the state the file produces.

**Audit immutability survived the restore:** `has_table_privilege('edms_app','audit_event','UPDATE')`
is false. That is a targeted `REVOKE` rather than a trigger, so it is exactly the kind of thing a
restore could quietly hand back.

## 12. Audit integrity verification — VERIFIED

Run through the control's own execution path. `audit.verify-chain` has no HTTP route — it is a
schedule — so the rehearsal puts the schedule's own job on the schedule's own lane
(`scripts/dr-verify-chain.mjs`). The payload, the lane, the consumer and
`AuditVerificationService.verify()` are all the product's. **The clock is what is replaced, and only
the clock.**

- **Before the backup:** the chain verified from genesis and a checkpoint was **signed** —
  `HMAC-SHA256`, sequence 19, written to object storage.
- **After the restore:** the chain verified again, and the number is the evidence:
  `eventsVerified: 2`, `toSequence: 21`. It **resumed from the signed checkpoint at sequence 19** and
  walked only what came after. Resuming is sound only because the checkpoint is authenticated — so a
  restored database whose rows no longer recomputed against it could not have reported intact.

That is `backup-and-restore.md` §3's third condition, satisfied: *"the one signal that distinguishes
a restore from a rewrite."*

The audit tail is byte-identical across the restore — sequence, `hash` and `previous_hash` — for
every tenant in both databases. Physical ordering is irrelevant and logical ordering is what
`sequence` carries; nothing changed.

**One honesty note.** The checkpoint store is object storage, which the database dump does not carry.
The restored deployment was pointed at the *same* storage root, which **models** a bucket recovered by
the replication §1 describes rather than exercising one.

## 13. Object storage verification — NOT VERIFIED

Document binary data and audit checkpoints are outside the documented database backup. The documented
mechanism for them is bucket versioning plus cross-region replication, and no object store exists in
this environment to version or replicate.

Nothing was faked to fill the gap: no blob was restored, and no integrity sweep was run against a
restored blob, so `backup-and-restore.md` §3's fourth condition is **not** met.

**This is why the phase status is PARTIALLY COMPLETE rather than COMPLETE**, per §31.

## 14. Application boot verification — VERIFIED

The API and the web application were booted against the **restored** databases — not the source; the
source deployment was stopped first, so nothing could answer from the originals.

| | Result |
| --- | --- |
| Production configuration validation | Passed; the API refused nothing |
| Database connection, both restored tenants | `UP` |
| Redis | `UP` |
| Authentication | Both people signed in again, through the shipped form, against restored credentials |
| Tenant resolution | Both tenants resolved from the catalogue |
| Authorization | Permissions restored; the reader is still refused what the reader was refused |
| Document access | Restored document opens with its title and number |
| Audit access | Timeline renders the restored trail |
| Notification infrastructure | The recipient's restored notification is still in their inbox |

## 15. Real-browser post-restore verification — VERIFIED

Real Chromium, unmocked, against the restored environment.

1. **Login** — signed in fresh rather than reusing cookies, so what authenticates is the restored
   credential.
2. **Tenant access** — the restored tenant resolved and its workspace rendered.
3. **Open a restored document** — title and document number both present.
4. **Revision history** — the revision that was approved, by label.
5. **Audit timeline** — the trail the restored database holds.
6. **Tenant isolation** — §10 above, in both directions.
7. **Logout** — the account menu's sign-out returns to `/login`, and navigating back to a protected
   route lands on `/login` again, so the cookie is gone rather than merely unused.

## 16. RTO/RPO evidence

**RTO: NOT DEFINED as a tested figure.** `20-deployment-architecture.md` §6 states targets — 2 hours
for a database, 4 for object storage — and those are architecture targets rather than measurements.
The measurements above (20.6 s of restore, ~12 s of boot) say the *procedure* works; they say nothing
about a customer-sized corpus, and are recorded as evidence rather than as compliance.

**RPO: NOT VERIFIED.** §1 claims 5 minutes via continuous WAL archiving. Only the base-backup half was
rehearsed. The artefact's own `Archive created at` is the honest RPO of what was taken: everything
committed after 09:28:51 UTC is not in it.

## 17. Notification architecture — IMPLEMENTED

`document.approved` was chosen because Phase 6.4 established it as a real publisher and because it is
reachable from a browser end to end. The path, as built:

```
approve in the browser → WorkflowEngine completes the stage
  → DocumentService.transition → APPROVED
  → announce() → OutboxWriter.publish(document.approved)   [same transaction]
  → PrismaOutboxDispatcher claims the row → enqueues on notifications.deliver
  → NotificationLaneConsumer.consumeEvent → NotificationEventService.handle
  → documentEvent() → RecipientVisibilityService.whoMaySee(owner, creator)
  → NotificationService.notify → notification_message × channel
  → IN_APP is delivered by being written; EMAIL is queued for the delivery pass
  → the recipient's /notifications screen
```

## 18. Notification production path — VERIFIED

**No synthetic event anywhere on the happy path.** Nothing constructed a `NotificationEvent`, nothing
inserted a notification row, nothing called `NotificationEventService`, and no publisher, outbox or
provider was mocked. The originating action is a person clicking *Submit for approval* and a second
person clicking *Approve*, each in their own browser with their own session.

§26's checklist, all ten:

| | |
| --- | --- |
| Originating action is real | ✅ two browsers, two people, the shipped screens |
| Event is real | ✅ `document.approved`, published by `announce()` |
| Outbox entry is real | ✅ row written, `processed_at` set by the dispatcher |
| Consumer is real | ✅ the lane consumer, in the API process |
| Notification row is real | ✅ two, one per channel |
| Intended recipient is correct | ✅ the owner, who did **not** approve it |
| UI displays it | ✅ on the recipient's own `/notifications` |
| Tenant isolation verified | ✅ zero rows in the neighbouring database |
| Authorization verified | ✅ the approver's inbox does not contain it |
| Payload semantics verified | ✅ §21 below |

## 19. Event / outbox evidence

Six outbox rows from one approval, all dispatched:

| `event_type` | `aggregate_type` | processed |
| --- | --- | --- |
| `workflow.started` | workflow | ✅ |
| `workflow.stage-activated` | workflow | ✅ |
| `workflow.task-assigned` | workflow | ✅ |
| `workflow.task-decided` | workflow | ✅ |
| **`document.approved`** | **document** | ✅ |
| `workflow.completed` | workflow | ✅ |

`document.approved`'s `aggregate_id` is the document's own identifier, and its `correlation_id` is
shared with the decision that caused it.

**The edge between the outbox and the notification is asserted, not inferred.** `notify` keys
idempotency on `(eventId, recipient, channel)` and the event id **is** the outbox row's identifier,
so a notification whose `idempotency_key` begins with that id could only have been written by a
consumer handed that row:

```
idempotency_key = 019fe582-21f5-76fe-b35f-0bd3af6e3098:<recipient>:IN_APP
                  ^ the outbox row's own id
```

## 20. Delivery evidence

| Channel | State | Recipient | Address |
| --- | --- | --- | --- |
| `IN_APP` | `DELIVERED` | the document's owner | — |
| `EMAIL` | `QUEUED`, then attempted | the document's owner | the owner's address |

In-app is delivered by being written, which is the whole of its delivery. The approver received the
`workflow.task-assigned` pair and **not** the approval notice — being the person who acted is not a
reason to be told about your own act.

## 21. Notification payload — VERIFIED

Asserted against the **rendered message** rather than against the template:

- event type `document.approved`, correct tenant, correct recipient, correct document
- subject contains the document's title; body contains its number
- no unrendered `{{placeholder}}` survived, **and** no `—` — the product's own substitute for a value
  it does not have, which would mean the variable was missing rather than rendered
- timestamps present; `created_at` follows the decision

## 22. Notification localization — VERIFIED, both languages

The language is a **tenant** setting (`locale.default`), not a per-recipient one. So Arabic was
verified the only way the production path allows: the setting was changed through its own
administrative route, a second document was submitted and approved through the browser, and the row
that came out was read.

| | |
| --- | --- |
| English | ✅ correct template, variables substituted, no raw key |
| Arabic | ✅ `locale = 'ar'`, Arabic script in the subject, the document's number substituted into it, no `{{…}}` |

No translation was written or edited by this phase.

## 23. Notification retry / failure — VERIFIED

`MAIL_DRIVER=NONE` is a **real controlled provider failure** rather than a simulation of one: the
bound adapter refuses every send naming the variable that would fix it, and `DeliveryService`
treats a throwing provider exactly as it treats one returning a failure.

Observed on the real `notifications.deliver` pass, on its real one-minute schedule:

| | |
| --- | --- |
| `attempts` | incremented, 0 → 1 → 2 |
| `failure_reason` | `Email delivery is unavailable.` |
| `release_at` | set — the exponential backoff, capped at five minutes |
| `state` | `QUEUED`, so the message stays claimable |
| Terminal state | at `MAX_DELIVERY_ATTEMPTS` = 5 |

This is the row of `18-notification-architecture.md` §7 that Phase 6.4 found had never been built,
now observed end to end. **It is also what found the P0**: before the fix, no delivery pass had ever
run, so `attempts` stayed at 0 for ever.

## 24. Notification tenant isolation and authorization — VERIFIED

See §10 and §18. Two tenants, two databases: the neighbouring database holds zero notification rows.
Recipient A sees it on their screen; Recipient B's inbox — fetched at the API with B's own token —
contains neither the identifier nor the type.

The inbox is scoped by the query rather than by a route parameter, so there is no identifier to
tamper with. That is worth stating as a property rather than as a test result.

## 25. Defects found

### P0-1 — Every scheduled background job in the product was refused by the broker

**Expected.** A cron schedule fires, the consumer fans out one job per tenant, the tenant job runs.

**Actual.** The fan-out throws on its first `enqueue`, so the scheduled job fails and **no tenant job
is ever created**. Observed live, for three lanes, once per minute:

```
{"queue":"notifications.deliver","jobId":"repeat:notifications.deliver:1786261920000",
 "reason":"Custom Id cannot contain :","msg":"A background job failed"}
{"queue":"webhooks.deliver","jobId":"repeat:webhooks.retry-due:…","reason":"Custom Id cannot contain :"}
{"queue":"audit.stream","jobId":"repeat:audit.stream-sinks:…","reason":"Custom Id cannot contain :"}
```

**Broken component.** `BullMqQueueAdapter.enqueue`, and every site that derives a job identifier.

**Root cause.** BullMQ refuses a custom job id containing `:` **unless it splits into exactly three
parts** — a compatibility carve-out for its own older repeatable-job ids, marked in its source as
*"TODO: replace this check in next breaking check with include(':')"*. Probed against the real
broker, eight of this product's twelve derived shapes are refused:

| Shape | Broker |
| --- | --- |
| `outbox:<row>:<lane>` | **ACCEPTED** — three parts by coincidence |
| `audit:export:<id>`, `reporting:export:<id>`, `search:rebuild:<id>` | ACCEPTED |
| `<kind>:all:<tenant>:repeat:notifications.deliver:<ms>` | REFUSED |
| `<kind>:<tenant>:repeat:<schedule>:<ms>` (retention, delegation, webhooks) | REFUSED |
| `audit:verify:<tenant>:repeat:<schedule>:<ms>` | REFUSED |
| `search:project:<document>:<bucket>` | REFUSED |
| `search:reproject:<scope>:<cursor>` | REFUSED |
| `ocr:<revision>` | REFUSED — too *few* colons |
| `wf-timer:<id>` | REFUSED — too few colons |
| `<jobId>:requeued:<n>` | REFUSED |

**Blast radius.** `notifications.deliver` (no email had ever been sent), the three digests,
`notifications.release-batches`, `retention.sweep`, `storage.sweep-upload-sessions`,
`storage.verify-integrity`, `documents.expire-effective`, `identity.expire-delegations`,
`audit.verify-chain`, `webhooks.retry-due`, `audit.stream-sinks`, search projection and
reprojection, OCR, workflow timers, and the at-cap requeue.

**Why nothing caught it.** The outbox dispatcher — the one path everybody watches — was unaffected,
so in-app notifications arrived and the pipeline looked alive. There was no test of the queue adapter
at all, and every consumer's own tests hand it a job rather than asking the broker to accept one. It
is the fifth control in five phases found to be declared, configured and unreachable.

**Severity: P0.** Production-blocking as found.

### P1-1 — The documented restore procedure produced an unusable database and reported success

**Expected.** `backup-and-restore.md` §2, followed literally, yields a restored tenant database the
application can serve.

**Actual.** Step 1 was `pg_restore --create` and step 2 applied the cluster roles. On a genuinely
empty cluster — which is the disaster case — every `ALTER … OWNER TO edms_owner` and every
`GRANT … TO edms_app` in the archive fails against a role that does not exist yet, and **`pg_restore`
still exits zero**. The result is a database owned by the superuser whose application role cannot
connect to it, produced by a procedure that reported success.

Reproduced exactly, then corrected: roles first, and `--exit-on-error` so a restore that failed half
its statements is distinguishable from one that worked.

### P2-1 — The fixture cleanup cannot delete a tenant row

`cleanUpFixtures` deletes a tenant's data and then swallows the failure to delete the `tenant` row
itself, so empty tenant rows accumulate across runs — 18 of them by the end of this phase. Harmless
to the product and slow for the rehearsal's comparison (165 s per checkpoint pass). Test
infrastructure, deferred.

### P2-2 — The e2e gate rate-limits itself when re-run inside five minutes

`auth.login` is ten attempts per five minutes per address, and the two suites together sign each
person in several times. Re-running the gate immediately produces refusals that surface as *"the page
never navigated"*. **This is the control working**, and it is recorded rather than worked around.

### P3-1 — Point-in-time recovery is unrehearsed

See §7 and §16.

### P3-2 — Object storage restore is unrehearsed

See §13.

## 26. Defects fixed

| | Fix |
| --- | --- |
| **P0-1** | One sanitiser at the adapter boundary — `brokerSafeJobId` — applied in `enqueue` and in the at-cap requeue. Substitution rather than a hash, so every caller's derivation still produces the same identifier from the same inputs and the deduplication each depends on is unchanged in meaning. Done at one boundary rather than at eight call sites, so a ninth site written later cannot miss it |
| **P1-1** | `backup-and-restore.md` §2 reordered, with the failure mode stated in the file so the next reader does not rediscover it. §4 rewritten from "nothing has been performed" to what was performed and what was not. `disaster-recovery.md` §4's "No tested RTO" narrowed to what is still true |

Nothing else was changed. The findings §27 of the brief names — `Retry-After`, field-level API
errors, the outbox-dispatch sleep, workflow accessibility depth — were left alone.

## 27. Defects deferred

P2-1, P2-2, P3-1, P3-2, and every Phase 6.9 P2/P3. None blocks either objective.

## 28. Known limitations

- **The object store was carried, not restored.** The restored deployment was pointed at the same
  storage root. That models a replicated bucket; it does not exercise one.
- **No blob was re-hashed.** `backup-and-restore.md` §3's fourth condition is unmet.
- **The RPO claim is untested.** Base backup only.
- **The rehearsal's destination cluster is provisioned by hand.** `initdb` is an operator act, and
  the script refuses to invent one.
- **Two tenants, small.** The comparison is exhaustive over the schema and the dataset is not
  production-sized.

## 29. Production readiness assessment

**As found: NO-GO**, on P0-1 — a product in which no email is ever sent, no retention ever runs, no
document ever expires and no audit chain is ever verified is not a product that can be operated,
whatever its screens do.

**As left: the P0 is fixed and verified through the pass it was blocking.** What remains between this
and a defensible GO is smaller than it was and is no longer unknown:

| | |
| --- | --- |
| Notification production path | **VERIFIED** |
| Database restore | **VERIFIED** |
| Object storage restore | **NOT VERIFIED** |
| Point-in-time recovery | **NOT VERIFIED** |
| Scheduled background work | **VERIFIED reachable**, for the first time. Individual sweeps are now *runnable* rather than *proven correct* |

## 30. Remaining risks

1. **Every scheduled sweep has just become reachable for the first time.** Retention disposition,
   expiry, the integrity sweep and the nightly chain verification have never run against real data
   in a real deployment. They are now enqueued rather than exercised, and the difference matters.
2. **Object storage recovery is unproven**, and the audit checkpoint lives there.
3. **RTO and RPO are targets**, not measurements, at any realistic scale.
4. The known Phase 6.8/6.9 findings — `Retry-After`, field-level errors, the `404` on a document with
   no revision — are unchanged.

## 31. Recommended next phase

**Phase 6.11 — Scheduled Work Verification & Object-Storage Recovery.** Two things, both now
unblocked and both consequences of this phase:

- Run every schedule the P0 had made inert, once, against real data, and check what each actually
  did: retention disposition, effective-date expiry, the storage integrity sweep, delegation expiry,
  digest collection, webhook retry and audit sink streaming. Eleven schedules have never executed.
- Stand up an object store (MinIO is already in `infra/docker-compose.yml`), upload a real document
  through the product, back the bucket up and restore it, and close
  `backup-and-restore.md` §3's fourth condition and this phase's §13.

## 32. Exact commands and evidence

```bash
# The destination cluster: genuinely empty, provisioned for the rehearsal.
initdb -D /var/lib/postgresql/dr-restore -U postgres --encoding=UTF8 --locale=C.UTF-8
pg_ctl -D /var/lib/postgresql/dr-restore -o '-p 5442 -c listen_addresses=127.0.0.1' start

# The whole phase, both objectives, in one suite.
DR_DEST_ADMIN_URL=postgresql://postgres@127.0.0.1:5442/postgres \
DR_BACKUP_DIR=… pnpm test:e2e

# The rehearsal on its own, which is what a quarterly test runs.
node scripts/dr-rehearsal.mjs --prepare-destination

# The chain verifier, on a running deployment, through its own lane.
node scripts/dr-verify-chain.mjs

# The P0, probed directly against the real broker before it was fixed.
#   ACCEPTED   outbox dispatcher    outbox:<uuid>:notifications.deliver
#   REFUSED    notification fan-out Custom Id cannot contain :
#   REFUSED    retention fan-out    Custom Id cannot contain :
#   … 8 of 12 shapes refused

# The signed checkpoints, before and after the restore.
#   00000000000000000019.json  eventsVerified 19  (source, walked from genesis)
#   00000000000000000021.json  eventsVerified  2  (restored, resumed from 19)
```

### Gate results

| Gate | Result |
| --- | --- |
| format | clean |
| lint | **0 errors** (7 pre-existing warnings) |
| typecheck | 13/13 |
| unit | web 126 · API 644 (1 skipped) · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| integration | 37 files, **653 passed**, 0 skipped — PostgreSQL 16, two tenant databases, Redis |
| build | 9/9 |
| verify:styles | 10/10 |
| visual | 36 passed |
| **e2e** | **43 passed** — 24 signing/workflows + 19 recovery, real Chromium, two deployments |

Two non-reproducing failures were seen once each under load and did **not** reproduce on re-run:
one preview renderer test (memory contention while two PostgreSQL clusters were live) and the
outbox-dispatch test whose fixed 100 ms sleep Phase 6.8 already recorded. Neither is claimed as flaky
beyond what was observed, and neither was modified.

## 33. Final status

**PARTIALLY COMPLETE.**

The notification production path is VERIFIED end to end with nothing synthetic on it. Disaster
recovery is **PARTIALLY VERIFIED — DATABASE RESTORE VERIFIED; OBJECT STORAGE NOT VERIFIED.**

And the phase found the thing it was not looking for: a product whose entire scheduled half had never
run.

## Evidence vocabulary

**IMPLEMENTED** — the code exists and was read. **VERIFIED** — exercised through its real execution
path and observed. **NOT VERIFIED** — not exercised; no claim made. **FAILED** — exercised and did not
hold. **KNOWN LIMITATION** — true, bounded, and recorded. **FUTURE ENHANCEMENT** — named, not built.

No claim in this report rests on source inspection alone.
