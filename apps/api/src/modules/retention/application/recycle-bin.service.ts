import { Inject, Injectable } from '@nestjs/common';

import type { Page } from '@edms/utils';

import { AdministeredWriter } from '../../../core/persistence';
import {
  type DeletedItem,
  RECYCLE_BIN_REPOSITORY,
  type RecycleBinRepository,
  type RecycleBinRequest,
  type RecycleBinService,
} from './ports';

/**
 * The recycle bin: one surface over everything this tenant has deleted and not yet disposed of.
 *
 * `16-frontend-architecture.md` §2 has named `recycle-bin/` as a top-level route since Phase 0,
 * and nothing rendered it — every administered list had its own three-way `deleted` filter, which
 * is the right shape for "show me the deleted document types" and the wrong shape for "what did we
 * delete last week". Those are different questions: the first is a mode of one list, the second
 * crosses every kind of thing that can be deleted, and answering it by opening sixteen screens in
 * turn is not answering it.
 *
 * **It restores nothing itself.** Every restore goes back through the module that owns the row —
 * Document revalidates that its folder is live and brings its revisions with it, Library reverses
 * exactly one cascade — and each writes its own audit event. A second restore implementation here
 * would be a second set of rules about uniqueness and parenthood, and the two would disagree the
 * first time one was corrected.
 *
 * **It lists documents and folders, and nothing else.** Administered configuration — a document
 * type, a category, a numbering rule — is deleted and restored on its own screen, where the person
 * who deleted it is already standing and where the dependent-count refusal lives. Aggregating
 * sixteen configuration lists into the bin would mean sixteen restore paths reachable from a
 * screen that shows none of their context, and a document controller looking for a lost drawing
 * would page past somebody's disabled metadata field to find it.
 *
 * **A legal hold does not block a restore, and that is a decision rather than an omission.**
 * ADR-0010 §5 blocks "disposition and deletion" absolutely, and a restore is neither — it is the
 * opposite of what a hold guards against, since putting the record back where the matter can read
 * it takes nothing away. What the hold does block is the *delete*, so a held record cannot enter
 * the bin at all, and the purge of one already in it when the hold was placed.
 */
@Injectable()
export class DefaultRecycleBinService implements RecycleBinService {
  constructor(
    @Inject(RECYCLE_BIN_REPOSITORY) private readonly bin: RecycleBinRepository,
    private readonly writer: AdministeredWriter,
  ) {}

  list(request: RecycleBinRequest): Promise<Page<DeletedItem>> {
    return this.writer.read(() => this.bin.list(request));
  }
}
