/** Assertions for conditions a type cannot express and a caller must not violate. */

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AssertionError(message);
  }
}

export function assertDefined<T>(value: T | null | undefined, message: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new AssertionError(message);
  }
}

/**
 * Marks a branch the type system has proved unreachable. Adding a case to a union and
 * forgetting a `switch` then fails to compile instead of failing in production.
 */
export function assertNever(value: never, message = 'Unreachable case'): never {
  throw new AssertionError(`${message}: ${JSON.stringify(value)}`);
}
