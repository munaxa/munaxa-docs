/**
 * The queues, their retry policies, and what happens when a job finally fails.
 *
 * Lanes are separated by *cost*, not by module: OCR is slow and would otherwise starve
 * preview rendering behind it, and a retention run that takes an hour must not delay a
 * notification a user is waiting for (`docs/architecture/02-backend-architecture.md` §8).
 *
 * Failure policy, uniformly: exponential backoff, a capped number of attempts, then the dead
 * letter queue with an operator-visible reason. A job that fails permanently raises an alert
 * and never silently drops the work.
 */
export const QueueName = {
  DOCUMENTS_PREVIEW: 'documents.preview',
  DOCUMENTS_OCR: 'documents.ocr',
  SEARCH_INDEX: 'search.index',
  WORKFLOW_TIMERS: 'workflow.timers',
  NOTIFICATIONS_DELIVER: 'notifications.deliver',
  RETENTION_RUN: 'retention.run',
  AUDIT_EXPORT: 'audit.export',
  OUTBOX_DISPATCH: 'outbox.dispatch',
} as const;

export type QueueNameKey = (typeof QueueName)[keyof typeof QueueName];

export interface RetryPolicy {
  readonly attempts: number;
  readonly backoffMs: number;
  readonly backoff: 'exponential' | 'fixed';
}

export interface QueueDefinition {
  readonly name: QueueNameKey;
  /** How many jobs this lane runs at once. Bounded by what the work costs, not by hope. */
  readonly concurrency: number;
  readonly retry: RetryPolicy;
  /** Wall-clock budget for one job; a renderer that hangs must not hold a slot forever. */
  readonly timeoutMs: number;
  readonly description: string;
}

export const DEAD_LETTER_SUFFIX = '.dead' as const;

export function deadLetterQueueFor(queue: QueueNameKey): string {
  return `${queue}${DEAD_LETTER_SUFFIX}`;
}

export const QUEUES: readonly QueueDefinition[] = Object.freeze([
  {
    name: QueueName.OUTBOX_DISPATCH,
    concurrency: 1,
    retry: { attempts: 10, backoffMs: 1_000, backoff: 'exponential' },
    timeoutMs: 30_000,
    description:
      'Claims committed outbox rows and enqueues them. Single consumer per instance; rows are claimed FOR UPDATE SKIP LOCKED so instances never collide.',
  },
  {
    name: QueueName.DOCUMENTS_PREVIEW,
    concurrency: 4,
    retry: { attempts: 3, backoffMs: 5_000, backoff: 'exponential' },
    timeoutMs: 120_000,
    description: 'Renders preview pages and thumbnails in a sandbox with CPU and memory caps.',
  },
  {
    name: QueueName.DOCUMENTS_OCR,
    concurrency: 2,
    retry: { attempts: 2, backoffMs: 30_000, backoff: 'exponential' },
    timeoutMs: 600_000,
    description: 'The slow lane. Separate concurrency so OCR cannot starve preview rendering.',
  },
  {
    name: QueueName.SEARCH_INDEX,
    concurrency: 8,
    retry: { attempts: 5, backoffMs: 2_000, backoff: 'exponential' },
    timeoutMs: 60_000,
    description: 'Projects a document into the index. Coalesced per document; safe to re-run.',
  },
  {
    name: QueueName.WORKFLOW_TIMERS,
    concurrency: 4,
    retry: { attempts: 5, backoffMs: 10_000, backoff: 'exponential' },
    timeoutMs: 30_000,
    description:
      'Deadlines, reminders and escalations, as delayed jobs — which is why the engine needs no polling.',
  },
  {
    name: QueueName.NOTIFICATIONS_DELIVER,
    concurrency: 8,
    retry: { attempts: 5, backoffMs: 15_000, backoff: 'exponential' },
    timeoutMs: 30_000,
    description: 'Email and in-app fan-out. A permanent provider failure is not retried.',
  },
  {
    name: QueueName.RETENTION_RUN,
    concurrency: 1,
    retry: { attempts: 2, backoffMs: 60_000, backoff: 'fixed' },
    timeoutMs: 900_000,
    description:
      'Disposition review and purge, tenant-partitioned. Single consumer: destruction is never run concurrently with itself.',
  },
  {
    name: QueueName.AUDIT_EXPORT,
    concurrency: 2,
    retry: { attempts: 3, backoffMs: 30_000, backoff: 'exponential' },
    timeoutMs: 900_000,
    description: 'Evidence bundles, streamed to storage rather than held in memory.',
  },
]);

export function queueDefinition(name: QueueNameKey): QueueDefinition {
  const definition = QUEUES.find((queue) => queue.name === name);
  if (!definition) {
    throw new Error(`Queue ${name} has no definition.`);
  }
  return definition;
}

/**
 * Recurring work, expressed as data.
 *
 * Each entry is claimed under a distributed lock before it runs, so several worker instances
 * on the same schedule produce one run rather than three.
 */
export interface ScheduledJob {
  readonly name: string;
  readonly queue: QueueNameKey;
  readonly cron: string;
  readonly lockKey: string;
  readonly description: string;
}

export const SCHEDULE: readonly ScheduledJob[] = Object.freeze([
  {
    name: 'retention.sweep',
    queue: QueueName.RETENTION_RUN,
    cron: '0 2 * * *',
    lockKey: 'schedule:retention.sweep',
    description: 'Finds schedules due for review or disposition.',
  },
  {
    name: 'audit.verify-chain',
    queue: QueueName.AUDIT_EXPORT,
    cron: '30 1 * * *',
    lockKey: 'schedule:audit.verify-chain',
    description: 'Daily hash-chain verification; a break is the highest-severity alert.',
  },
  {
    name: 'storage.sweep-upload-sessions',
    queue: QueueName.RETENTION_RUN,
    cron: '*/15 * * * *',
    lockKey: 'schedule:storage.sweep-upload-sessions',
    description: 'Expires abandoned upload sessions and their partial objects.',
  },
]);
