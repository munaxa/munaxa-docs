/**
 * Time, as a dependency.
 *
 * Retention dates, approval deadlines, escalation timers, token expiry and signed-URL
 * lifetimes are all arithmetic on "now". Injecting it makes every one of those rules
 * testable without waiting, and without a global mock that leaks between tests.
 */
export const CLOCK_PORT = Symbol('ClockPort');

export interface ClockPort {
  now(): Date;
  /** Monotonic milliseconds, for measuring durations. Never for business dates. */
  elapsedMs(since: number): number;
  timestamp(): number;
}
