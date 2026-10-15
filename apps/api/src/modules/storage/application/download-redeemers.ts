import type { DownloadLinkGrantOf, DownloadLinkKindKey } from '../domain/download-link-token';

/**
 * Who decides whether a verified download link may still be used — one redeemer per kind.
 *
 * The link format and the delivery are Storage's; what a link is *for* is not. A report export's
 * rules are Reporting's, an evidence bundle's are Audit's, a document's are Document's. So each
 * module registers the redeemer for its own kind when it starts, as it registers a bulk plan
 * (`BULK_PLAN_REGISTRY`), and the redemption route dispatches on the kind the token carries. A
 * kind nobody registered is refused, never handled by a neighbour's rules.
 *
 * A redeemer runs **inside the context of the person the link names**, already re-read from the
 * database (gone, disabled or a moved permission version refuse before any redeemer runs). It
 * asks its module's questions as of now — permission, ownership, state, the object's current file
 * and media type — and throws `NotFoundError` for anything that is not a yes, so that "revoked",
 * "not yours", "not finished" and "never existed" read alike.
 *
 * What it answers is only what `FILE_DOWNLOAD_SERVED` should carry to tie the bytes to the object
 * they were released as (an export id, an operation id) — never a decision that was not made here.
 */
export const DOWNLOAD_REDEEMERS = Symbol('DownloadRedeemers');

export interface RedeemedDownload {
  /** Correlation fields recorded on `FILE_DOWNLOAD_SERVED`, e.g. `{ reportExportId }`. */
  readonly audit: Readonly<Record<string, string>>;
}

export interface DownloadRedeemer<K extends DownloadLinkKindKey = DownloadLinkKindKey> {
  readonly kind: K;
  redeem(grant: DownloadLinkGrantOf<K>): Promise<RedeemedDownload>;
}

export class DownloadRedeemerRegistry {
  private readonly redeemers = new Map<DownloadLinkKindKey, DownloadRedeemer>();

  register<K extends DownloadLinkKindKey>(redeemer: DownloadRedeemer<K>): void {
    if (this.redeemers.has(redeemer.kind)) {
      // Two modules claiming one kind is a wiring defect, and the second must not silently win.
      throw new Error(`A download redeemer for ${redeemer.kind} is already registered.`);
    }
    this.redeemers.set(redeemer.kind, redeemer as unknown as DownloadRedeemer);
  }

  /** The redeemer for a kind, or null when no module registered one. */
  for<K extends DownloadLinkKindKey>(kind: K): DownloadRedeemer<K> | null {
    return (this.redeemers.get(kind) as DownloadRedeemer<K> | undefined) ?? null;
  }
}
