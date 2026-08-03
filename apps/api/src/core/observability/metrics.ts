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
  QUEUE_DEPTH: 'queue.depth',
  JOB_DURATION: 'job.duration',
  JOB_FAILURES: 'job.failures',
  AUDIT_CHAIN_VERIFIED: 'audit.chain.verified',
  ACCESS_DENIED: 'authorization.denied',
  STORAGE_PRESIGN: 'storage.presign',
} as const;
