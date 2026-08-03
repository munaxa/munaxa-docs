import { Injectable } from '@nestjs/common';

import type { ClockPort } from '../../ports/clock.port';

/**
 * The clock in every environment except tests, where a fixed clock is injected instead.
 *
 * Durations use `performance.now()` rather than `Date.now()`: the wall clock can step
 * backwards over an NTP correction, and a negative duration in a latency metric is a bug
 * report nobody can reproduce.
 */
@Injectable()
export class SystemClockAdapter implements ClockPort {
  now(): Date {
    return new Date();
  }

  timestamp(): number {
    return performance.now();
  }

  elapsedMs(since: number): number {
    return Math.max(0, Math.round(performance.now() - since));
  }
}
