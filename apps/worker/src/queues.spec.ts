import { describe, expect, it } from 'vitest';

import * as domain from '@edms/domain';

import * as reexported from './queues';

/**
 * That the re-export is faithful.
 *
 * The queue catalogue moved to `@edms/domain` in Phase 4, when it acquired a second reader: the API
 * enqueues and this application consumes, and a name known to only one of them is a message nothing
 * receives. `queues.ts` here became a re-export so that every existing import kept working.
 *
 * A re-export can drift in one direction that nothing else would catch — a name added to the
 * catalogue and not re-exported here is a lane this application cannot subscribe to, and the
 * failure is a queue nobody consumes rather than a compile error. So this asserts the two sides
 * agree rather than testing the definitions themselves, which `@edms/domain`'s own suite does.
 */
describe('the queue catalogue', () => {
  it('re-exports every lane the shared catalogue defines', () => {
    expect(new Set(Object.values(reexported.QueueName))).toEqual(
      new Set(Object.values(domain.QueueName)),
    );
    expect(reexported.QUEUES).toBe(domain.QUEUES);
    expect(reexported.SCHEDULE).toBe(domain.SCHEDULE);
  });

  it('re-exports the helpers a consumer needs to configure itself', () => {
    expect(reexported.queueDefinition).toBe(domain.queueDefinition);
    expect(reexported.deadLetterQueueFor).toBe(domain.deadLetterQueueFor);
    expect(reexported.DEAD_LETTER_SUFFIX).toBe(domain.DEAD_LETTER_SUFFIX);
  });
});
