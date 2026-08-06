import { Injectable } from '@nestjs/common';

import type { Metrics } from '../../core/observability/metrics';

/**
 * `METRICS_DRIVER=NONE`, and the reason it is a no-op rather than a refusal.
 *
 * Every other unbound port in this product is bound to an adapter that *fails* naming the
 * environment variable that would configure it — storage, OCR, antivirus, mail. That posture is
 * right for all four and wrong for this one, and the difference is what the absence costs.
 * A deployment with no storage driver cannot store a document, so failing loudly at the first
 * upload is the honest answer. A deployment with no metrics driver works perfectly; it is simply
 * not observed. Turning that into an exception would mean every call site needs a `try`, or
 * `MetricsBehavior` takes down the request it was measuring — telemetry failing the work it
 * watches is the classic way an observability layer becomes the outage.
 *
 * So `NONE` is the default and it costs a method call that returns. It is also what CI runs
 * under, which is deliberate: a suite whose assertions depended on a metrics registry would be a
 * suite asserting the exporter rather than the product.
 */
@Injectable()
export class NoOpMetricsAdapter implements Metrics {
  increment(): void {
    // Nothing, on purpose. See above.
  }

  gauge(): void {
    // Nothing, on purpose.
  }

  observe(): void {
    // Nothing, on purpose.
  }
}
