import { Injectable } from '@nestjs/common';

/**
 * What a folder's delete does to the documents inside it, in Library's own vocabulary.
 *
 * Phase 2's folder delete cascaded over folders and stopped at the documents inside them — they
 * stayed live, reachable by search and by nothing else. ADR-0010 §3 says the cascade covers the
 * subtree, and Phase 10 makes it so: the same cascade identifier is stamped on the folders *and*
 * on the documents and revisions beneath them, so one restore reverses exactly one delete.
 *
 * The documents are Document's rows, so Document does the work. The seam is a **registry** rather
 * than an injected port, and the difference is worth stating because it is the one place in the
 * product where plain DI could not express the inversion. Document already imports Library — a
 * document sits in a folder — so Library cannot import Document's module to obtain a binding
 * without a cycle. The registry breaks it the way the preview renderer registry does: Library
 * declares the interface and holds the slot; Document, which imports Library anyway, fills the
 * slot at boot. The *call* still goes from Library's use case to Document's code inside one
 * transaction, which is what a soft delete that must be atomic with its subtree requires and what
 * an outbox event could not give it.
 */
export interface FolderContentsCascade {
  /**
   * Soft-deletes every live document in the folder and under its subtree path, stamped with the
   * cascade identifier, cascading each document's revisions and giving back their references.
   * Throws `LegalHoldError` when any document under the subtree is held — a hold blocks deletion
   * absolutely, and that includes the folder above the record (ADR-0010 §5).
   */
  deleteUnder(input: {
    readonly folderId: string;
    readonly path: string;
    readonly cascadeId: string;
  }): Promise<number>;
  /** Restores exactly the documents one cascade removed, with their revisions and references. */
  restoreCascade(cascadeId: string): Promise<number>;
}

/**
 * The slot. A singleton Library provides and exports; Document fills it at boot.
 *
 * Unfilled, it deletes nothing and says nothing — which is the honest behaviour for a composition
 * that genuinely has no documents, such as Library's own integration suite. The production
 * composition always fills it, and `DocumentModule`'s `onModuleInit` is where.
 */
@Injectable()
export class FolderContentsRegistry implements FolderContentsCascade {
  private participant: FolderContentsCascade | null = null;

  register(participant: FolderContentsCascade): void {
    this.participant = participant;
  }

  async deleteUnder(input: {
    readonly folderId: string;
    readonly path: string;
    readonly cascadeId: string;
  }): Promise<number> {
    return this.participant === null ? 0 : this.participant.deleteUnder(input);
  }

  async restoreCascade(cascadeId: string): Promise<number> {
    return this.participant === null ? 0 : this.participant.restoreCascade(cascadeId);
  }
}
