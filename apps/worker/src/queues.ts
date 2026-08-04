/**
 * The queue catalogue, which now lives in `@edms/domain`.
 *
 * It moved in Phase 4, when it acquired a second reader: the API enqueues — the outbox dispatcher
 * routes a committed event to a lane, and the workflow engine schedules a delayed deadline job —
 * and this application consumes. A queue name known to only one side is a message nothing
 * receives, and an import across two applications is the coupling the boundary rules exist to
 * prevent. The definitions are pure data, so the shared package is where they belong.
 *
 * Re-exported rather than replaced, so every existing import here keeps working.
 */
export {
  DEAD_LETTER_SUFFIX,
  QUEUES,
  QueueName,
  SCHEDULE,
  deadLetterQueueFor,
  queueDefinition,
  type QueueDefinition,
  type QueueNameKey,
  type RetryPolicy,
  type ScheduledJob,
} from '@edms/domain';
