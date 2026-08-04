/**
 * Where a blob lives, derived from what it is.
 *
 * Content addressing is the whole of the deduplication story and half of the integrity one
 * ([ADR-0007](../../../../../../docs/architecture/adr/0007-storage-port-and-content-addressing.md)).
 * Two facts follow from it and nothing else has to be arranged for them:
 *
 * **Identical content is stored once per tenant.** Two people uploading the same standard form
 * compute the same digest and therefore the same key, so the second upload finds the first already
 * there.
 *
 * **A blob is never overwritten.** Different content is a different digest and therefore a
 * different key, which is what makes "the bytes an approver approved are unchanged" a thing that
 * can be proved rather than promised.
 *
 * The tenant's prefix is deliberately *not* here. It is added by the storage port, from the
 * tenant's placement, and a key that arrives already carrying one is refused — so a use case
 * cannot address another tenant's bytes even by constructing the string by hand
 * ([ADR-0015](../../../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 */

/** Where an original document's bytes go. */
const BLOB_ROOT = 'blobs';
/** Where rendered artefacts go — thumbnails now, page images and renditions in Phase 7. */
const DERIVED_ROOT = 'derived';

/**
 * `blobs/ab/cd/abcd…` — the digest, fanned out two levels.
 *
 * The fan-out is for the filesystem driver rather than for the object stores. S3 has not needed a
 * key prefix for throughput since 2018, but a directory holding a million files is still a
 * directory a single-server installation will be unhappy with. Two levels of two hex characters is
 * 65,536 buckets, which keeps any one of them at a few thousand entries for a tenant with hundreds
 * of millions of blobs.
 */
export function blobKeyFor(checksumSha256: string): string {
  const digest = requireDigest(checksumSha256);
  return `${BLOB_ROOT}/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
}

/**
 * Where a rendered artefact goes.
 *
 * Under its own root rather than beside the original, so that "everything derived" is a prefix
 * listing. Retention purges derived content with its source and a lifecycle rule tiers it
 * aggressively; both are prefix operations at every provider, and neither is expressible if
 * thumbnails are interleaved with the documents they were made from.
 */
export function derivedKeyFor(checksumSha256: string): string {
  const digest = requireDigest(checksumSha256);
  return `${DERIVED_ROOT}/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
}

/**
 * Where bytes are written while an upload is in flight.
 *
 * A staging key rather than the final one, because the final key *is* the digest and the digest is
 * not known until the bytes have arrived. Writing to the content key on the client's say-so would
 * mean trusting a checksum the client computed — and a client that computes it wrongly, or lies,
 * would overwrite the blob that legitimately holds that digest. Every later integrity check would
 * then report tampering on a document nobody touched.
 *
 * So the upload lands here, the store's own answer is read back, and the blob is moved to its
 * content key only once the digest is a fact.
 */
export function stagingKeyFor(uploadSessionId: string): string {
  return `staging/${uploadSessionId}`;
}

/** True for a key this product could have produced. Used when reading a key back from a row. */
export function isContentKey(key: string): boolean {
  return /^(?:blobs|derived)\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key);
}

function requireDigest(checksumSha256: string): string {
  const digest = checksumSha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    // Not a validation error to be reported to a user: nothing outside this system supplies a
    // digest, so reaching here means the product computed one wrongly, and a key built from a
    // malformed digest would address a location no integrity check could ever reconcile.
    throw new Error('A storage key can only be derived from a SHA-256 digest.');
  }
  return digest;
}
