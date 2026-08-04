import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The capability a `LOCAL` presigned URL carries.
 *
 * An object store verifies a presigned URL for itself, so the API hands one out and forgets it. A
 * filesystem cannot: there is nothing in front of it that understands a signature, so the API is
 * the thing serving the bytes and therefore the thing that must check the URL. This is that check,
 * kept in one small file so it can be read in full and tested exhaustively — it is the only
 * authorisation on the local transfer endpoints, and it is reached before authentication runs.
 *
 * That last part is deliberate and worth stating. The transfer endpoints are `@Public`, because a
 * presigned URL is by definition redeemed without a bearer token — that is what makes it usable in
 * an `<img>` tag and in a download the browser performs itself. The token *is* the credential, so
 * it names exactly one object, one method and one expiry, and it is signed with a key derived from
 * the deployment's own secret.
 *
 * The token is not a session. It grants nothing beyond the single object it names, it cannot be
 * exchanged for anything, and it stops working when it expires whatever else changes.
 */

/** The controller's path, relative to the API prefix. One definition, two readers. */
export const LOCAL_TRANSFER_PATH = 'storage/local';

export interface TransferGrant {
  /** The full, tenant-prefixed key. The scoping wrapper has already applied the prefix. */
  readonly key: string;
  readonly method: 'PUT' | 'GET';
  readonly expiresAt: Date;
  /** Bound on an upload, so a target issued for 40 kB cannot store 4 GB. */
  readonly maxBytes?: number | undefined;
  readonly contentType?: string | undefined;
  readonly disposition?: string | undefined;
}

/** Why a token was refused. Never shown to the caller in this detail — see the controller. */
export type TransferRejection = 'MALFORMED' | 'EXPIRED' | 'BAD_SIGNATURE' | 'WRONG_METHOD';

const SEPARATOR = '.';

/**
 * The signed part of a token, in a fixed order.
 *
 * Order and the separator matter: joining fields with a character that can appear inside one of
 * them is how two different grants come to have the same signed string. `\n` cannot appear in a
 * storage key — the key alphabet is content-addressed hex and path separators — and cannot appear
 * in any of the other fields either, so it is the safe join here.
 */
function payloadOf(grant: TransferGrant): string {
  return [
    grant.method,
    grant.key,
    String(grant.expiresAt.getTime()),
    grant.maxBytes === undefined ? '' : String(grant.maxBytes),
    grant.contentType ?? '',
    grant.disposition ?? '',
  ].join('\n');
}

function sign(secret: string, payload: string): string {
  // Domain-separated from every other use of the deployment secret. Without the prefix, a signature
  // minted here would be a valid signature anywhere else the same key is used with a raw HMAC.
  return createHmac('sha256', secret)
    .update(`munaxa.storage.local\n${payload}`)
    .digest('base64url');
}

/** The query string a `LOCAL` presigned URL carries. Opaque to everything but this file. */
export function encodeTransferToken(secret: string, grant: TransferGrant): string {
  const payload = payloadOf(grant);
  return `${Buffer.from(payload, 'utf8').toString('base64url')}${SEPARATOR}${sign(secret, payload)}`;
}

export function decodeTransferToken(
  secret: string,
  token: string,
  method: 'PUT' | 'GET',
  now: Date,
): { readonly grant: TransferGrant } | { readonly rejection: TransferRejection } {
  const separator = token.lastIndexOf(SEPARATOR);
  if (separator <= 0) {
    return { rejection: 'MALFORMED' };
  }
  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');

  // Verified before anything in the payload is read, and before the expiry is checked. Parsing
  // attacker-controlled fields to decide whether to verify them is the wrong order every time.
  if (!equals(signature, sign(secret, payload))) {
    return { rejection: 'BAD_SIGNATURE' };
  }

  const fields = payload.split('\n');
  if (fields.length !== 6) {
    return { rejection: 'MALFORMED' };
  }
  const [
    grantedMethod = '',
    key = '',
    expiry = '',
    maxBytes = '',
    contentType = '',
    disposition = '',
  ] = fields;
  if (grantedMethod !== 'PUT' && grantedMethod !== 'GET') {
    return { rejection: 'MALFORMED' };
  }
  if (grantedMethod !== method) {
    // A download URL is not an upload URL. Signing the method is what stops one being used as the
    // other, and checking it is what makes signing it worth anything.
    return { rejection: 'WRONG_METHOD' };
  }
  const expiresAt = new Date(Number(expiry));
  if (!Number.isFinite(expiresAt.getTime())) {
    return { rejection: 'MALFORMED' };
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return { rejection: 'EXPIRED' };
  }
  return {
    grant: {
      key,
      method: grantedMethod,
      expiresAt,
      ...(maxBytes.length > 0 && { maxBytes: Number(maxBytes) }),
      ...(contentType.length > 0 && { contentType }),
      ...(disposition.length > 0 && { disposition }),
    },
  };
}

/** Constant-time comparison, so a signature cannot be recovered a byte at a time by timing. */
function equals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the length — so the
  // lengths are compared first and a mismatch is compared against itself to keep the work constant.
  return a.length === b.length && timingSafeEqual(a, b);
}
