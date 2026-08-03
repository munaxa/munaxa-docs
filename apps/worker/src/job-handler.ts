import type { QueueNameKey } from './queues';

/**
 * What every job handler implements.
 *
 * A handler is a thin wrapper around a use case, and it is **idempotent on `jobId`**: delivery
 * is at least once, a retry after a timeout is normal, and a handler that assumes otherwise
 * produces duplicate notifications, duplicate index entries and — worst — duplicate side
 * effects on the document (`docs/architecture/02-backend-architecture.md` §6).
 */
export interface JobContext {
  readonly jobId: string;
  readonly queue: QueueNameKey;
  readonly attempt: number;
  readonly tenantId: string;
  readonly correlationId: string;
}

export interface JobHandler<TPayload extends object = object> {
  readonly queue: QueueNameKey;
  handle(payload: TPayload, context: JobContext): Promise<void>;
}

/**
 * Thrown by a handler that knows a retry is pointless — an unsupported format, a document
 * that no longer exists. It goes straight to the dead letter queue instead of consuming
 * five attempts to reach the same conclusion.
 */
export class PermanentJobFailure extends Error {
  constructor(
    readonly reason: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(reason);
    this.name = 'PermanentJobFailure';
  }
}
