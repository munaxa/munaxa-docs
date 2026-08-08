import { Inject, Injectable } from '@nestjs/common';

import type { DocumentExpiry, DocumentExpirySweep } from '../../retention/application/ports';
import { DOCUMENT_SERVICE, type DocumentService } from '../application/ports';

/**
 * `DOCUMENT_EXPIRY`, bound in the module that owns the lifecycle — Phase 6.1.
 *
 * The mirror of `RetentionDispositionAdapter` beside it: Retention declares the port, Document
 * implements it, and the dependency points the way that has no cycle in it. It is also the exact
 * shape `blob-reaper.adapter.ts` gives `IntegritySweep`, which is the precedent for a sweep that
 * runs on the `retention.run` lane and belongs to another module — the lane's consumer holds one
 * service, so a schedule that is not Retention's still arrives through Retention.
 *
 * Nothing is decided here. A one-method adapter with no logic is the correct amount of code for a
 * seam whose whole job is to let a lane reach a use case without one module importing another's
 * service.
 */
@Injectable()
export class DocumentExpiryAdapter implements DocumentExpiry {
  constructor(@Inject(DOCUMENT_SERVICE) private readonly documents: DocumentService) {}

  expireEffective(limit: number): Promise<DocumentExpirySweep> {
    return this.documents.expireEffective(limit);
  }
}
