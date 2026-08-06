import type { MetricLabels, Metrics } from '../core/observability/metrics';
import type { CachePort, LockPort, Lease } from '../ports/cache.port';
import type { ClockPort } from '../ports/clock.port';
import type { EnqueuedJob, JobOptions, QueueDepth, QueuePort } from '../ports/queue.port';

/**
 * In-memory doubles for the ports, used by application-layer tests.
 *
 * Every port has one, and that is a rule rather than a convenience: a use case that can only
 * be tested against a real S3 bucket or a real clock will not be tested
 * (`docs/architecture/02-backend-architecture.md` §4).
 */

/** Time that only moves when a test moves it — which is how deadline and retention rules
 *  become assertions instead of waits. */
export class FakeClock implements ClockPort {
  /**
   * Monotonic, fractional, and deliberately nowhere near an epoch.
   *
   * It used to return `current.getTime()`, which made `timestamp()` look like wall-clock
   * milliseconds when the real adapter returns `performance.now()`. Three defects hid behind
   * that — two identifiers generated from a duration, and a health field reporting milliseconds
   * since process start as an epoch — and every one of them passed the suite. A double that is
   * more convenient than the real thing is a double that tests something else.
   */
  private monotonic = 1_234.5;

  constructor(private current: Date = new Date('2026-01-01T00:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  timestamp(): number {
    return this.monotonic;
  }

  elapsedMs(since: number): number {
    return Math.max(0, Math.round(this.monotonic - since));
  }

  advanceBy(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
    this.monotonic += milliseconds;
  }

  set(at: Date): void {
    this.current = new Date(at);
  }
}

export class FakeCache implements CachePort {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly clock: ClockPort = new FakeClock()) {}

  get<TValue>(key: string): Promise<TValue | null> {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.clock.timestamp()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value as TValue);
  }

  set<TValue>(key: string, value: TValue, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.clock.timestamp() + ttlSeconds * 1_000 });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  increment(key: string, ttlSeconds: number): Promise<number> {
    const current = this.entries.get(key);
    const next = typeof current?.value === 'number' ? current.value + 1 : 1;
    this.entries.set(key, {
      value: next,
      expiresAt: current?.expiresAt ?? this.clock.timestamp() + ttlSeconds * 1_000,
    });
    return Promise.resolve(next);
  }

  get size(): number {
    return this.entries.size;
  }
}

export class FakeLock implements LockPort {
  private readonly held = new Set<string>();

  acquire(key: string, ttlSeconds: number): Promise<Lease | null> {
    if (this.held.has(key)) {
      return Promise.resolve(null);
    }
    this.held.add(key);
    return Promise.resolve({
      key,
      token: `fake-${key}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
      release: () => {
        this.held.delete(key);
        return Promise.resolve();
      },
    });
  }
}

/** Records what would have been enqueued, so a test can assert the *intent* to do async work
 *  without running a worker. */
export class RecordingQueue implements QueuePort {
  readonly enqueued: { queue: string; payload: unknown; options: JobOptions }[] = [];
  /** The recurring declarations, so a test can assert a schedule was declared exactly once. */
  readonly scheduled: { queue: string; name: string; cron: string; payload: unknown }[] = [];

  enqueue<TPayload extends object>(
    queue: string,
    payload: TPayload,
    options: JobOptions,
  ): Promise<EnqueuedJob> {
    this.enqueued.push({ queue, payload, options });
    return Promise.resolve({
      queue,
      jobId: options.jobId,
      availableAt: new Date(Date.now() + (options.delayMs ?? 0)),
    });
  }

  cancel(queue: string, jobId: string): Promise<boolean> {
    const index = this.enqueued.findIndex(
      (job) => job.queue === queue && job.options.jobId === jobId,
    );
    if (index === -1) {
      return Promise.resolve(false);
    }
    this.enqueued.splice(index, 1);
    return Promise.resolve(true);
  }

  depth(queue: string): Promise<QueueDepth> {
    return Promise.resolve({
      queue,
      waiting: this.enqueued.filter((job) => job.queue === queue).length,
      active: 0,
      delayed: 0,
      failed: 0,
    });
  }

  schedule<TPayload extends object>(
    queue: string,
    name: string,
    cron: string,
    payload: TPayload,
  ): Promise<void> {
    // Upserted, exactly as the broker does: every instance declares the same schedule and there
    // is one of it, which is the property that replaces a lock around a timer.
    const existing = this.scheduled.findIndex(
      (entry) => entry.queue === queue && entry.name === name,
    );
    const declaration = { queue, name, cron, payload };
    if (existing === -1) {
      this.scheduled.push(declaration);
    } else {
      this.scheduled[existing] = declaration;
    }
    return Promise.resolve();
  }

  unschedule(queue: string, name: string): Promise<void> {
    const index = this.scheduled.findIndex((entry) => entry.queue === queue && entry.name === name);
    if (index !== -1) {
      this.scheduled.splice(index, 1);
    }
    return Promise.resolve();
  }
}

/**
 * Records what was measured, so a test can assert the *signal* without a registry.
 *
 * It deliberately does **not** validate against `METRIC_CATALOGUE`: the catalogue is the exporter's
 * rule and `prometheus-metrics.adapter.spec.ts` is where it is asserted. A double that enforced it
 * too would mean a call site's cardinality mistake failed in two places and was fixed in one.
 */
export class RecordingMetrics implements Metrics {
  readonly recorded: { name: string; kind: string; value: number; labels: MetricLabels }[] = [];

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    this.recorded.push({ name, kind: 'COUNTER', value: by, labels });
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.recorded.push({ name, kind: 'GAUGE', value, labels });
  }

  observe(name: string, valueMs: number, labels: MetricLabels = {}): void {
    this.recorded.push({ name, kind: 'HISTOGRAM', value: valueMs, labels });
  }

  /** Every value recorded under one name, in order. */
  valuesFor(name: string): number[] {
    return this.recorded.filter((entry) => entry.name === name).map((entry) => entry.value);
  }
}
