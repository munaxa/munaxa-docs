import { Injectable } from '@nestjs/common';

import type { DocsLimitKey } from '@edms/domain';

/**
 * One metered quantity, measured by the module that owns its rows — ADR-0026.
 *
 * `measure` runs inside the tenant's unit of work, so it reads through the same row-level security
 * as a request does, and it must count exactly what that module's `enforceLimit` call counts: the
 * central service shows the level beside the plan's ceiling, and two definitions of "users" would
 * make the one an operator sees disagree with the one the product enforces.
 */
export interface UsageMeter {
  readonly metric: DocsLimitKey;
  measure(): Promise<number>;
}

/**
 * Where modules register their meters, so the reporter in core never imports a module. A metric
 * registered twice is a wiring mistake, refused at boot rather than reported twice.
 */
@Injectable()
export class UsageMeters {
  private readonly meters = new Map<string, UsageMeter>();

  register(meter: UsageMeter): UsageMeter {
    if (this.meters.has(meter.metric)) {
      throw new Error(`Two usage meters registered for ${meter.metric}.`);
    }
    this.meters.set(meter.metric, meter);
    return meter;
  }

  all(): readonly UsageMeter[] {
    return [...this.meters.values()];
  }
}
