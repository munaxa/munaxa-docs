import { Inject, Injectable } from '@nestjs/common';

import type { AuditStreamSource, StreamSourceEvent } from '../../integration/application/ports';
import { AUDIT_REPOSITORY, type AuditRepository } from '../application/ports';

/**
 * The chain, as the SIEM sink reads it — Phase 13's shape, one more time.
 *
 * The Integration module declares `AUDIT_STREAM_SOURCE`; this module implements it, because this
 * module owns the table. That is the whole reason the adapter exists rather than the sink
 * injecting `AUDIT_REPOSITORY` directly: the repository is exported, so the shortcut would compile,
 * and it would give the integration module a handle that can `append` to the hash chain. A module
 * that can write the trail is a module that can be made to write a false one.
 *
 * It is `sliceBySequence` and nothing else — the **same** method the daily verifier and the
 * evidence exporter walk the chain with. One reader, three consumers, so a sink can never see a
 * different trail from the one a bundle attests. And it is deliberately not `search`: a stream is
 * a contiguous range by sequence, and an offset-paged search would give a different answer
 * depending on when it was asked, which is exactly the completeness guarantee a SIEM is here for.
 *
 * Not ACL-filtered, and that is 08 §10's decision rather than a gap here. The trail spans subjects,
 * so there is no single object to resolve; `audit:view` and `audit:export` are the tenant-wide
 * permissions that gate it, and the streaming routes carry the second.
 */
@Injectable()
export class AuditStreamSourceAdapter implements AuditStreamSource {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository) {}

  async sliceBySequence(
    afterSequence: bigint,
    limit: number,
  ): Promise<readonly StreamSourceEvent[]> {
    const slice = await this.repository.sliceBySequence(afterSequence, limit);
    return slice.events.map((event) => ({
      id: event.id,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      actorId: event.actorId,
      onBehalfOfId: event.onBehalfOfId,
      apiClientId: event.apiClientId,
      channel: event.channel,
      action: event.action,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      outcome: event.outcome,
      correlationId: event.correlationId,
      reason: event.reason,
      hash: event.hash,
      previousHash: event.previousHash,
      chainHashVersion: event.chainHashVersion,
      // `ipAddress` and `userAgent` are deliberately absent, exactly as they are from the audit
      // wire contract. A SIEM that wants them has the evidence bundle, which is the surface that
      // exists for an investigation; a continuous stream of every colleague's IP address into a
      // third-party system is a disclosure nobody asked for when they turned streaming on.
    }));
  }
}
