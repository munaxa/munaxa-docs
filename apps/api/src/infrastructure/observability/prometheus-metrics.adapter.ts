import {
  DURATION_BUCKETS_MS,
  METRIC_CATALOGUE,
  isMetricName,
  type MetricDescriptor,
  type MetricLabels,
  type Metrics,
} from '../../core/observability/metrics';
import type { Logger } from '../../core/observability/logger';

/**
 * An in-process registry, exposed in the Prometheus text format for a scraper to **pull**.
 *
 * ## Why pull, and why that is the whole of the SSRF argument
 *
 * A push exporter is an outbound HTTP request to an address in configuration, and Phase 17 made
 * `OUTBOUND_HTTP_PORT` the only outbound path in the product with an allow-list that is empty by
 * default. A metrics exporter that pushed would either have to go through that boundary — making
 * a deployment's telemetry depend on an operator remembering to allow-list their own collector —
 * or become the second outbound path, which 17 §6 says nothing may add. **A pull exporter makes
 * no outbound request at all**, which is the same argument Phase 17 used for the SIEM `PULL`
 * sink, reached independently here.
 *
 * It is also the shape that does not decide the backend for a customer, which is Phase 0.5's
 * stated reason for leaving the port unbound: the text format is read directly by Prometheus,
 * VictoriaMetrics, Grafana Agent, the OpenTelemetry Collector's `prometheus` receiver, Datadog's
 * OpenMetrics check and every hosted agent worth naming. Choosing OTLP would have chosen one.
 *
 * ## Cardinality is enforced, not requested
 *
 * `METRIC_CATALOGUE` declares each metric's kind and the exact labels it accepts. A name that is
 * not in it, a label that is not in its list, or a label value that is empty is **dropped and
 * logged**, never recorded — because the failure mode of accepting them is a metrics backend that
 * falls over some days later with nothing pointing at the commit that did it.
 *
 * `maxSeries` is the backstop for the case the catalogue cannot see: a label whose set is bounded
 * in principle and large in practice, such as a route table that grows. Past the bound, new series
 * are refused and the existing ones keep updating, so a scrape stays useful rather than
 * unbounded — and `edms_metrics_series_dropped_total` says it happened, because a silently capped
 * registry is one somebody reads as "there is no traffic on that route".
 */

const PREFIX = 'edms';

/** One series: a metric and one combination of label values. */
interface Series {
  readonly descriptor: MetricDescriptor;
  readonly exposedName: string;
  readonly labelText: string;
  value: number;
  /** Histograms only: cumulative counts per bucket, plus the sum and the observation count. */
  buckets?: number[];
  sum?: number;
  count?: number;
}

export interface PrometheusMetricsOptions {
  readonly maxSeries: number;
}

export class PrometheusMetricsAdapter implements Metrics {
  private readonly series = new Map<string, Series>();
  private seriesDropped = 0;
  /** One warning per offending key, so a call site in a loop does not become a log flood. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly options: PrometheusMetricsOptions,
    private readonly logger: Logger,
  ) {}

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    const series = this.resolve(name, labels, 'COUNTER');
    if (series !== null) {
      series.value += by;
    }
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    const series = this.resolve(name, labels, 'GAUGE');
    if (series !== null) {
      series.value = value;
    }
  }

  observe(name: string, valueMs: number, labels: MetricLabels = {}): void {
    const series = this.resolve(name, labels, 'HISTOGRAM');
    if (series === null) {
      return;
    }
    const buckets = series.buckets ?? [];
    for (const [index, bound] of DURATION_BUCKETS_MS.entries()) {
      if (valueMs <= bound) {
        buckets[index] = (buckets[index] ?? 0) + 1;
      }
    }
    series.buckets = buckets;
    series.sum = (series.sum ?? 0) + valueMs;
    series.count = (series.count ?? 0) + 1;
  }

  /**
   * The scrape body.
   *
   * Grouped by exposed name so each `# HELP`/`# TYPE` pair appears once — Prometheus tolerates
   * repeats and every other consumer of the format does not.
   */
  render(): string {
    const grouped = new Map<string, Series[]>();
    for (const series of this.series.values()) {
      const existing = grouped.get(series.exposedName);
      if (existing === undefined) {
        grouped.set(series.exposedName, [series]);
      } else {
        existing.push(series);
      }
    }

    const lines: string[] = [];
    for (const [exposedName, group] of grouped) {
      const [first] = group;
      if (first === undefined) {
        continue;
      }
      lines.push(`# HELP ${exposedName} ${first.descriptor.help}`);
      lines.push(`# TYPE ${exposedName} ${typeKeyword(first.descriptor.kind)}`);
      for (const series of group) {
        lines.push(...renderSeries(exposedName, series));
      }
    }

    lines.push(
      `# HELP ${PREFIX}_metrics_series_dropped_total Series refused by the registry bound.`,
    );
    lines.push(`# TYPE ${PREFIX}_metrics_series_dropped_total counter`);
    lines.push(`${PREFIX}_metrics_series_dropped_total ${String(this.seriesDropped)}`);

    return `${lines.join('\n')}\n`;
  }

  /** How many series are live. Read by the health detail, so an operator can see the bound coming. */
  seriesCount(): number {
    return this.series.size;
  }

  private resolve(
    name: string,
    labels: MetricLabels,
    kind: MetricDescriptor['kind'],
  ): Series | null {
    if (!isMetricName(name)) {
      this.warnOnce(`name:${name}`, 'An undeclared metric name was recorded and dropped', { name });
      return null;
    }
    const descriptor = METRIC_CATALOGUE[name];
    if (descriptor.kind !== kind) {
      this.warnOnce(`kind:${name}`, 'A metric was recorded as the wrong kind and dropped', {
        name,
        declared: descriptor.kind,
        used: kind,
      });
      return null;
    }
    const labelText = this.labelTextFor(name, descriptor, labels);
    if (labelText === null) {
      return null;
    }

    const key = `${name}${labelText}`;
    const existing = this.series.get(key);
    if (existing !== undefined) {
      return existing;
    }
    if (this.series.size >= this.options.maxSeries) {
      this.seriesDropped += 1;
      this.warnOnce('bound', 'The metrics registry reached its series bound', {
        maxSeries: this.options.maxSeries,
      });
      return null;
    }
    const created: Series = {
      descriptor,
      exposedName: exposedNameFor(name, descriptor.kind),
      labelText,
      value: 0,
    };
    this.series.set(key, created);
    return created;
  }

  /**
   * The rendered `{a="1",b="2"}`, or null when the labels break the catalogue's rule.
   *
   * Sorted by name so that two call sites passing the same labels in a different object order
   * produce **one** series rather than two that a query then has to sum.
   */
  private labelTextFor(
    name: string,
    descriptor: MetricDescriptor,
    labels: MetricLabels,
  ): string | null {
    const names = Object.keys(labels).sort();
    for (const label of names) {
      if (!descriptor.labels.includes(label)) {
        this.warnOnce(`label:${name}:${label}`, 'An undeclared metric label was dropped', {
          name,
          label,
          declared: descriptor.labels.join(','),
        });
        return null;
      }
    }
    if (names.length === 0) {
      return '';
    }
    const rendered = names
      .map((label) => `${label}="${escapeLabelValue(labels[label] ?? '')}"`)
      .join(',');
    return `{${rendered}}`;
  }

  private warnOnce(key: string, message: string, context: Record<string, unknown>): void {
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    this.logger.warn(message, context);
  }
}

function typeKeyword(kind: MetricDescriptor['kind']): string {
  switch (kind) {
    case 'COUNTER':
      return 'counter';
    case 'GAUGE':
      return 'gauge';
    case 'HISTOGRAM':
    default:
      return 'histogram';
  }
}

/**
 * `outbox.pending` → `edms_outbox_pending`.
 *
 * Counters gain `_total` and histograms gain `_milliseconds`, which are the format's own
 * conventions rather than decoration: a dashboard built against a counter without `_total` breaks
 * when somebody later adds it, and a duration whose unit is not in its name is one an operator
 * eventually reads as seconds.
 */
function exposedNameFor(name: string, kind: MetricDescriptor['kind']): string {
  const base = `${PREFIX}_${name.replaceAll(/[^a-zA-Z0-9]+/g, '_')}`;
  switch (kind) {
    case 'COUNTER':
      return `${base}_total`;
    case 'HISTOGRAM':
      return `${base}_milliseconds`;
    case 'GAUGE':
    default:
      return base;
  }
}

/** The format escapes exactly three characters inside a label value. */
function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function renderSeries(exposedName: string, series: Series): string[] {
  if (series.descriptor.kind !== 'HISTOGRAM') {
    return [`${exposedName}${series.labelText} ${String(series.value)}`];
  }
  const inner = series.labelText.slice(1, -1);
  const withLe = (bound: string): string =>
    inner === '' ? `{le="${bound}"}` : `{${inner},le="${bound}"}`;

  const lines = DURATION_BUCKETS_MS.map(
    (bound, index) =>
      `${exposedName}_bucket${withLe(String(bound))} ${String(series.buckets?.[index] ?? 0)}`,
  );
  lines.push(`${exposedName}_bucket${withLe('+Inf')} ${String(series.count ?? 0)}`);
  lines.push(`${exposedName}_sum${series.labelText} ${String(series.sum ?? 0)}`);
  lines.push(`${exposedName}_count${series.labelText} ${String(series.count ?? 0)}`);
  return lines;
}
