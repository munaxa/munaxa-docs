import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../core/observability/logger';
import { MetricName } from '../../core/observability/metrics';
import { PrometheusMetricsAdapter } from './prometheus-metrics.adapter';

const warn = vi.fn();
const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

function adapter(maxSeries = 100): PrometheusMetricsAdapter {
  return new PrometheusMetricsAdapter({ maxSeries }, logger);
}

beforeEach(() => {
  warn.mockClear();
});

describe('the Prometheus registry', () => {
  it('exposes a counter with the format’s own suffix', () => {
    const metrics = adapter();
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'document:view', reason: 'DENY' });
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'document:view', reason: 'DENY' });

    expect(metrics.render()).toContain(
      'edms_authorization_denied_total{permission="document:view",reason="DENY"} 2',
    );
  });

  it('renders one HELP and one TYPE per metric, whatever the label combinations', () => {
    const metrics = adapter();
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'a', reason: 'DENY' });
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'b', reason: 'STATE' });

    const body = metrics.render();

    expect(body.match(/# TYPE edms_authorization_denied_total/g)).toHaveLength(1);
  });

  it('sorts label names, so the same labels in a different order are one series', () => {
    const metrics = adapter();
    metrics.increment(MetricName.ACCESS_DENIED, { reason: 'DENY', permission: 'document:view' });
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'document:view', reason: 'DENY' });

    expect(metrics.seriesCount()).toBe(1);
  });

  it('renders a histogram as cumulative buckets, a sum and a count', () => {
    const metrics = adapter();
    metrics.observe(MetricName.HTTP_REQUEST_DURATION, 30, {
      method: 'GET',
      route: '/documents',
      status: '2xx',
    });

    const body = metrics.render();

    expect(body).toContain(
      '_milliseconds_bucket{method="GET",route="/documents",status="2xx",le="25"} 0',
    );
    expect(body).toContain(
      '_milliseconds_bucket{method="GET",route="/documents",status="2xx",le="50"} 1',
    );
    expect(body).toContain(
      '_milliseconds_bucket{method="GET",route="/documents",status="2xx",le="+Inf"} 1',
    );
    expect(body).toContain('_milliseconds_sum{method="GET",route="/documents",status="2xx"} 30');
    expect(body).toContain('_milliseconds_count{method="GET",route="/documents",status="2xx"} 1');
  });

  it('renders a bucketless histogram’s `le` without a stray comma', () => {
    // The one place the label rendering can produce a syntactically invalid exposition, and it is
    // reachable: every histogram with no labels goes through it.
    const metrics = adapter();
    metrics.observe(MetricName.MESSAGE_DURATION, 5, {});

    expect(metrics.render()).toContain('_milliseconds_bucket{le="5"} 1');
  });

  // --- The cardinality rule, which is the reason this adapter exists rather than a library ----

  it('drops an undeclared metric name rather than recording it', () => {
    const metrics = adapter();
    metrics.increment('documents.per.tenant', { tenant: 'acme' });

    expect(metrics.seriesCount()).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('drops an undeclared label — the tenant id that would explode the backend', () => {
    const metrics = adapter();
    metrics.increment(MetricName.ACCESS_DENIED, {
      permission: 'document:view',
      reason: 'DENY',
      tenantId: '019489f0-0000-7000-8000-0000000000a1',
    });

    expect(metrics.seriesCount()).toBe(0);
    expect(metrics.render()).not.toContain('019489f0');
  });

  it('drops a metric recorded as the wrong kind', () => {
    const metrics = adapter();
    metrics.gauge(MetricName.ACCESS_DENIED, 1, { permission: 'a', reason: 'b' });

    expect(metrics.seriesCount()).toBe(0);
  });

  it('warns once per offending key rather than once per call', () => {
    const metrics = adapter();
    for (let index = 0; index < 50; index += 1) {
      metrics.increment('not.declared');
    }

    expect(warn).toHaveBeenCalledOnce();
  });

  it('refuses new series past the bound and keeps updating the ones it has', () => {
    const metrics = adapter(2);
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'a', reason: 'x' });
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'b', reason: 'x' });
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'c', reason: 'x' });
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'a', reason: 'x' });

    expect(metrics.seriesCount()).toBe(2);
    expect(metrics.render()).toContain(
      'edms_authorization_denied_total{permission="a",reason="x"} 2',
    );
  });

  it('says how many series it refused, rather than capping silently', () => {
    const metrics = adapter(1);
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'a', reason: 'x' });
    metrics.increment(MetricName.ACCESS_DENIED, { permission: 'b', reason: 'x' });

    expect(metrics.render()).toContain('edms_metrics_series_dropped_total 1');
  });

  it('escapes a label value that would otherwise break the exposition', () => {
    const metrics = adapter();
    metrics.increment(MetricName.OUTBOX_DISPATCH_FAILURES, { reason: 'said "no"\nand left' });

    expect(metrics.render()).toContain('reason="said \\"no\\"\\nand left"');
  });
});
