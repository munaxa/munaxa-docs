/**
 * The queues, their retry policies, and what happens when a job finally fails.
 *
 * It lives in the domain package rather than in the worker because Phase 4 gave it a second
 * reader. The API is what *enqueues* — the outbox dispatcher routes a committed event to a lane,
 * and the engine schedules a delayed deadline job — while the worker is what consumes. A queue
 * name known to only one of them is a message nothing receives, and a cross-application import
 * would be the coupling the boundary rules exist to prevent. It is pure data, which is what makes
 * it belong here.
 *
 * Lanes are separated by *cost*, not by module: OCR is slow and would otherwise starve
 * preview rendering behind it, and a retention run that takes an hour must not delay a
 * notification a user is waiting for (`docs/architecture/02-backend-architecture.md` §8).
 *
 * Failure policy, uniformly: exponential backoff, a capped number of attempts, then the dead
 * letter queue with an operator-visible reason. A job that fails permanently raises an alert
 * and never silently drops the work.
 */
export const QueueName = {
  DOCUMENTS_PREVIEW: 'documents.preview',
  DOCUMENTS_OCR: 'documents.ocr',
  SEARCH_INDEX: 'search.index',
  WORKFLOW_TIMERS: 'workflow.timers',
  NOTIFICATIONS_DELIVER: 'notifications.deliver',
  RETENTION_RUN: 'retention.run',
  IDENTITY_DELEGATION: 'identity.delegation',
  AUDIT_EXPORT: 'audit.export',
  REPORTING_EXPORT: 'reporting.export',
  DOCUMENTS_BULK: 'documents.bulk',
  WEBHOOKS_DELIVER: 'webhooks.deliver',
  AUDIT_STREAM: 'audit.stream',
  OUTBOX_DISPATCH: 'outbox.dispatch',
} as const;

export type QueueNameKey = (typeof QueueName)[keyof typeof QueueName];

export interface RetryPolicy {
  readonly attempts: number;
  readonly backoffMs: number;
  readonly backoff: 'exponential' | 'fixed';
}

export interface QueueDefinition {
  readonly name: QueueNameKey;
  /** How many jobs this lane runs at once. Bounded by what the work costs, not by hope. */
  readonly concurrency: number;
  /**
   * How many of one *tenant's* jobs may occupy this lane at once — Phase 16.
   *
   * `concurrency` above is per lane, which is what made
   * `19-performance-and-scalability.md` §5's fairness sentence false for fifteen phases: a tenant
   * with five thousand jobs takes every slot and every other tenant waits behind them. Nothing had
   * ever produced five thousand jobs, so nobody could have observed it.
   *
   * Declared per lane and **absent by default**, which keeps every existing lane byte-for-byte as
   * it behaved: a lane that does not name a cap is not capped, and adding one to `documents.ocr`
   * later is a one-line change here rather than a change to the adapter. Enforcement is the
   * adapter's — a slot is taken in Redis before the handler runs and released after, and a job
   * that finds the tenant at its cap is re-queued with a short delay rather than failed, because
   * "wait your turn" is not a failure and must not consume an attempt.
   *
   * The number here is the product's floor; a tenant setting (`bulk.tenantConcurrency`) raises or
   * lowers it per deployment, and the adapter takes the lower of the two.
   */
  readonly perTenantConcurrency?: number;
  readonly retry: RetryPolicy;
  /** Wall-clock budget for one job; a renderer that hangs must not hold a slot forever. */
  readonly timeoutMs: number;
  readonly description: string;
}

export const DEAD_LETTER_SUFFIX = '.dead' as const;

export function deadLetterQueueFor(queue: QueueNameKey): string {
  return `${queue}${DEAD_LETTER_SUFFIX}`;
}

export const QUEUES: readonly QueueDefinition[] = Object.freeze([
  {
    name: QueueName.OUTBOX_DISPATCH,
    concurrency: 1,
    retry: { attempts: 10, backoffMs: 1_000, backoff: 'exponential' },
    timeoutMs: 30_000,
    description:
      'Claims committed outbox rows and enqueues them. Single consumer per instance; rows are claimed FOR UPDATE SKIP LOCKED so instances never collide.',
  },
  {
    name: QueueName.DOCUMENTS_PREVIEW,
    concurrency: 4,
    retry: { attempts: 3, backoffMs: 5_000, backoff: 'exponential' },
    timeoutMs: 120_000,
    description: 'Renders preview pages and thumbnails in a sandbox with CPU and memory caps.',
  },
  {
    name: QueueName.DOCUMENTS_OCR,
    concurrency: 2,
    retry: { attempts: 2, backoffMs: 30_000, backoff: 'exponential' },
    timeoutMs: 600_000,
    description: 'The slow lane. Separate concurrency so OCR cannot starve preview rendering.',
  },
  {
    name: QueueName.SEARCH_INDEX,
    concurrency: 8,
    retry: { attempts: 5, backoffMs: 2_000, backoff: 'exponential' },
    timeoutMs: 60_000,
    description: 'Projects a document into the index. Coalesced per document; safe to re-run.',
  },
  {
    name: QueueName.WORKFLOW_TIMERS,
    concurrency: 4,
    retry: { attempts: 5, backoffMs: 10_000, backoff: 'exponential' },
    timeoutMs: 30_000,
    description:
      'Deadlines, reminders and escalations, as delayed jobs — which is why the engine needs no polling.',
  },
  {
    name: QueueName.NOTIFICATIONS_DELIVER,
    concurrency: 8,
    retry: { attempts: 5, backoffMs: 15_000, backoff: 'exponential' },
    timeoutMs: 30_000,
    description: 'Email and in-app fan-out. A permanent provider failure is not retried.',
  },
  {
    name: QueueName.RETENTION_RUN,
    concurrency: 1,
    retry: { attempts: 2, backoffMs: 60_000, backoff: 'fixed' },
    timeoutMs: 900_000,
    description:
      'Disposition review and purge, tenant-partitioned. Single consumer: destruction is never run concurrently with itself.',
  },
  {
    name: QueueName.IDENTITY_DELEGATION,
    concurrency: 1,
    retry: { attempts: 3, backoffMs: 60_000, backoff: 'fixed' },
    timeoutMs: 120_000,
    description:
      'Records delegations whose end date has passed. A lane of its own because one BullMQ worker consumes one lane: a second subscriber on `retention.run` would race its consumer for that lane’s jobs.',
  },
  {
    name: QueueName.AUDIT_EXPORT,
    concurrency: 2,
    retry: { attempts: 3, backoffMs: 30_000, backoff: 'exponential' },
    timeoutMs: 900_000,
    description: 'Evidence bundles, streamed to storage rather than held in memory.',
  },
  {
    /**
     * Report exports — Phase 15, and a lane of its own rather than a second workload on
     * `audit.export`.
     *
     * The two are similar in shape and different in every property a lane is separated by
     * (§8: *by cost, not by module*). An evidence bundle reads one table by sequence with no
     * permission predicate, because `audit:export` is the filter; a report export runs the
     * *caller's own* query — joins, an ACL predicate, a page at a time — for as many pages as the
     * row cap allows. Putting them on one lane at concurrency 2 would let a tenant's month-end
     * batch of reports sit in front of the nightly chain verification, which is the one job in the
     * product whose lateness is itself a compliance finding.
     *
     * Concurrency 2 for the same reason `audit.export` has it: an export is bounded by rows rather
     * than by milliseconds, and a single consumer would make the second requester wait for the
     * first's whole range.
     */
    name: QueueName.REPORTING_EXPORT,
    concurrency: 2,
    retry: { attempts: 3, backoffMs: 30_000, backoff: 'exponential' },
    timeoutMs: 900_000,
    description:
      'Report exports, streamed to storage a page at a time under the requester’s own reach.',
  },
  {
    /**
     * Bulk document operations — Phase 16, and the first lane in the product that one tenant can
     * genuinely flood.
     *
     * Separated by cost like every other lane (§8), and its cost is unusual: a bulk operation is
     * *N transactions*, each writing an audit row onto a chain that serialises per tenant under an
     * advisory lock. So the expensive resource is not CPU and not the renderer pool — it is one
     * tenant's own chain, and a second tenant's bulk restore does not contend with it at all. That
     * is exactly the shape a per-lane concurrency number cannot express, and it is why this is the
     * lane that declares `perTenantConcurrency`.
     *
     * Concurrency 4 with a per-tenant cap of 2: four tenants' imports proceed together, and no
     * single tenant takes more than half the lane however many operations they queue. A bulk
     * export also runs here — it moves *bytes* rather than rows, which is a different cost, and
     * the report argues why it is nonetheless the same lane rather than a fourth export mechanism.
     */
    name: QueueName.DOCUMENTS_BULK,
    concurrency: 4,
    perTenantConcurrency: 2,
    retry: { attempts: 3, backoffMs: 30_000, backoff: 'exponential' },
    timeoutMs: 900_000,
    description:
      'Bulk document operations, one transaction per object, under the requester’s own reach.',
  },
  {
    /**
     * Outbound webhooks — Phase 17, and the first lane in the product whose work is an HTTP
     * request to **somebody else's server**.
     *
     * That is what separates it by cost (§8), and it is not the usual kind of cost. Every other
     * lane's slowest job is bounded by something this deployment controls: a renderer's CPU cap, a
     * query's row limit, a transaction's statement timeout. A webhook's is bounded by a receiver
     * who may accept the connection and never answer — which is why `webhook.timeoutSeconds` is a
     * setting with a low default and why the concurrency here is high relative to the work: the
     * slots are spent waiting, not computing.
     *
     * `perTenantConcurrency` of 4 against a lane of 12. A tenant with eight endpoints subscribed
     * to everything produces eight deliveries per event, and one such tenant during a bulk import
     * would otherwise be every slot in the lane while everybody else's approval notifications
     * wait behind a stranger's unresponsive URL. This is the second lane to declare a cap, and the
     * first where the contended resource is *latency somebody else controls* rather than a
     * database.
     *
     * Retries are **not** BullMQ's. `attempts: 1` here, and the delivery record carries its own
     * attempt count and `nextAttemptAt` — because a webhook's retry schedule is a tenant setting,
     * has to survive a worker restart, and has to be visible to the administrator whose endpoint
     * is failing. A lane-level retry would be a second, invisible schedule with different numbers.
     */
    name: QueueName.WEBHOOKS_DELIVER,
    concurrency: 12,
    perTenantConcurrency: 4,
    retry: { attempts: 1, backoffMs: 0, backoff: 'fixed' },
    timeoutMs: 120_000,
    description:
      'Outbound webhook deliveries, signed and retried on the delivery record’s own schedule.',
  },
  {
    /**
     * The push half of 13 §6's SIEM sink — Phase 17.
     *
     * A lane of its own rather than a second workload on `webhooks.deliver`, and the reason is the
     * cursor. A webhook delivery is one event to one endpoint and is independent of every other; a
     * sink push is a *contiguous range* of one tenant's hash chain, and the next push may not
     * start until the last one's cursor has advanced. Two concurrent pushes for one tenant would
     * either send the same range twice or advance the cursor past events nobody sent — and the
     * gap-free sequence, which is the whole reason a SIEM can trust this stream, would stop being
     * a guarantee this end can make.
     *
     * So concurrency 2 across tenants with a per-tenant cap of 1: two customers' sinks proceed
     * together and one customer's sink is strictly serial with itself.
     */
    name: QueueName.AUDIT_STREAM,
    concurrency: 2,
    perTenantConcurrency: 1,
    retry: { attempts: 3, backoffMs: 60_000, backoff: 'exponential' },
    timeoutMs: 300_000,
    description:
      'Pushes a contiguous range of the audit chain to a tenant’s collector, strictly serial per tenant.',
  },
]);

export function queueDefinition(name: QueueNameKey): QueueDefinition {
  const definition = QUEUES.find((queue) => queue.name === name);
  if (!definition) {
    throw new Error(`Queue ${name} has no definition.`);
  }
  return definition;
}

/**
 * Recurring work, expressed as data.
 *
 * Each entry is claimed under a distributed lock before it runs, so several worker instances
 * on the same schedule produce one run rather than three.
 */
export interface ScheduledJob {
  readonly name: string;
  readonly queue: QueueNameKey;
  readonly cron: string;
  readonly lockKey: string;
  readonly description: string;
}

export const SCHEDULE: readonly ScheduledJob[] = Object.freeze([
  {
    name: 'retention.sweep',
    queue: QueueName.RETENTION_RUN,
    cron: '0 2 * * *',
    lockKey: 'schedule:retention.sweep',
    description: 'Finds schedules due for review or disposition.',
  },
  {
    name: 'audit.verify-chain',
    queue: QueueName.AUDIT_EXPORT,
    cron: '30 1 * * *',
    lockKey: 'schedule:audit.verify-chain',
    description: 'Daily hash-chain verification; a break is the highest-severity alert.',
  },
  {
    /**
     * Records the delegations whose end date has passed — and records only.
     *
     * A delegation is expired by a **predicate**, not by this job: the authority check asks
     * whether the period covers the instant, so a delegation past its end date authorises nothing
     * from the millisecond it passes, whether or not anything ran. That is deliberate and it is
     * the reason this entry can be a plain nightly sweep rather than a per-delegation timer.
     *
     * It exists anyway because `DELEGATION_EXPIRED` is in `13-audit-architecture.md` §2 and an
     * audit action has to be written by something. Lazily writing it when somebody next looks
     * would date the event to whenever that was — and for a delegation nobody looks at again, to
     * never, which makes "every delegation that ended last quarter" a question the trail answers
     * wrongly.
     */
    name: 'identity.expire-delegations',
    queue: QueueName.IDENTITY_DELEGATION,
    cron: '10 1 * * *',
    lockKey: 'schedule:identity.expire-delegations',
    description: 'Records delegations whose period has ended; never what makes them inert.',
  },
  {
    /**
     * The rolling integrity verifier — Phase 18, `17-security-architecture.md` §8.
     *
     * On `retention.run` rather than a lane of its own, and that is the decision worth recording:
     * a new lane would need a concurrency, a retry policy, a dead-letter queue and a consumer, for
     * work whose shape is identical to the sweep already on this lane — off-peak, serialised per
     * tenant, bounded per pass, and safe to miss because the next one picks up where the ordering
     * left it. Sharing the lane also means the two cannot run at once in one tenant, which is what
     * keeps a night's reads against the object store bounded by one pass rather than two.
     *
     * Three in the morning: after the audit chain's own verification at 01:30, so an operator
     * reading the night's alerts sees the trail's verdict before the storage layer's.
     */
    name: 'storage.verify-integrity',
    queue: QueueName.RETENTION_RUN,
    cron: '0 3 * * *',
    lockKey: 'schedule:storage.verify-integrity',
    description: 'Re-reads stored blobs and re-hashes them; a mismatch quarantines and alerts.',
  },
  {
    name: 'storage.sweep-upload-sessions',
    queue: QueueName.RETENTION_RUN,
    cron: '*/15 * * * *',
    lockKey: 'schedule:storage.sweep-upload-sessions',
    description: 'Expires abandoned upload sessions and their partial objects.',
  },
  {
    /**
     * The only thing that watches `effective_to` — Phase 6.1.
     *
     * `06-document-lifecycle.md` allowed `PUBLISHED → EXPIRED` from Phase 0 and nothing performed
     * it, so a document could carry an expiry date that never arrived. This is what makes the
     * state reachable, and it is a *sweep* rather than a timer per document for the reason
     * `notifications.deliver` gives: five thousand delayed jobs discovering that midnight has
     * passed is five thousand schedules where one belongs, and a delayed job lives in Redis while
     * a controlled document's expiry must survive a broker restart.
     *
     * On `retention.run` rather than a lane of its own, which is `storage.verify-integrity`'s
     * decision applied a second time and for the same reasons: the work is off-peak, bounded per
     * pass, serialised per tenant, safe to miss because the next pass picks it up, and identical
     * in shape to the sweep already on this lane. It also has to be here — the queue adapter
     * builds one worker per `subscribe`, so a second subscriber on `retention.run` would race
     * `RetentionLaneConsumer` for that lane's jobs, which is the defect that gave delegation a
     * lane of its own.
     *
     * **Hourly rather than nightly, and that is the timezone answer.** Expiry is a calendar-day
     * boundary in the *tenant's* zone (`locale.timezone`), the deployment serves tenants in many,
     * and a single nightly firing would be after midnight for some and hours before it for others.
     * Each pass asks each tenant whether its own day has turned, so the answer is right everywhere
     * and the sweep is a no-op in the twenty-three hours it has nothing to do. It is the same
     * shape, and the same reasoning, as `notifications.digest-daily`'s hourly cron.
     */
    name: 'documents.expire-effective',
    queue: QueueName.RETENTION_RUN,
    cron: '20 * * * *',
    lockKey: 'schedule:documents.expire-effective',
    description:
      'Expires published documents whose effective window has closed, in the tenant’s own timezone.',
  },
  {
    /**
     * Drains what `NotificationService` queued.
     *
     * A schedule rather than a delayed job per message, because delivery is a *batch* property:
     * a provider is either reachable or it is not, and fifty delayed jobs discovering that
     * separately is fifty backoff curves where one belongs. Every minute is the shortest cron
     * expresses, and it is the added latency an email inherits — acceptable for mail, and
     * irrelevant to in-app, which is delivered by being written and never reaches this lane.
     */
    name: 'notifications.deliver',
    queue: QueueName.NOTIFICATIONS_DELIVER,
    cron: '* * * * *',
    lockKey: 'schedule:notifications.deliver',
    description: 'Sends queued email, and releases whatever quiet hours were holding.',
  },
  {
    name: 'notifications.digest-hourly',
    queue: QueueName.NOTIFICATIONS_DELIVER,
    cron: '5 * * * *',
    lockKey: 'schedule:notifications.digest-hourly',
    description: 'Collects an hour of held messages per recipient into one summary.',
  },
  {
    /**
     * The daily and weekly digests fire in the morning rather than at midnight.
     *
     * A digest exists to be *read*, and one delivered at 02:00 competes with everything that
     * arrived overnight. The hour is the tenant's, resolved through `locale.timezone` — the cron
     * fires the fan-out and each tenant's pass decides whether its own morning has arrived.
     */
    name: 'notifications.digest-daily',
    queue: QueueName.NOTIFICATIONS_DELIVER,
    cron: '0 * * * *',
    lockKey: 'schedule:notifications.digest-daily',
    description: 'Collects a day of held messages per recipient, at the tenant’s own morning.',
  },
  {
    name: 'notifications.digest-weekly',
    queue: QueueName.NOTIFICATIONS_DELIVER,
    cron: '0 * * * *',
    lockKey: 'schedule:notifications.digest-weekly',
    description: 'Collects a week of held messages per recipient, at the tenant’s own Monday.',
  },
  {
    /**
     * Closes coalescing windows.
     *
     * 18 §7's last row — "bulk operations emit one summary notification, never one per object" —
     * needs something to decide the window has ended, and it cannot be the events themselves: the
     * five-hundredth is indistinguishable from the first while it is arriving.
     */
    name: 'notifications.release-batches',
    queue: QueueName.NOTIFICATIONS_DELIVER,
    cron: '*/5 * * * *',
    lockKey: 'schedule:notifications.release-batches',
    description: 'Emits one summary per closed coalescing window, and discards the window.',
  },
  {
    /**
     * Retries the webhook deliveries whose backoff has elapsed — Phase 17.
     *
     * A schedule rather than a delayed job per delivery, and the reasoning is `notifications.deliver`'s
     * exactly: a receiver is either reachable or it is not, and five hundred delayed jobs
     * discovering that separately is five hundred backoff curves where one sweep belongs. It is
     * also what makes a retry survive a worker restart — a delayed job lives in Redis, and a
     * delivery that must not be lost cannot depend on that.
     *
     * The first attempt does **not** come from here. It is enqueued by the outbox dispatcher the
     * instant the event is routed, so an ordinary delivery is not waiting up to a minute for a
     * sweep; this lane is only for the ones that failed.
     */
    name: 'webhooks.retry-due',
    queue: QueueName.WEBHOOKS_DELIVER,
    cron: '* * * * *',
    lockKey: 'schedule:webhooks.retry-due',
    description:
      'Re-attempts webhook deliveries whose backoff has elapsed, and dead-letters the spent.',
  },
  {
    /**
     * Advances each tenant's audit sink cursor — Phase 17, and 13 §6's push half.
     *
     * Every minute rather than on each audit write, because a sink is a *stream* rather than a
     * reaction: batching a minute of the chain into one request is what makes the range
     * contiguous, and a per-event push would post one HTTP request per document view.
     *
     * Only the `PUSH` sinks run here. A `PULL` sink is a cursor the customer's collector polls and
     * costs this deployment nothing at all until they call.
     */
    name: 'audit.stream-sinks',
    queue: QueueName.AUDIT_STREAM,
    cron: '* * * * *',
    lockKey: 'schedule:audit.stream-sinks',
    description: 'Pushes each tenant’s new audit events to its collector, from the stored cursor.',
  },
]);
