import { describe, expect, it, vi } from 'vitest';

import { SearchIndexConsumer } from './search-index.consumer';

/**
 * The coalescing contract: several changes to one document inside the debounce window become
 * one projection job (`12-search-architecture.md` §6). The mechanism is the deterministic job
 * id — document plus time bucket — so the dedup lives in the queue, and the delay pushes the
 * run past the window so it reads every change the window collected.
 */
describe('SearchIndexConsumer', () => {
  const config = {
    queue: { consumersEnabled: true },
    search: { debounceMs: 1_000 },
  } as never;

  function build(now: number): {
    consumer: SearchIndexConsumer;
    enqueued: { queue: string; jobId: string; delayMs?: number; payload: unknown }[];
    handler: () => (job: { jobId: string; attempt: number; payload: object }) => Promise<void>;
  } {
    const enqueued: { queue: string; jobId: string; delayMs?: number; payload: unknown }[] = [];
    let handle:
      ((job: { jobId: string; attempt: number; payload: object }) => Promise<void>) | null = null;
    const consumer = new SearchIndexConsumer(
      {
        subscribe: (_queue: string, handler: typeof handle) => {
          handle = handler;
          return Promise.resolve();
        },
      } as never,
      {
        enqueue: (queue: string, payload: object, options: { jobId: string; delayMs?: number }) => {
          enqueued.push({ queue, payload, ...options });
          return Promise.resolve({ queue, jobId: options.jobId, availableAt: new Date(now) });
        },
      } as never,
      { project: vi.fn(), remove: vi.fn() },
      { documentIdForRevision: vi.fn() } as never,
      config,
      { now: () => new Date(now) } as never,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { run: vi.fn() } as never,
    );
    return {
      consumer,
      enqueued,
      handler: () => {
        if (handle === null) {
          throw new Error('The consumer never subscribed.');
        }
        return handle;
      },
    };
  }

  const event = (eventType: string, documentId: string): object => ({
    eventId: 'row-1',
    tenantId: 'tenant-1',
    eventType,
    eventVersion: 1,
    payload: { documentId },
    correlationId: 'corr-1',
  });

  it('coalesces events for one document inside the window into one job id', async () => {
    const { consumer, enqueued, handler } = build(10_000);
    await consumer.onApplicationBootstrap();
    const handle = handler();

    await handle({ jobId: 'a', attempt: 1, payload: event('document.created', 'doc-1') });
    await handle({ jobId: 'b', attempt: 1, payload: event('revision.published', 'doc-1') });

    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]?.jobId).toBe(enqueued[1]?.jobId);
    expect(enqueued[0]?.jobId).toBe('search:project:doc-1:10');
    expect(enqueued[0]?.delayMs).toBe(1_000);
  });

  it('separates documents, and separates windows', async () => {
    const first = build(10_000);
    await first.consumer.onApplicationBootstrap();
    await first.handler()({ jobId: 'a', attempt: 1, payload: event('document.moved', 'doc-1') });
    await first.handler()({ jobId: 'b', attempt: 1, payload: event('document.moved', 'doc-2') });
    expect(new Set(first.enqueued.map((job) => job.jobId)).size).toBe(2);

    const later = build(11_000);
    await later.consumer.onApplicationBootstrap();
    await later.handler()({ jobId: 'c', attempt: 1, payload: event('document.moved', 'doc-1') });
    expect(later.enqueued[0]?.jobId).toBe('search:project:doc-1:11');
  });

  it('drops a malformed payload rather than retrying it', async () => {
    const { consumer, enqueued, handler } = build(10_000);
    await consumer.onApplicationBootstrap();
    await expect(
      handler()({ jobId: 'x', attempt: 1, payload: { eventType: 'document.created' } }),
    ).resolves.toBeUndefined();
    expect(enqueued).toHaveLength(0);
  });
});
