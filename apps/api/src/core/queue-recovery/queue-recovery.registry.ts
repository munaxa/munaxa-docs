import { Injectable } from '@nestjs/common';

import type { QueueRecoveryParticipant } from '../../ports/queue.port';

/**
 * The modules whose durable rows are owed queue entries — RC validation, D-13.
 *
 * Core cannot import a module, and the recovery loop must not know what a workflow timer is, so a
 * module registers itself here at init, the way Document fills Library's `FolderContentsRegistry`.
 * One participant per kind of row, keyed by name so a module registering twice replaces itself.
 */
@Injectable()
export class QueueRecoveryRegistry {
  private readonly registered = new Map<string, QueueRecoveryParticipant>();

  register(participant: QueueRecoveryParticipant): void {
    this.registered.set(participant.name, participant);
  }

  participants(): readonly QueueRecoveryParticipant[] {
    return [...this.registered.values()];
  }
}
