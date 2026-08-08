/**
 * Application metrics, as a port.
 *
 * Named here rather than bound to a client library because what a deployment scrapes —
 * Prometheus, OTLP, a hosted agent — is an operational choice that must not reach into use
 * cases (`docs/architecture/20-deployment-architecture.md`).
 *
 * The label rule matters more than the interface: labels are bounded sets — queue name,
 * status, driver. A tenant id or a document id as a label is an unbounded cardinality
 * explosion that will take the metrics backend down.
 *
 * ## Phase 18 — the rule became a catalogue, and the catalogue is enforced
 *
 * Phase 0.5 wrote the rule above as a comment and bound the port to nothing, which is the state
 * `grep -rn "provide: METRICS"` found for seventeen phases. Binding it raised the question the
 * comment could not answer on its own: **who checks it?** A `Metrics` implementation that accepts
 * whatever labels it is handed makes the rule a convention, and a convention about cardinality is
 * one somebody breaks during an incident by adding the tenant id that would have told them which
 * customer it was.
 *
 * So each name below declares its kind and **the exact label names it accepts**, and the adapter
 * refuses anything else rather than recording it. The consequence is deliberate: a call site that
 * invents a label sees its metric dropped and a warning, instead of a metrics backend that falls
 * over a week later with no obvious cause. The catalogue is also what a dashboard is built from,
 * which is why `help` is here rather than in a Grafana JSON nobody has.
 */
export const METRICS = Symbol('Metrics');

export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: string, labels?: MetricLabels, by?: number): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  /** Duration in milliseconds; the backend decides the bucketing. */
  observe(name: string, valueMs: number, labels?: MetricLabels): void;
}

/** The metric names the platform team alerts on; kept in one place so they cannot drift. */
export const MetricName = {
  HTTP_REQUEST_DURATION: 'http.request.duration',
  MESSAGE_DURATION: 'message.duration',
  OUTBOX_PENDING: 'outbox.pending',
  OUTBOX_DISPATCH_FAILURES: 'outbox.dispatch.failures',
  NOTIFICATION_DELIVERY_FAILURES: 'notification.delivery.failures',
  QUEUE_DEPTH: 'queue.depth',
  JOB_DURATION: 'job.duration',
  JOB_FAILURES: 'job.failures',
  AUDIT_CHAIN_VERIFIED: 'audit.chain.verified',
  ACCESS_DENIED: 'authorization.denied',
  STORAGE_PRESIGN: 'storage.presign',
} as const;

export type MetricNameKey = (typeof MetricName)[keyof typeof MetricName];

export type MetricKind = 'COUNTER' | 'GAUGE' | 'HISTOGRAM';

export interface MetricDescriptor {
  readonly kind: MetricKind;
  /**
   * The only label names this metric accepts.
   *
   * Every one of them is a bounded set drawn from something declared in code — a lane name from
   * `@edms/domain`'s queue catalogue, a route template from the router, an HTTP status *class*,
   * an outcome. None of them is a value a request carries, which is the property that keeps the
   * series count bounded by the deployment's shape rather than by its traffic.
   */
  readonly labels: readonly string[];
  readonly help: string;
}

/**
 * Millisecond buckets, shared by every histogram here.
 *
 * Chosen against 19 §1's own p95 and p99 targets rather than a library default: the interesting
 * boundaries for this product are 200 ms (a folder listing), 800 ms (a filtered search) and 1.5 s
 * (its p99), and a bucket set that steps straight from 500 ms to 5 s cannot answer whether either
 * target was met. Background jobs share the set and simply spend their time in the tail, which is
 * cheaper than a second bucket set and a second decision about which metrics use which.
 */
export const DURATION_BUCKETS_MS = Object.freeze([
  5, 10, 25, 50, 100, 200, 300, 500, 800, 1_500, 3_000, 5_000, 15_000, 60_000,
]);

export const METRIC_CATALOGUE: Readonly<Record<MetricNameKey, MetricDescriptor>> = Object.freeze({
  [MetricName.HTTP_REQUEST_DURATION]: {
    kind: 'HISTOGRAM',
    // The route *template* (`/documents/:id`), never the path: a path label is the document id
    // wearing a different name, and it is the single most likely way this rule gets broken.
    labels: ['method', 'route', 'status'],
    help: 'Request duration in milliseconds, by route template and status class.',
  },
  [MetricName.MESSAGE_DURATION]: {
    kind: 'HISTOGRAM',
    labels: ['message', 'kind', 'outcome'],
    help: 'Command and query handling duration in milliseconds, by message name.',
  },
  [MetricName.OUTBOX_PENDING]: {
    kind: 'GAUGE',
    labels: [],
    help: 'Outbox rows claimed but not yet dispatched, as of the last dispatcher pass.',
  },
  [MetricName.OUTBOX_DISPATCH_FAILURES]: {
    kind: 'COUNTER',
    labels: ['reason'],
    help: 'Outbox rows the dispatcher could not enqueue.',
  },
  /**
   * 18 §7's "dead-letter queue with operator visibility", at the level this product provides it
   * elsewhere — Phase 6.4.
   *
   * `outcome` separates a blip from a loss: `retrying` is a send that will be attempted again and
   * is expected to be noisy during a provider incident, `terminal` is a message that has spent its
   * attempts and will never reach anybody. Alerting belongs on the second. Both labels are bounded
   * — two outcomes, and the channel catalogue — so the series count cannot grow with traffic.
   */
  [MetricName.NOTIFICATION_DELIVERY_FAILURES]: {
    kind: 'COUNTER',
    labels: ['channel', 'outcome'],
    help: 'Notification sends that failed, split by whether they will be retried.',
  },
  [MetricName.QUEUE_DEPTH]: {
    kind: 'GAUGE',
    labels: ['queue', 'state'],
    help: 'Jobs on each lane, by state — waiting, active, delayed or failed.',
  },
  [MetricName.JOB_DURATION]: {
    kind: 'HISTOGRAM',
    labels: ['queue', 'outcome'],
    help: 'Background job duration in milliseconds, by lane.',
  },
  [MetricName.JOB_FAILURES]: {
    kind: 'COUNTER',
    labels: ['queue', 'exhausted'],
    help: 'Background job failures, and whether the job had attempts left.',
  },
  [MetricName.AUDIT_CHAIN_VERIFIED]: {
    kind: 'COUNTER',
    // `intact` rather than a tenant: 17 §9 pages on a break, and which tenant broke is a question
    // for the alert's payload and the trail, not for a label that multiplies by customer count.
    labels: ['intact'],
    help: 'Audit events walked by the verification pass, and whether the chain held.',
  },
  [MetricName.ACCESS_DENIED]: {
    kind: 'COUNTER',
    labels: ['permission', 'reason'],
    help: 'Authorisation refusals, by permission and by the resolver’s reason.',
  },
  [MetricName.STORAGE_PRESIGN]: {
    kind: 'COUNTER',
    labels: ['operation', 'driver'],
    help: 'Signed storage URLs issued, by operation and storage driver.',
  },
});

/** Whether a name is one the catalogue declares. */
export function isMetricName(name: string): name is MetricNameKey {
  return Object.hasOwn(METRIC_CATALOGUE, name);
}

/**
 * The HTTP status *class*, as a label value.
 *
 * `2xx`, `4xx`, `5xx` rather than the code, because the code is a set of forty and the class is a
 * set of five — and no alert in 17 §9 or 20 §5 distinguishes a 403 from a 404 at the metric level.
 * The distinction that matters lives in the audit trail, where a refusal is a row.
 */
export function statusClass(status: number): string {
  return `${String(Math.floor(status / 100))}xx`;
}
