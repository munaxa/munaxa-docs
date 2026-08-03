import { describe, expect, it } from 'vitest';

import { QUEUES, QueueName, SCHEDULE, deadLetterQueueFor, queueDefinition } from './queues';

describe('queue definitions', () => {
  it('defines every queue exactly once', () => {
    const names = QUEUES.map((queue) => queue.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(new Set(Object.values(QueueName)));
  });

  it('gives every queue bounded retries and a timeout', () => {
    for (const queue of QUEUES) {
      expect(queue.retry.attempts).toBeGreaterThan(0);
      expect(queue.retry.attempts).toBeLessThanOrEqual(10);
      expect(queue.timeoutMs).toBeGreaterThan(0);
      expect(queue.concurrency).toBeGreaterThan(0);
    }
  });

  it('runs destructive and ordering-sensitive work single-file', () => {
    expect(queueDefinition(QueueName.RETENTION_RUN).concurrency).toBe(1);
    expect(queueDefinition(QueueName.OUTBOX_DISPATCH).concurrency).toBe(1);
  });

  it('names a dead letter queue for every lane', () => {
    for (const queue of QUEUES) {
      expect(deadLetterQueueFor(queue.name)).toBe(`${queue.name}.dead`);
    }
  });

  it('locks every scheduled job so instances do not run it several times', () => {
    for (const job of SCHEDULE) {
      expect(job.lockKey).toMatch(/^schedule:/);
      expect(QUEUES.some((queue) => queue.name === job.queue)).toBe(true);
    }
  });
});
