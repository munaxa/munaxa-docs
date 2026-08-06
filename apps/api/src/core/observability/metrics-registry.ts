import type { Metrics } from './metrics';

/**
 * The bound `Metrics`, when it is one a scraper can read.
 *
 * A second token rather than a second method on `Metrics`, because *recording* and *exposing* have
 * different holders: everything in the product records, and exactly one controller exposes. A
 * `render()` on the port would put "produce the whole scrape body" within reach of every use case
 * that increments a counter.
 *
 * Null under `METRICS_DRIVER=NONE`, which is what makes `/metrics` answer `404` rather than an
 * empty body — an empty scrape is indistinguishable from a deployment with no traffic.
 */
export const METRICS_REGISTRY = Symbol('MetricsRegistry');

export interface MetricsRegistry extends Metrics {
  /** The Prometheus text exposition for everything recorded so far. */
  render(): string;
  seriesCount(): number;
}
