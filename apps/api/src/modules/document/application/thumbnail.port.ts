/**
 * The upload-time thumbnail.
 *
 * Phase 3 owns exactly this and no more: one small image, drawn once, when the content arrives.
 * Page images, PDF renditions, extracted text and the viewer that shows them are Phase 7's, and the
 * `PreviewArtifact` table is already the right shape for all of them.
 *
 * **It never fails a document.** That is the contract, and it is the only interesting thing about
 * this port. A thumbnail is a decoration: it makes a grid of documents legible and it carries no
 * information the document does not already have. A create that rolled back because a preview could
 * not be drawn would lose a document somebody uploaded, in order to protect a picture — so the
 * implementation swallows its own failures and the caller does not branch on the result.
 *
 * The absence of a thumbnail is therefore an ordinary state a client renders, not an error state.
 */
export const DOCUMENT_THUMBNAILER = Symbol('DocumentThumbnailer');

export interface DocumentThumbnailer {
  /**
   * Draws and stores a thumbnail for a revision, if the format allows one.
   *
   * Returns nothing, deliberately: there is no outcome the caller should act on. A format with no
   * renderer, a corrupt image and an unreachable store are all the same answer to the document use
   * case — carry on.
   */
  generate(revisionId: string, fileObjectId: string, mimeType: string): Promise<void>;
}
