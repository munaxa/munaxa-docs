/**
 * Time, as a dependency.
 *
 * Retention dates, approval deadlines, escalation timers, token expiry and signed-URL
 * lifetimes are all arithmetic on "now". Injecting it makes every one of those rules
 * testable without waiting, and without a global mock that leaks between tests.
 */
export const CLOCK_PORT = Symbol('ClockPort');

export interface ClockPort {
  /** Wall-clock time. Everything a person or a record cares about comes from here. */
  now(): Date;
  /**
   * A **monotonic** reading, in milliseconds, for measuring durations.
   *
   * Not an epoch, not an integer, and not comparable to `now()`: it counts from an arbitrary
   * origin and is fractional. Use it only as a pair of readings subtracted from each other.
   * Anything that ends up in a record, an identifier or a response wants `now()`.
   */
  timestamp(): number;
  elapsedMs(since: number): number;
}
